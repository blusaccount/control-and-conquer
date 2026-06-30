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

/** The minimal read shape the conflict engine needs: "are A and B allied?". */
export interface AllianceView {
  areAllied(a: PlayerId, b: PlayerId): boolean;
}

/** A null alliance layer — nobody is ever allied. The engine's default. */
export const NO_ALLIANCES: AllianceView = { areAllied: () => false };

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
  propose(from: PlayerId, to: PlayerId): ProposeResult {
    if (from === to || !this.isRealPlayer(from) || !this.isRealPlayer(to)) return "invalid";
    if (this.areAllied(from, to)) return "already-allied";
    // A crossing offer (they already proposed to us) seals the pact immediately.
    if (this.hasProposal(to, from)) {
      this.clearProposal(to, from);
      this.clearProposal(from, to);
      this.bindAlliance(from, to);
      return "accepted";
    }
    if (this.hasProposal(from, to)) return "already-proposed";
    this.addOutgoing(from, to);
    return "proposed";
  }

  /**
   * `by` accepts a pending proposal from `from`, forming the alliance. Returns
   * whether a matching pending proposal existed (and the pact was formed).
   */
  accept(by: PlayerId, from: PlayerId): boolean {
    if (!this.hasProposal(from, by)) return false;
    this.clearProposal(from, by);
    this.clearProposal(by, from); // tidy any crossing offer too
    this.bindAlliance(by, from);
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

  /** Dissolve the alliance between `a` and `b`. Returns whether one existed. */
  breakAlliance(a: PlayerId, b: PlayerId): boolean {
    if (!this.areAllied(a, b)) return false;
    this.allies.get(a)?.delete(b);
    this.allies.get(b)?.delete(a);
    return true;
  }

  /**
   * Drop `id` from the diplomacy graph entirely — every alliance it held and
   * every proposal to or from it. Called when a nation is eliminated so the dead
   * leave no dangling pacts.
   */
  removePlayer(id: PlayerId): void {
    for (const ally of this.allies.get(id) ?? []) this.allies.get(ally)?.delete(id);
    this.allies.delete(id);
    this.outgoing.delete(id);
    for (const targets of this.outgoing.values()) targets.delete(id);
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

  private bindAlliance(a: PlayerId, b: PlayerId): void {
    this.adjacency(this.allies, a).add(b);
    this.adjacency(this.allies, b).add(a);
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
