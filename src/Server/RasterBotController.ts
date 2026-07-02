import type { RasterGameSession } from "./RasterGameSession.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "../Core/TerritoryGrid.js";
import { maxTroops } from "../Core/rasterCombatConfig.js";
import { buildingCost } from "../Core/buildings.js";
import type { RasterServerMessage, RasterSnapshot } from "../Core/types.js";
import type { RasterPlayerKind } from "./botField.js";

/**
 * Behavioural knobs for a raster bot. A {@link RasterBotController}'s whole
 * personality lives here, so seating a varied field of opponents is just a
 * matter of handing each controller a different preset — no subclassing.
 *
 * Everything is deterministic: identical (terrain, intents) replays produce
 * identical games, matching the engine's no-`Math.random`/no-`Date.now`
 * guarantee. Variety between bots comes from these static numbers, not RNG.
 */
export interface RasterBotPersonality {
  /** Stable id used for logging and to seat a recognisable mix of opponents. */
  readonly id: string;
  /** Ticks between decisions. Lower = reacts faster and pushes more fronts. */
  readonly decisionCooldownTicks: number;
  /** The bot sits idle (banking income) until its pool reaches this. */
  readonly minPool: number;
  /** Fraction of the pool held back rather than committed, so the bot can keep
   * opening fresh fronts instead of locking everything into one push (0..1). */
  readonly reserveFraction: number;
  /** Fraction of the *available* (non-reserve) pool committed to a neutral grab. */
  readonly expandCommit: number;
  /** Fraction of the available pool committed to an attack on an enemy. */
  readonly attackCommit: number;
  /** Only attack an enemy when `myPool >= theirPool * this`. Lower = braver. */
  readonly attackPoolRatio: number;
  /** Tendency to strike a beatable enemy even while neutral land remains (0..1).
   * At >= 0.5 the bot opens a war the moment it holds a decisive edge. */
  readonly aggression: number;
}

/**
 * A spread of opponent archetypes. {@link MatchRegistry} hands these out in
 * order so a solo match fields a recognisable mix — a land-grabber, a warmonger,
 * a measured all-rounder, an opportunist and a turtle — rather than five clones.
 */
export const RASTER_BOT_PERSONALITIES: readonly RasterBotPersonality[] = [
  // Expander: races for neutral land to compound income, fights only when boxed in.
  { id: "expander", decisionCooldownTicks: 12, minPool: 5, reserveFraction: 0.15, expandCommit: 0.85, attackCommit: 0.6, attackPoolRatio: 1.5, aggression: 0.2 },
  // Aggressor: hunts the weakest neighbour early and commits hard to the kill.
  { id: "aggressor", decisionCooldownTicks: 10, minPool: 5, reserveFraction: 0.2, expandCommit: 0.7, attackCommit: 0.85, attackPoolRatio: 1.0, aggression: 0.9 },
  // Balanced: grabs land first, then turns on a clearly weaker rival.
  { id: "balanced", decisionCooldownTicks: 14, minPool: 8, reserveFraction: 0.25, expandCommit: 0.75, attackCommit: 0.65, attackPoolRatio: 1.25, aggression: 0.5 },
  // Opportunist: expands patiently but pounces on a lopsided advantage.
  { id: "opportunist", decisionCooldownTicks: 12, minPool: 6, reserveFraction: 0.3, expandCommit: 0.8, attackCommit: 0.7, attackPoolRatio: 1.4, aggression: 0.6 },
  // Turtle: banks a deep reserve, expands cautiously, rarely starts a war.
  { id: "turtle", decisionCooldownTicks: 18, minPool: 12, reserveFraction: 0.4, expandCommit: 0.7, attackCommit: 0.55, attackPoolRatio: 1.8, aggression: 0.15 },
];

/**
 * The passive **Bot** ("Tribe") personality: OpenFront's low-threat map
 * filler. It reacts slowly, commits only a sliver of its pool per attack
 * (mirroring OpenFront's `attackAmount` for `PlayerType.Bot`, `troops/20` —
 * a fifth of a Nation's `troops/5`), and almost never picks a fight it isn't
 * heavily favoured to win. Paired with `kind: "bot"` (see
 * {@link RasterBotConfig.kind}), which additionally skips building and
 * always accepts alliance offers rather than weighing them — see
 * {@link RasterBotController.maybeBuild}/{@link RasterBotController.manageDiplomacy}.
 */
export const FILLER_PERSONALITY: RasterBotPersonality = {
  id: "filler",
  decisionCooldownTicks: 60,
  minPool: 20,
  reserveFraction: 0.6,
  expandCommit: 0.25,
  attackCommit: 0.05,
  attackPoolRatio: 2.5,
  aggression: 0.05,
};

export interface RasterBotConfig {
  readonly botId: string;
  readonly personality: RasterBotPersonality;
  /**
   * Which AI tier this seat plays as — a full-strategy **Nation** (the
   * default; OpenFront-style difficulty handicaps, builds/allies/expands) or
   * a passive **Bot** filler (flat handicap, no building, always-accept
   * diplomacy). See {@link RasterPlayerKind}.
   */
  readonly kind?: RasterPlayerKind;
}

export const DEFAULT_RASTER_BOT_CONFIG: RasterBotConfig = {
  botId: "raster-bot-1",
  // Default to the all-rounder so a lone bot plays a sensible, readable game.
  personality: RASTER_BOT_PERSONALITIES[2],
  kind: "nation",
};

/**
 * Server-side AI opponent for raster (openfront-style) matches.
 *
 * Subscribes to a {@link RasterGameSession} exactly like a human client and
 * pushes its moves back through the same `queueExpand` channel — so every bot
 * action runs through the identical server-side validation a player's clicks do,
 * and the bot can never reach into engine state it shouldn't.
 *
 * It does, however, read decision inputs straight off the session's authoritative
 * grid (`peekGrid`) rather than re-decoding the wire snapshot. That state is the
 * same data the snapshot already carries to every client — each player's exact
 * troop pool and tile count is public — so the bot gains no hidden information;
 * it simply skips a redundant base64 decode. Crucially, reading the grid lets the
 * bot consult **water-component reachability**, so it can plan amphibious boat
 * assaults onto coasts across the sea instead of stranding itself on its home
 * landmass (the old land-only frontier scan's fatal flaw on water-heavy maps).
 *
 * ## Strategy
 * Every `decisionCooldownTicks`, once it has banked `minPool` troops, the bot:
 *  1. Enumerates the owners its border touches — neutral land and each rival —
 *     via {@link TerritoryGrid.frontierTargets} (land borders plus boat targets).
 *  2. Finds the weakest rival it can currently beat on troops
 *     (`myPool >= theirPool * attackPoolRatio`).
 *  3. Picks a move by personality:
 *       - **Attack** that rival when boxed in (no neutral land left) or when
 *         aggressive *and* holding a decisive edge.
 *       - Otherwise **expand** into neutral land — cheap tiles that compound into
 *         more income, the dominant early-game play.
 *       - If only stronger rivals border it and its pool is saturating (income
 *         would be wasted), it spends down on the least-strong neighbour rather
 *         than stagnate; otherwise it banks troops and waits.
 *  4. Commits a personality-scaled slice of its pool toward a deterministic
 *     sample tile of the chosen target (lowest `TileRef`), keeping a reserve.
 *
 * Deterministic throughout: no RNG, ties broken by ascending id / `TileRef`.
 */
export class RasterBotController {
  private myPlayerId: PlayerId | null = null;
  private lastDecisionTick = Number.NEGATIVE_INFINITY;
  private session: RasterGameSession | null = null;

  /**
   * The bot reinvests in a city once it holds at least this much land — early
   * game it pours everything into expansion; a maturing empire banks gold into
   * structures that compound its economy.
   */
  private static readonly MIN_TILES_TO_BUILD = 8;

  public constructor(private readonly config: RasterBotConfig = DEFAULT_RASTER_BOT_CONFIG) {}

  public attach(session: RasterGameSession): () => void {
    this.session = session;
    // Subscribe headless (wantsRaster=false): the bot reads engine state via
    // peekGrid and never decodes the wire ownership, so the session skips the
    // costly per-tick owner encoding for it.
    // kind (default "nation") so the session applies the right AI handicap
    // tier and the full conquer bounty when this seat is beaten.
    const unsubscribe = session.subscribe(
      this.config.botId,
      (message) => this.onMessage(message),
      true,
      false,
      undefined,
      this.config.kind ?? "nation",
    );
    if (!unsubscribe) {
      // The session is already full (e.g. exhausted MAX_PLAYERS seats) — this
      // bot simply never takes the field rather than crashing the caller.
      this.session = null;
      return () => {};
    }
    return () => {
      this.session = null;
      this.myPlayerId = null;
      this.lastDecisionTick = Number.NEGATIVE_INFINITY;
      unsubscribe();
    };
  }

  public getPlayerId(): PlayerId | null {
    return this.myPlayerId;
  }

  public getBotId(): string {
    return this.config.botId;
  }

  public getPersonality(): RasterBotPersonality {
    return this.config.personality;
  }

  public getKind(): RasterPlayerKind {
    return this.config.kind ?? "nation";
  }

  public getLastDecisionTick(): number {
    return this.lastDecisionTick;
  }

  private onMessage(message: RasterServerMessage): void {
    if (message.type === "SERVER_RASTER_PLAYER_ASSIGNED") {
      this.myPlayerId = message.payload.playerId;
      return;
    }
    if (message.type === "SERVER_RASTER_SNAPSHOT") {
      this.handleSnapshot(message.payload);
    }
  }

  private handleSnapshot(snapshot: RasterSnapshot): void {
    if (this.myPlayerId === null || !this.session) return;
    if (snapshot.winnerPlayerId !== null) return;
    // During the opening start phase nobody may take territory yet — the bot
    // simply holds its seat and waits for the game phase to begin.
    if (snapshot.phase !== "playing") return;

    // Throttle decisions (and the work behind them) to the personality cadence.
    if (snapshot.tick - this.lastDecisionTick < this.config.personality.decisionCooldownTicks) return;
    this.lastDecisionTick = snapshot.tick;

    const grid = this.session.peekGrid();
    const map = this.session.peekMap();
    const kind = this.config.kind ?? "nation";

    // Reinvest banked gold into structures independent of the troop decision
    // below, so a maturing bot economy keeps compounding without stalling
    // expansion. A passive Bot filler builds nothing — OpenFront's Tribe is a
    // stationary map-filler, not an economic player.
    if (kind !== "bot") this.maybeBuild(grid, map);

    // Diplomacy: answer pending offers, sue for peace with a dangerous rival, or
    // (for the ruthless) betray a pact that has boxed it in. One move per tick.
    // A Bot filler only ever does the first half of that — it auto-accepts
    // any offer and never proposes or betrays (OpenFront's Tribe "accepts
    // every incoming alliance request").
    this.manageDiplomacy(grid, kind);

    if (grid.troopsOf(this.myPlayerId) < this.config.personality.minPool) return;

    this.decide(grid, map);
  }

  /**
   * Reinvest banked gold into one structure this decision. A coastal bot opens a
   * **port** first — a steady trade dividend that compounds its economy — then
   * pours the rest into **cities**. At most one structure per call so the bot
   * doesn't dump its whole treasury at once. Deterministic throughout
   * (lowest-`TileRef` eligible tile).
   */
  private maybeBuild(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    if (me === null || !this.session) return;
    if (grid.tileCountOf(me) < RasterBotController.MIN_TILES_TO_BUILD) return;
    // One port for the coastal gold dividend, then compound into cities.
    if (this.tryQueueBuild(grid, map, "port", (ref) => map.isShore(ref), 1)) return;
    this.tryQueueBuild(grid, map, "city", () => true);
  }

  /**
   * Queue a build of `type` on the lowest-`TileRef` owned, unbuilt, `eligible`
   * tile when the bot can afford its next one and owns fewer than `cap` of the
   * type. Returns whether an order was queued, so the caller can fall through to
   * the next building choice. Deterministic, so replays stay identical.
   */
  private tryQueueBuild(
    grid: TerritoryGrid,
    map: GameMap,
    type: "city" | "port",
    eligible: (ref: TileRef) => boolean,
    cap = Number.POSITIVE_INFINITY,
  ): boolean {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return false;
    const owned = grid.buildingCountOf(me, type);
    if (owned >= cap) return false;
    if (grid.goldOf(me) < buildingCost(type, owned)) return false;

    for (const ref of grid.tilesOf(me)) {
      if (!grid.hasBuilding(ref) && eligible(ref)) {
        session.queueBuild(this.config.botId, { targetX: map.x(ref), targetY: map.y(ref), building: type });
        return true;
      }
    }
    return false;
  }

  /**
   * Run at most one diplomacy move per decision, in priority order:
   *  1. **Answer** the lowest-id pending alliance offer. Defensive personalities
   *     welcome any ally; aggressive ones accept only an offer from someone at
   *     least as strong (never a weakling they could simply eat).
   *  2. **Propose** peace to the strongest rival on its border that clearly
   *     outguns it — only defensive bots sue for peace, and only against a real
   *     threat.
   *  3. **Betray:** a ruthless bot hemmed in *only* by allies (no neutral land,
   *     no other rival to fight) turns on the weakest ally it decisively outguns
   *     rather than stagnate behind its own pacts.
   * A passive Bot filler (`kind: "bot"`) only ever does step 1, and
   * unconditionally accepts — OpenFront's Tribe welcomes every offer and
   * never proposes or betrays on its own.
   * Deterministic throughout (ascending-id tiebreaks, no RNG).
   */
  private manageDiplomacy(grid: TerritoryGrid, kind: RasterPlayerKind): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    const alliances = session.peekAlliances();
    const p = this.config.personality;
    const myPool = grid.troopsOf(me);

    // 1) Respond to a pending offer.
    const incoming = alliances.incomingProposals(me);
    if (incoming.length > 0) {
      const from = incoming[0];
      const accept = kind === "bot" || p.aggression < 0.5 || grid.troopsOf(from) >= myPool;
      session.respondAlliance(this.config.botId, from, accept);
      return;
    }
    if (kind === "bot") return;

    const bordering = grid.frontierTargets(me).filter((t) => t.target !== NEUTRAL_PLAYER);

    // 2) Defensive bots sue for peace with a clearly stronger bordering rival.
    if (p.aggression < 0.5) {
      let threat: PlayerId | null = null;
      let threatPool = -1;
      for (const t of bordering) {
        if (alliances.areAllied(me, t.target) || alliances.hasProposal(me, t.target)) continue;
        const theirPool = grid.troopsOf(t.target);
        if (theirPool > myPool * 1.5 && theirPool > threatPool) {
          threatPool = theirPool;
          threat = t.target;
        }
      }
      if (threat !== null) session.proposeAlliance(this.config.botId, threat);
      return;
    }

    // 3) Betrayal — only for the ruthless, and only when fully hemmed in by allies.
    if (p.aggression >= 0.9) {
      const hasOpenTarget = grid.frontierTargets(me).some(
        (t) => t.target === NEUTRAL_PLAYER || !alliances.areAllied(me, t.target),
      );
      if (hasOpenTarget) return;
      let prey: PlayerId | null = null;
      let preyPool = Infinity;
      for (const t of bordering) {
        if (!alliances.areAllied(me, t.target)) continue;
        const theirPool = grid.troopsOf(t.target);
        if (myPool >= theirPool * (p.attackPoolRatio + 0.5) && theirPool < preyPool) {
          preyPool = theirPool;
          prey = t.target;
        }
      }
      if (prey !== null) session.breakAlliance(this.config.botId, prey);
    }
  }

  /** Pick and queue one expand intent for this decision tick (or bank troops). */
  private decide(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    const p = this.config.personality;
    const pool = grid.troopsOf(me);
    const alliances = session.peekAlliances();

    const targets = grid.frontierTargets(me);
    if (targets.length === 0) return; // Fully boxed in — nothing reachable; bank income.

    const neutral = targets.find((t) => t.target === NEUTRAL_PLAYER) ?? null;
    // Allies are off the table — a pact bars attacking them, so they never enter
    // the target-selection maths (the engine would reject such an intent anyway).
    const enemies = targets.filter(
      (t) => t.target !== NEUTRAL_PLAYER && !alliances.areAllied(me, t.target),
    );

    // Weakest rival we can currently beat on troop pool (deterministic tiebreak:
    // lowest pool, then lowest target id thanks to ascending `targets` order).
    let beatable: { target: PlayerId; sample: TileRef } | null = null;
    let beatablePool = Infinity;
    for (const enemy of enemies) {
      const enemyPool = grid.troopsOf(enemy.target);
      if (pool >= enemyPool * p.attackPoolRatio && enemyPool < beatablePool) {
        beatablePool = enemyPool;
        beatable = { target: enemy.target, sample: enemy.sample };
      }
    }

    let sample: TileRef;
    let fraction: number;
    // A "decisive" edge is well beyond the bare ratio — enough to be worth opening
    // a war over while cheap neutral land is still on the table.
    const decisive = beatable !== null && pool >= beatablePool * (p.attackPoolRatio + 0.5);

    if (beatable && (!neutral || (p.aggression >= 0.5 && decisive))) {
      sample = beatable.sample;
      fraction = p.attackCommit;
    } else if (neutral) {
      sample = neutral.sample;
      fraction = p.expandCommit;
    } else if (beatable) {
      // No neutral land and only this rival is beatable.
      sample = beatable.sample;
      fraction = p.attackCommit;
    } else {
      // Boxed in by stronger rivals only. Banking income is the right call —
      // unless the pool is saturating (capped at the territory-scaled ceiling),
      // in which case further income is lost, so spend down on the softest target.
      // With nothing left to fight (only allies or neutral-free borders), bank.
      if (enemies.length === 0) return;
      const cap = maxTroops(grid.tileCountOf(me), grid.activeBuildingCountOf(me, "city")) *
        grid.modifiersOf(me).troopCapMultiplier;
      if (pool < cap * 0.9) return;
      const softest = enemies.reduce((a, b) => (grid.troopsOf(b.target) < grid.troopsOf(a.target) ? b : a));
      sample = softest.sample;
      fraction = p.attackCommit;
    }

    const available = pool * (1 - p.reserveFraction);
    const troops = Math.max(1, Math.floor(available * fraction));
    const percent = Math.min(100, Math.max(1, Math.round((troops / pool) * 100)));

    session.queueExpand(this.config.botId, {
      targetX: map.x(sample),
      targetY: map.y(sample),
      percent,
    });
  }
}
