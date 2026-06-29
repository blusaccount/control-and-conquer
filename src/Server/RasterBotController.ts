import type { RasterGameSession } from "./RasterGameSession.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "../Core/TerritoryGrid.js";
import { MAX_POOL_PER_TILE } from "../Core/rasterCombatConfig.js";
import { buildingCost } from "../Core/buildings.js";
import type { RasterServerMessage, RasterSnapshot } from "../Core/types.js";

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

export interface RasterBotConfig {
  readonly botId: string;
  readonly personality: RasterBotPersonality;
}

export const DEFAULT_RASTER_BOT_CONFIG: RasterBotConfig = {
  botId: "raster-bot-1",
  // Default to the all-rounder so a lone bot plays a sensible, readable game.
  personality: RASTER_BOT_PERSONALITIES[2],
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
 * bot consult precomputed **sea links**, so it can plan amphibious assaults
 * across narrow straits instead of stranding itself on its home landmass (the
 * old land-only frontier scan's fatal flaw on water-heavy maps).
 *
 * ## Strategy
 * Every `decisionCooldownTicks`, once it has banked `minPool` troops, the bot:
 *  1. Enumerates the owners its border touches — neutral land and each rival —
 *     via {@link TerritoryGrid.frontierTargets} (one pass, sea crossings included).
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
  /** This bot's capital tile (read off snapshots), kept off the build list. */
  private myCapital: TileRef | null = null;

  /**
   * The bot reinvests in a city once it holds at least this much land — early
   * game it pours everything into expansion; a maturing empire banks gold into
   * structures that compound its economy.
   */
  private static readonly MIN_TILES_TO_BUILD = 8;

  public constructor(private readonly config: RasterBotConfig = DEFAULT_RASTER_BOT_CONFIG) {}

  public attach(session: RasterGameSession): () => void {
    this.session = session;
    const unsubscribe = session.subscribe(this.config.botId, (message) => this.onMessage(message));
    return () => {
      this.session = null;
      this.myPlayerId = null;
      this.myCapital = null;
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

    // Track our capital so we never try to build over it (the server would
    // reject it, and the seat is reserved as a fortified centre).
    const me = snapshot.players.find((p) => p.playerId === this.myPlayerId);
    this.myCapital = me && me.capitalX >= 0 ? map.ref(me.capitalX, me.capitalY) : null;

    // Reinvest banked gold into a city independent of the troop decision below,
    // so a maturing bot economy keeps compounding without stalling expansion.
    this.maybeBuildCity(grid, map);

    if (grid.troopsOf(this.myPlayerId) < this.config.personality.minPool) return;

    this.decide(grid, map);
  }

  /**
   * Queue a city build when the bot can afford its next one and has interior
   * land to place it on. Picks the lowest-`TileRef` owned tile that is neither
   * the capital nor already built on — deterministic, so replays stay identical.
   */
  private maybeBuildCity(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    if (grid.tileCountOf(me) < RasterBotController.MIN_TILES_TO_BUILD) return;
    const cost = buildingCost("city", grid.buildingCountOf(me, "city"));
    if (grid.goldOf(me) < cost) return;

    let target: TileRef | null = null;
    for (const ref of grid.tilesOf(me)) {
      if (ref !== this.myCapital && !grid.hasBuilding(ref)) {
        target = ref;
        break;
      }
    }
    if (target === null) return;

    session.queueBuild(this.config.botId, {
      targetX: map.x(target),
      targetY: map.y(target),
      building: "city",
    });
  }

  /** Pick and queue one expand intent for this decision tick (or bank troops). */
  private decide(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    const p = this.config.personality;
    const pool = grid.troopsOf(me);

    const targets = grid.frontierTargets(me);
    if (targets.length === 0) return; // Fully boxed in — nothing reachable; bank income.

    const neutral = targets.find((t) => t.target === NEUTRAL_PLAYER) ?? null;
    const enemies = targets.filter((t) => t.target !== NEUTRAL_PLAYER);

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
      // unless the pool is saturating (capped at tiles * MAX_POOL_PER_TILE), in
      // which case further income is lost, so spend down on the softest target.
      const cap = grid.tileCountOf(me) * MAX_POOL_PER_TILE;
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
