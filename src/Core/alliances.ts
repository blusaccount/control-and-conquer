// ---------------------------------------------------------------------------
// Diplomacy: alliances + pending alliance proposals.
//
// A thin, framework-free relationship layer over the player ids. It holds two
// kinds of state:
//   - **Alliances** — symmetric, mutual-consent pacts. While two players are
//     allied neither can attack the other (the conflict engine blocks it).
//   - **Proposals** — directed, pending offers (`from` → `to`) awaiting the
//     recipient's accept/decline. Proposing to someone who already proposed to
//     you accepts immediately (the two offers meet in the middle).
//
// Like the rest of `Core`, this is deterministic and self-contained: no RNG, no
// `Date.now`, ascending-id iteration order — so replays stay identical. The
// {@link RasterConflict} consults {@link AllianceView.areAllied} to refuse an
// attack between allies; {@link RasterGameSession} drives the propose/respond
// protocol and serialises the state into each snapshot.
// ---------------------------------------------------------------------------

import { NEUTRAL_PLAYER, type PlayerId } from "./TerritoryGrid.js";

/**
 * How long a freshly-formed (or renewed) alliance lasts, in ticks — 5 minutes
 * at 10 TPS, mirroring OpenFront's alliance duration (community wiki, 2026-07;
 * the value has shifted between OpenFront versions, so it lives here as one
 * constant). Expiry is *natural*: the pact simply lapses, with no traitor mark
 * for either side — betrayal is only an explicit {@link AllianceRegistry.breakAlliance}.
 */
export const ALLIANCE_DURATION_TICKS = 3000;

/**
 * The renewal window: within this many ticks of a pact's expiry (~30 s), the
 * client surfaces a "renew?" prompt and bots consider their vote, mirroring
 * OpenFront's renewal prompt shortly before an alliance lapses. Votes are
 * *accepted* at any time while allied (simpler and still deterministic); the
 * window only gates when the prompt is shown and when bots bother voting.
 */
export const ALLIANCE_RENEWAL_WINDOW_TICKS = 300;

/**
 * The minimal read shape the conflict/trade engine needs: "are A and B
 * allied?" and "is trade between A and B embargoed?" (either direction). Both
 * are read-only projections of the diplomacy graph, injected into the
 * deterministic engine so it never depends on the session.
 */
export interface AllianceView {
  areAllied(a: PlayerId, b: PlayerId): boolean;
  /** True if either side has an active trade embargo against the other. Optional (defaults false). */
  isEmbargoed?(a: PlayerId, b: PlayerId): boolean;
}

/** A null alliance layer — nobody is ever allied or embargoed. The engine's default. */
export const NO_ALLIANCES: AllianceView = { areAllied: () => false, isEmbargoed: () => false };

/** A directed target request: `from` asks its ally `to` to attack `target`. */
export interface TargetRequest {
  from: PlayerId;
  to: PlayerId;
  target: PlayerId;
}

/** Outcome of an {@link AllianceRegistry.voteRenew} call. */
export type RenewResult =
  /** Both sides have now voted — the pact's clock restarted. */
  | "renewed"
  /** The vote is recorded; the partner's is still outstanding. */
  | "voted"
  /** The voter had already voted (a duplicate) — nothing to do. */
  | "already-voted"
  /** The two are not allied (or an invalid id). */
  | "invalid";

/** Per-pact bookkeeping: when it lapses and who has voted to renew it. */
interface PactState {
  /** Tick at which the pact expires unless renewed. */
  expiresAt: number;
  /** Players who have voted to renew; renewal fires when both sides have. */
  readonly renewVotes: Set<PlayerId>;
}

/** Outcome of an {@link AllianceRegistry.propose} call. */
export type ProposeResult =
  /** The proposal was recorded and now awaits the recipient's response. */
  | "proposed"
  /** The recipient had already proposed to the proposer, so the pact formed. */
  | "accepted"
  /** The two are already allied — nothing to do. */
  | "already-allied"
  /** The proposal already stood (a duplicate offer) — nothing to do. */
  | "already-proposed"
  /** Self-proposal or a neutral/invalid id. */
  | "invalid";

/**
 * Symmetric alliances plus directed pending proposals between players.
 *
 * Alliances are stored as an adjacency map (`allies`) so "who is `id` allied
 * with?" and "are A and B allied?" are O(1); proposals are stored directed
 * (`outgoing[from]` is the set of players `from` has offered a pact). Only real
 * player ids (>= 1) ever participate — the neutral id is rejected outright.
 */
export class AllianceRegistry implements AllianceView {
  /** `allies.get(a)` = the set of players currently allied with `a` (symmetric). */
  private readonly allies = new Map<PlayerId, Set<PlayerId>>();
  /** `outgoing.get(from)` = the set of players `from` has a pending offer out to. */
  private readonly outgoing = new Map<PlayerId, Set<PlayerId>>();
  /** Per-pact expiry/renewal state, keyed by the canonical `"lo:hi"` pair. */
  private readonly pacts = new Map<string, PactState>();
  /** How many alliances each player has *betrayed* (explicit breaks, ever). */
  private readonly betrayals = new Map<PlayerId, number>();
  /** `embargoes.get(from)` = the set of players `from` refuses to trade with (directed). */
  private readonly embargoes = new Map<PlayerId, Set<PlayerId>>();
  /** Directed, pending "attack them for me" requests between allies. */
  private targetRequests: TargetRequest[] = [];

  private pactKey(a: PlayerId, b: PlayerId): string {
    return `${Math.min(a, b)}:${Math.max(a, b)}`;
  }

  /** True only for two distinct real players bound by an active alliance. */
  areAllied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return false;
    return this.allies.get(a)?.has(b) ?? false;
  }

  /** Players currently allied with `id`, in ascending id order. */
  alliesOf(id: PlayerId): PlayerId[] {
    return [...(this.allies.get(id) ?? [])].sort((x, y) => x - y);
  }

  /** True if `from` has a pending (unanswered) proposal out to `to`. */
  hasProposal(from: PlayerId, to: PlayerId): boolean {
    return this.outgoing.get(from)?.has(to) ?? false;
  }

  /** Players who have proposed an alliance to `id` (incoming offers), ascending. */
  incomingProposals(id: PlayerId): PlayerId[] {
    const found: PlayerId[] = [];
    for (const [from, targets] of this.outgoing) {
      if (targets.has(id)) found.push(from);
    }
    return found.sort((x, y) => x - y);
  }

  /** Players `id` has proposed an alliance to (outgoing offers), ascending. */
  outgoingProposals(id: PlayerId): PlayerId[] {
    return [...(this.outgoing.get(id) ?? [])].sort((x, y) => x - y);
  }

  private isRealPlayer(id: PlayerId): boolean {
    return Number.isInteger(id) && id > NEUTRAL_PLAYER;
  }

  /**
   * Offer an alliance from `from` to `to`. If `to` had already proposed to
   * `from`, the two offers meet and the alliance forms at once (`"accepted"`);
   * otherwise the offer is parked pending the recipient's response
   * (`"proposed"`). Already-allied and duplicate offers are no-ops.
   */
  propose(from: PlayerId, to: PlayerId, now = 0): ProposeResult {
    if (from === to || !this.isRealPlayer(from) || !this.isRealPlayer(to)) return "invalid";
    if (this.areAllied(from, to)) return "already-allied";
    // A crossing offer (they already proposed to us) seals the pact immediately.
    if (this.hasProposal(to, from)) {
      this.clearProposal(to, from);
      this.clearProposal(from, to);
      this.bindAlliance(from, to, now);
      return "accepted";
    }
    if (this.hasProposal(from, to)) return "already-proposed";
    this.addOutgoing(from, to);
    return "proposed";
  }

  /**
   * `by` accepts a pending proposal from `from`, forming the alliance (its
   * clock starts at `now`). Returns whether a matching pending proposal
   * existed (and the pact was formed).
   */
  accept(by: PlayerId, from: PlayerId, now = 0): boolean {
    if (!this.hasProposal(from, by)) return false;
    this.clearProposal(from, by);
    this.clearProposal(by, from); // tidy any crossing offer too
    this.bindAlliance(by, from, now);
    return true;
  }

  /**
   * `by` declines a pending proposal from `from` (or `from` withdraws its own
   * offer to `by`). Returns whether a proposal was cleared.
   */
  decline(by: PlayerId, from: PlayerId): boolean {
    return this.clearProposal(from, by);
  }

  /** Cancel `from`'s own outgoing proposal to `to`. Returns whether one existed. */
  cancel(from: PlayerId, to: PlayerId): boolean {
    return this.clearProposal(from, to);
  }

  /**
   * `breaker` dissolves its alliance with `partner` — an explicit **betrayal**,
   * counted against the breaker's permanent reputation (see {@link betrayalsOf}).
   * Natural expiry goes through {@link expireDue} instead and counts nothing.
   * Returns whether a pact existed.
   */
  breakAlliance(breaker: PlayerId, partner: PlayerId): boolean {
    if (!this.dissolve(breaker, partner)) return false;
    this.betrayals.set(breaker, this.betrayalsOf(breaker) + 1);
    // Betrayal auto-embargoes the wronged partner (OpenFront): the breaker
    // stops trading with the ally it just stabbed.
    this.setEmbargo(breaker, partner);
    return true;
  }

  // --- Trade embargoes -------------------------------------------------------

  /** `from` stops trading with `to`. No-op on invalid/self ids. Returns whether it changed. */
  setEmbargo(from: PlayerId, to: PlayerId): boolean {
    if (from === to || !this.isRealPlayer(from) || !this.isRealPlayer(to)) return false;
    const set = this.adjacency(this.embargoes, from);
    if (set.has(to)) return false;
    set.add(to);
    return true;
  }

  /** Lift `from`'s embargo on `to`. Returns whether one existed. */
  clearEmbargo(from: PlayerId, to: PlayerId): boolean {
    return this.embargoes.get(from)?.delete(to) ?? false;
  }

  /** True if `from` currently embargoes `to` (directed). */
  hasEmbargo(from: PlayerId, to: PlayerId): boolean {
    return this.embargoes.get(from)?.has(to) ?? false;
  }

  /**
   * True if trade between `a` and `b` is blocked — by an embargo in **either**
   * direction. Trade needs both ends willing, so one side's embargo stops the
   * route. This is the {@link AllianceView} projection the trade system reads.
   */
  isEmbargoed(a: PlayerId, b: PlayerId): boolean {
    return this.hasEmbargo(a, b) || this.hasEmbargo(b, a);
  }

  /** Players `id` currently embargoes (directed, ascending). */
  embargoesOf(id: PlayerId): PlayerId[] {
    return [...(this.embargoes.get(id) ?? [])].sort((x, y) => x - y);
  }

  /** Every active embargo as a directed `[from, to]` pair, canonical order — for the snapshot. */
  allEmbargoes(): Array<[PlayerId, PlayerId]> {
    const out: Array<[PlayerId, PlayerId]> = [];
    for (const [from, targets] of this.embargoes) {
      for (const to of targets) out.push([from, to]);
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }

  // --- Target requests ("attack them for me") --------------------------------

  /**
   * `from` asks its ally `to` to attack `target`. Recorded only between current
   * allies and against a real third party; a duplicate is a no-op. Returns
   * whether a fresh request was stored.
   */
  requestTarget(from: PlayerId, to: PlayerId, target: PlayerId): boolean {
    if (!this.areAllied(from, to)) return false;
    if (!this.isRealPlayer(target) || target === from || target === to) return false;
    if (this.targetRequests.some((r) => r.from === from && r.to === to && r.target === target)) return false;
    this.targetRequests.push({ from, to, target });
    return true;
  }

  /** Standing target requests addressed to `to` (ascending by requester, then target). */
  targetRequestsFor(to: PlayerId): TargetRequest[] {
    return this.targetRequests
      .filter((r) => r.to === to)
      .sort((p, q) => p.from - q.from || p.target - q.target);
  }

  /** Every standing target request, canonical order — for the snapshot. */
  allTargetRequests(): TargetRequest[] {
    return [...this.targetRequests].sort((p, q) => p.from - q.from || p.to - q.to || p.target - q.target);
  }

  /** How many alliances `id` has betrayed (explicitly broken), ever. */
  betrayalsOf(id: PlayerId): number {
    return this.betrayals.get(id) ?? 0;
  }

  /**
   * Record `voter`'s wish to renew its pact with `partner`. When both sides
   * have voted, the pact's clock restarts at `now` (+{@link ALLIANCE_DURATION_TICKS})
   * and the votes clear. Votes may be cast at any point in the pact's life;
   * the client/bots only *prompt* inside {@link ALLIANCE_RENEWAL_WINDOW_TICKS}.
   */
  voteRenew(voter: PlayerId, partner: PlayerId, now: number): RenewResult {
    if (!this.areAllied(voter, partner)) return "invalid";
    const pact = this.pacts.get(this.pactKey(voter, partner));
    if (!pact) return "invalid";
    if (pact.renewVotes.has(voter)) return "already-voted";
    pact.renewVotes.add(voter);
    if (pact.renewVotes.has(partner)) {
      pact.expiresAt = now + ALLIANCE_DURATION_TICKS;
      pact.renewVotes.clear();
      return "renewed";
    }
    return "voted";
  }

  /** True if `voter` has an outstanding renewal vote on its pact with `partner`. */
  hasRenewVote(voter: PlayerId, partner: PlayerId): boolean {
    return this.pacts.get(this.pactKey(voter, partner))?.renewVotes.has(voter) ?? false;
  }

  /** Ticks until the pact between `a` and `b` lapses, or `null` if not allied. */
  ticksLeft(a: PlayerId, b: PlayerId, now: number): number | null {
    const pact = this.pacts.get(this.pactKey(a, b));
    if (!pact || !this.areAllied(a, b)) return null;
    return Math.max(0, pact.expiresAt - now);
  }

  /**
   * Lapse every pact whose time is up at `now`, returning the dissolved pairs
   * (canonical `[lo, hi]`, ascending) so the caller can announce them. Natural
   * expiry is **not** betrayal: no traitor mark, no reputation hit.
   */
  expireDue(now: number): Array<[PlayerId, PlayerId]> {
    const lapsed: Array<[PlayerId, PlayerId]> = [];
    for (const [key, pact] of this.pacts) {
      if (pact.expiresAt > now) continue;
      const [lo, hi] = key.split(":").map(Number);
      lapsed.push([lo, hi]);
    }
    lapsed.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [lo, hi] of lapsed) this.dissolve(lo, hi);
    return lapsed;
  }

  /** Remove the pact between `a` and `b` (adjacency + metadata), if any. */
  private dissolve(a: PlayerId, b: PlayerId): boolean {
    if (!this.areAllied(a, b)) return false;
    this.allies.get(a)?.delete(b);
    this.allies.get(b)?.delete(a);
    this.pacts.delete(this.pactKey(a, b));
    // A target request only makes sense between standing allies; once the pact
    // is gone (broken or expired), drop any request in either direction.
    this.targetRequests = this.targetRequests.filter(
      (r) => !((r.from === a && r.to === b) || (r.from === b && r.to === a)),
    );
    return true;
  }

  /**
   * Drop `id` from the diplomacy graph entirely — every alliance it held and
   * every proposal to or from it. Called when a nation is eliminated so the dead
   * leave no dangling pacts.
   */
  removePlayer(id: PlayerId): void {
    for (const ally of this.allies.get(id) ?? []) {
      this.allies.get(ally)?.delete(id);
      this.pacts.delete(this.pactKey(id, ally));
    }
    this.allies.delete(id);
    this.outgoing.delete(id);
    this.betrayals.delete(id);
    this.embargoes.delete(id);
    for (const targets of this.outgoing.values()) targets.delete(id);
    for (const targets of this.embargoes.values()) targets.delete(id);
    // Drop any target request touching the departed player (as requester,
    // recipient or the named target).
    this.targetRequests = this.targetRequests.filter((r) => r.from !== id && r.to !== id && r.target !== id);
  }

  /**
   * Every active alliance as a canonical `[lowId, highId]` pair, in ascending
   * order — a stable, dedup'd list for the snapshot.
   */
  pairs(): Array<[PlayerId, PlayerId]> {
    const seen = new Set<string>();
    const out: Array<[PlayerId, PlayerId]> = [];
    for (const [a, partners] of this.allies) {
      for (const b of partners) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = `${lo}:${hi}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([lo, hi]);
      }
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  }

  /**
   * Every pending proposal as a directed `{ from, to }` record, in ascending
   * (from, to) order — for the snapshot so each client can render its incoming
   * and outgoing offers.
   */
  proposals(): Array<{ from: PlayerId; to: PlayerId }> {
    const out: Array<{ from: PlayerId; to: PlayerId }> = [];
    for (const [from, targets] of this.outgoing) {
      for (const to of targets) out.push({ from, to });
    }
    return out.sort((p, q) => p.from - q.from || p.to - q.to);
  }

  /**
   * Every active alliance with its remaining lifetime and standing renewal
   * votes, in canonical ascending order — the snapshot's richer companion to
   * {@link pairs} so clients can render countdowns and renewal prompts.
   */
  infos(now: number): Array<{ a: PlayerId; b: PlayerId; ticksLeft: number; renewVotes: PlayerId[] }> {
    return this.pairs().map(([a, b]) => {
      const pact = this.pacts.get(this.pactKey(a, b));
      return {
        a,
        b,
        ticksLeft: pact ? Math.max(0, pact.expiresAt - now) : 0,
        renewVotes: pact ? [...pact.renewVotes].sort((x, y) => x - y) : [],
      };
    });
  }

  private bindAlliance(a: PlayerId, b: PlayerId, now: number): void {
    this.adjacency(this.allies, a).add(b);
    this.adjacency(this.allies, b).add(a);
    this.pacts.set(this.pactKey(a, b), { expiresAt: now + ALLIANCE_DURATION_TICKS, renewVotes: new Set() });
  }

  private addOutgoing(from: PlayerId, to: PlayerId): void {
    this.adjacency(this.outgoing, from).add(to);
  }

  private clearProposal(from: PlayerId, to: PlayerId): boolean {
    return this.outgoing.get(from)?.delete(to) ?? false;
  }

  private adjacency(map: Map<PlayerId, Set<PlayerId>>, id: PlayerId): Set<PlayerId> {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    return set;
  }
}
