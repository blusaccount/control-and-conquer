import type { RasterGameSession } from "./RasterGameSession.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "../Core/TerritoryGrid.js";
import { maxTroops } from "../Core/rasterCombatConfig.js";
import { ALLIANCE_RENEWAL_WINDOW_TICKS } from "../Core/alliances.js";
import { Prng } from "../Core/prng.js";
import {
  ASSIST_FAVOR_COST,
  RELATION_FRIENDLY,
  RELATION_HOSTILE,
  RELATION_NEUTRAL,
} from "../Core/relations.js";
import {
  buildingCost,
  costCounterTypes,
  RAIL_STATION_MAX_RANGE,
  RAIL_STATION_MIN_RANGE,
  STRUCTURE_MIN_DIST,
  UPGRADABLE_BUILDING_TYPES,
  type BuildingType,
} from "../Core/buildings.js";
import { nukeCost, type NukeKind } from "../Core/nukes.js";
import type { RasterServerMessage, RasterSnapshot } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";
import { BOT_DECISION_TICKS, NATION_DECISION_TICKS, type RasterPlayerKind } from "./botField.js";

// ---------------------------------------------------------------------------
// OpenFront AI, re-expressed for this engine.
//
// OpenFront drives every AI seat through one shared attack brain
// (`AiAttackBehavior`) plus, for Nations, a bundle of behaviours
// (structures / alliances / warships / nukes) — there are NO per-seat
// personalities. What varies per seat is a handful of ratios rolled once from
// a seeded PRNG, and what varies per match is the difficulty, which reorders
// the strategy list, throttles aggression against humans, and gates every
// diplomatic judgement. This file mirrors that model: same ratios, same
// odds, same strategy orders, same difficulty gates — implemented natively
// against this engine's grid/session APIs (OpenFront is AGPL; behaviour
// constants and decision rules are mirrored, code is not).
//
// Known simplifications (documented, not silent):
//  · No MIRV programme (the 25M warhead is out of reach in typical matches;
//    nations still *save* toward it, which is what shapes their spending).
//  · Nuke aiming keeps this engine's deep-territory sampling instead of
//    OpenFront's structure-scoring + SAM-trajectory avoidance.
//  · The "island" strategy picks the weakest reachable enemy globally rather
//    than sorting every player by bounding-box distance.
//  · "afk" (disconnected humans) and team-game strategies don't apply here.
//  · Captured buildings are demolished by this engine, so OpenFront's
//    tribe-deletes-structures and steal-back-structures branches are moot.
// ---------------------------------------------------------------------------

/** Per-seat ratio ranges every AI rolls once (OpenFront's nextInt bounds, /100). */
const TRIGGER_RATIO_RANGE: readonly [number, number] = [50, 60];
const RESERVE_RATIO_RANGE: readonly [number, number] = [30, 40];
const EXPAND_RATIO_RANGE: readonly [number, number] = [10, 20];

/** Fraction of own troops below which an incoming attack isn't yet a defensive emergency. */
const UNDER_ATTACK_THREAT_RATIO = 0.35;
/** Hard/Impossible: one defense post allowed per this much incoming-to-own ratio. */
const DEFENSE_POST_RATIO_PER_POST = 0.4;
/** Forts garrison this close (Chebyshev tiles) to the pressed border. */
const FORT_BORDER_RANGE = 15;
/** Structures-per-tile density above which a nation upgrades instead of building. */
const UPGRADE_DENSITY_THRESHOLD = 1 / 1500;
/** Hard cap on missile silos per nation. */
const MAX_MISSILE_SILOS = 3;
/** Silos-per-city ratio (first silo uses the higher ratio so nuking starts earlier). */
const SILO_RATIO = 0.2;
const FIRST_SILO_RATIO = 0.4;
/** Ports/factories per city; factories are rare when the coast already trades. */
const PORT_RATIO = 0.75;
const FACTORY_RATIO = 0.75;
const FACTORY_COASTAL_MULTIPLIER = 0.33;
/** SAM launchers per city, by difficulty. */
const SAM_RATIO: Record<RasterDifficulty, number> = {
  easy: 0.15,
  medium: 0.2,
  hard: 0.25,
  impossible: 0.3,
};
/** Perceived-cost inflation per owned structure while saving for warheads. */
const PERCEIVED_COST_INCREASE: Partial<Record<BuildingType, number>> = {
  city: 1,
  port: 1,
  factory: 1,
  silo: 1,
  sam: 0.3,
};
/** Rival at (or below) this fraction of their troop ceiling reads as "very weak". */
const VERY_WEAK_FRACTION = 0.15;
/** Number of ±tile offsets a random-boat scan samples around a shore tile. */
const RANDOM_BOAT_SCAN_RADIUS = 150;
const RANDOM_BOAT_SCAN_TRIES = 200;

// Emoji indices into RASTER_EMOJIS (["👍","👎","😂","😡","🤝","🫡","💀","🔥"]).
const EMOJI_THUMBS_DOWN = 1;
const EMOJI_ANGRY = 3;
const EMOJI_HANDSHAKE = 4;

export interface RasterBotConfig {
  readonly botId: string;
  /** Which AI tier this seat plays: a full-strategy Nation or a passive Bot (Tribe). */
  readonly kind?: RasterPlayerKind;
  /** Match difficulty — the single knob OpenFront's AI varies by. */
  readonly difficulty?: RasterDifficulty;
  /** Extra seed entropy (the seat index), so equal difficulties still differ per seat. */
  readonly seed?: number;
}

export const DEFAULT_RASTER_BOT_CONFIG: RasterBotConfig = {
  botId: "raster-bot-1",
  kind: "nation",
  difficulty: "medium",
};

/** FNV-1a over a string — the per-seat PRNG seed (stand-in for OF's simpleHash). */
const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
};

/**
 * Server-side AI opponent for raster (OpenFront-style) matches.
 *
 * Subscribes to a {@link RasterGameSession} exactly like a human client and
 * pushes its moves back through the same command channel — so every bot action
 * runs through the identical server-side validation a player's clicks do. It
 * reads decision inputs straight off the session's authoritative grid
 * (`peekGrid`) — the same public data every snapshot carries — plus the
 * session's relations ledger, which is what OpenFront's nations consult too.
 *
 * All randomness comes from one per-seat seeded {@link Prng} (OpenFront seeds
 * a `PseudoRandom` per execution the same way), so identical seatings replay
 * identically: no `Math.random`, no wall clock.
 */
export class RasterBotController {
  private myPlayerId: PlayerId | null = null;
  private session: RasterGameSession | null = null;
  private readonly prng: Prng;
  private readonly difficulty: RasterDifficulty;

  /** Ticks between decisions and this seat's phase inside that cycle (OF's attackRate/attackTick). */
  private readonly attackRate: number;
  private readonly attackTick: number;
  /** Per-seat ratios of the troop ceiling: when to open wars / what stays home. */
  private readonly triggerRatio: number;
  private readonly reserveRatio: number;
  private readonly expandRatio: number;
  /** A third of nations throw only hydrogen bombs (OpenFront's anti-atom-spam roll). */
  private readonly isHydroNation: boolean;

  /** True once the opening land-rush attack (half the pool at neutral land) went out. */
  private openingMoveDone = false;
  /** Tribes stop scanning for neutral land once none borders them (OF's latch). */
  private neutralLatch = true;
  /** Each seat's public player class, read off the snapshot (tribe farming / nuke targeting). */
  private readonly kindOf = new Map<PlayerId, RasterPlayerKind>();
  /** Troops already allocated to parallel tribe-farming strikes this decision. */
  private botAttackTroopsSent = 0;
  /** Perceived warhead prices, inflated after each launch to simulate saving for a MIRV. */
  private atomPerceivedCost = 0;
  private hydroPerceivedCost = 0;
  /** Number of structures this nation has placed (defense posts excluded). */
  private placements = 0;

  /** Per-decision memo of `grid.frontierTargets(me)` (perimeter walk + sea BFS). */
  private frontierCache: { tick: number; targets: Array<{ target: PlayerId; tiles: number; sample: TileRef }> } | null = null;
  private lastDecisionTick = Number.NEGATIVE_INFINITY;

  public constructor(private readonly config: RasterBotConfig = DEFAULT_RASTER_BOT_CONFIG) {
    this.difficulty = config.difficulty ?? "medium";
    this.prng = new Prng(hashString(config.botId) + (config.seed ?? 0));
    const kind = config.kind ?? "nation";
    const [lo, hi] = kind === "bot" ? BOT_DECISION_TICKS : NATION_DECISION_TICKS[this.difficulty];
    this.attackRate = this.prng.nextInt(lo, hi);
    this.attackTick = this.prng.nextInt(0, this.attackRate);
    this.triggerRatio = this.prng.nextInt(...TRIGGER_RATIO_RANGE) / 100;
    this.reserveRatio = this.prng.nextInt(...RESERVE_RATIO_RANGE) / 100;
    this.expandRatio = this.prng.nextInt(...EXPAND_RATIO_RANGE) / 100;
    this.isHydroNation = this.prng.chance(3);
  }

  public attach(session: RasterGameSession): () => void {
    this.session = session;
    this.atomPerceivedCost = nukeCost("atom", 0);
    this.hydroPerceivedCost = nukeCost("hydrogen", 0);
    // Subscribe headless (wantsRaster=false): the bot reads engine state via
    // peekGrid and never decodes the wire ownership plane.
    const unsubscribe = session.subscribe(
      this.config.botId,
      (message) => this.onMessage(message),
      true,
      false,
      undefined,
      this.config.kind ?? "nation",
    );
    if (!unsubscribe) {
      this.session = null;
      return () => {};
    }
    return () => {
      this.session = null;
      this.myPlayerId = null;
      this.kindOf.clear();
      unsubscribe();
    };
  }

  public getPlayerId(): PlayerId | null {
    return this.myPlayerId;
  }

  public getBotId(): string {
    return this.config.botId;
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
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    if (snapshot.winnerPlayerId !== null) return;
    if (snapshot.phase !== "playing") return;

    // Public player classes: a nation farms a bordering tribe proportionally
    // and never wastes a warhead on one. A seat's kind never changes.
    if (this.kindOf.size !== snapshot.players.length) {
      for (const p of snapshot.players) {
        if (!this.kindOf.has(p.playerId)) this.kindOf.set(p.playerId, p.kind);
      }
    }

    const grid = session.peekGrid();
    const map = session.peekMap();
    if (!grid.hasPlayer(me) || grid.tileCountOf(me) === 0) return;

    const tick = snapshot.tick;
    const kind = this.config.kind ?? "nation";
    const beat = tick % this.attackRate;

    if (beat !== this.attackTick) {
      // Between attack decisions a nation still places structures twice (at 1/3
      // and 2/3 of the interval) so a rich economy never outruns its spending —
      // OpenFront's exact off-beat structure cadence.
      if (kind !== "bot") {
        const oneThird = (this.attackTick + Math.floor(this.attackRate / 3)) % this.attackRate;
        const twoThirds = (this.attackTick + Math.floor((this.attackRate * 2) / 3)) % this.attackRate;
        if (beat === oneThird || beat === twoThirds) this.handleStructures(grid, map);
      }
      return;
    }

    this.lastDecisionTick = tick;
    this.frontierCache = null;

    // The opening move: dump half the pool at neutral land the moment the seat
    // goes live (OpenFront's forceSendAttack on first activation) — this is the
    // land rush that fills the early map.
    if (!this.openingMoveDone) {
      this.openingMoveDone = true;
      const neutral = this.frontier(grid).find((t) => t.target === NEUTRAL_PLAYER);
      if (neutral) {
        this.queueTroops(grid, map, me, neutral.sample, Math.floor(grid.troopsOf(me) / 2));
      }
      return;
    }

    if (kind === "bot") {
      this.tribeTick(grid, map);
      return;
    }

    this.handleAllianceRequests(grid);
    this.handleAllianceExtensions(grid);
    this.handleStructures(grid, map);
    this.maybeSpawnWarship(grid, map);
    this.handleEmbargoes(grid);
    this.maybeAttack(grid, map);
    this.maybeSendNuke(grid, map);
  }

  // -------------------------------------------------------------------------
  // Shared attack brain (OpenFront's AiAttackBehavior).
  // -------------------------------------------------------------------------

  private frontier(grid: TerritoryGrid): Array<{ target: PlayerId; tiles: number; sample: TileRef }> {
    if (this.frontierCache?.tick !== this.lastDecisionTick) {
      this.frontierCache = { tick: this.lastDecisionTick, targets: grid.frontierTargets(this.myPlayerId!) };
    }
    return this.frontierCache.targets;
  }

  /** This seat's troop ceiling (territory-scaled, handicap-adjusted). */
  private troopCapOf(grid: TerritoryGrid, id: PlayerId): number {
    return maxTroops(grid.tileCountOf(id), grid.activeLevelsOf(id, "city")) * grid.modifiersOf(id).troopCapMultiplier;
  }

  private hasReserveRatioTroops(grid: TerritoryGrid, me: PlayerId): boolean {
    return grid.troopsOf(me) >= this.troopCapOf(grid, me) * this.reserveRatio;
  }

  private hasTriggerRatioTroops(grid: TerritoryGrid, me: PlayerId): boolean {
    return grid.troopsOf(me) >= this.troopCapOf(grid, me) * this.triggerRatio;
  }

  /** Bordering rivals sorted weakest-first, split allied / not. */
  private borderSplit(grid: TerritoryGrid): { friends: Array<{ target: PlayerId; sample: TileRef }>; enemies: Array<{ target: PlayerId; sample: TileRef }> } {
    const me = this.myPlayerId!;
    const alliances = this.session!.peekAlliances();
    const players = this.frontier(grid)
      .filter((t) => t.target !== NEUTRAL_PLAYER)
      .sort((a, b) => grid.troopsOf(a.target) - grid.troopsOf(b.target) || a.target - b.target);
    return {
      friends: players.filter((t) => alliances.areAllied(me, t.target)),
      enemies: players.filter((t) => !alliances.areAllied(me, t.target)),
    };
  }

  private maybeAttack(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId!;
    const { friends, enemies } = this.borderSplit(grid);

    // Neutral land first, always — cheap tiles compound into income. Fallout
    // ground is left alone here (the dedicated `nuked` strategy takes it).
    const neutral = this.frontier(grid).find((t) => t.target === NEUTRAL_PLAYER);
    if (neutral && !grid.hasFallout(neutral.sample)) {
      if (this.sendAttackAt(grid, map, NEUTRAL_PLAYER, neutral.sample)) return;
    }

    if (enemies.length === 0) {
      // Nobody to fight next door: occasionally probe across the sea.
      if (this.prng.chance(5)) this.attackWithRandomBoat(grid, map, enemies);
    } else {
      if (this.prng.chance(10)) {
        this.attackWithRandomBoat(grid, map, enemies);
        return;
      }
      this.maybeSendAllianceRequests(grid, enemies);
    }

    this.attackBestTarget(grid, map, friends, enemies);
  }

  private attackBestTarget(
    grid: TerritoryGrid,
    map: GameMap,
    friends: Array<{ target: PlayerId; sample: TileRef }>,
    enemies: Array<{ target: PlayerId; sample: TileRef }>,
  ): void {
    const me = this.myPlayerId!;
    // Bank to the war reserve before any deliberate strike…
    if (!this.hasReserveRatioTroops(grid, me)) return;
    // …and normally to the trigger ratio, with OpenFront's 10% early-strike roll.
    if (!this.hasTriggerRatioTroops(grid, me) && !this.prng.chance(10)) return;

    for (const strategy of this.strategiesFor(grid, map, friends, enemies)) {
      if (strategy()) return;
    }
  }

  /**
   * The difficulty-ordered strategy list — OpenFront's exact orders: Easy runs
   * the dumbest sequence, Impossible the sharpest. ("afk" and "donate" are
   * team/disconnect features that don't exist here.)
   */
  private strategiesFor(
    grid: TerritoryGrid,
    map: GameMap,
    friends: Array<{ target: PlayerId; sample: TileRef }>,
    enemies: Array<{ target: PlayerId; sample: TileRef }>,
  ): Array<() => boolean> {
    const me = this.myPlayerId!;
    const session = this.session!;
    const relations = session.peekRelations();

    const retaliate = (): boolean => {
      const attacker = this.findIncomingAttacker(grid);
      return attacker !== null && this.sendAttack(grid, map, attacker, true);
    };

    const bots = (): boolean => this.attackBots(grid, map, enemies);

    const assist = (): boolean => this.assistAllies(grid, map);

    const traitor = (): boolean => {
      const t = enemies.find(
        (e) => this.isTraitor(e.target) && grid.troopsOf(e.target) < grid.troopsOf(me) * 1.2,
      );
      return t !== undefined && this.sendAttack(grid, map, t.target);
    };

    const betray = (): boolean => {
      for (const friend of friends) {
        if (this.maybeBetray(grid, friend.target, friends.length + enemies.length)) {
          return this.sendAttack(grid, map, friend.target, true);
        }
      }
      return false;
    };

    const nuked = (): boolean => {
      // Fallout ground is still capturable — once ordinary land runs out the
      // AI walks into the glow rather than stalling.
      const neutral = this.frontier(grid).find((t) => t.target === NEUTRAL_PLAYER);
      if (neutral && grid.hasFallout(neutral.sample)) {
        return this.sendAttackAt(grid, map, NEUTRAL_PLAYER, neutral.sample);
      }
      return false;
    };

    const victim = (): boolean => {
      const v = enemies.find((e) => {
        if (grid.troopsOf(e.target) > grid.troopsOf(me) * 1.2) return false;
        const incoming = session.peekIncomingAttacks(e.target).reduce((s, a) => s + a.troops, 0);
        return incoming > grid.troopsOf(e.target) * 0.5;
      });
      return v !== undefined && this.sendAttack(grid, map, v.target);
    };

    const hated = (): boolean => {
      for (const entry of relations.sortedOf(me)) {
        if (entry.tier !== RELATION_HOSTILE) continue;
        const other = entry.other;
        if (!grid.hasPlayer(other) || other === me) continue;
        if (session.peekAlliances().areAllied(me, other)) continue;
        if (grid.troopsOf(other) > grid.troopsOf(me) * 3) continue;
        return this.sendAttack(grid, map, other);
      }
      return false;
    };

    const veryWeak = (): boolean => {
      const w = enemies.find(
        (e) =>
          grid.troopsOf(e.target) < this.troopCapOf(grid, e.target) * VERY_WEAK_FRACTION &&
          grid.troopsOf(e.target) < grid.troopsOf(me) * 1.2,
      );
      return w !== undefined && this.sendAttack(grid, map, w.target);
    };

    const weakest = (): boolean => {
      if (enemies.length === 0) return false;
      const w = enemies[0];
      if (grid.troopsOf(w.target) >= grid.troopsOf(me)) return false;
      return this.sendAttack(grid, map, w.target);
    };

    const island = (): boolean => {
      if (enemies.length > 0) return false;
      return this.attackNearestIslandEnemy(grid, map);
    };

    switch (this.difficulty) {
      case "easy":
        return [nuked, bots, retaliate, assist, betray, hated, weakest];
      case "medium":
        return [bots, nuked, retaliate, assist, betray, hated, traitor, weakest, island];
      case "hard":
        return [bots, retaliate, assist, betray, nuked, traitor, hated, veryWeak, victim, weakest, island];
      case "impossible":
        return [retaliate, bots, veryWeak, assist, traitor, betray, victim, nuked, hated, weakest, island];
    }
  }

  /** Largest non-allied incoming land attack's owner — nations ignore tribe raids. */
  private findIncomingAttacker(grid: TerritoryGrid): PlayerId | null {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    let best: PlayerId | null = null;
    let bestTroops = 0;
    for (const a of session.peekIncomingAttacks(me)) {
      if (alliances.areAllied(me, a.attacker)) continue;
      if ((this.config.kind ?? "nation") !== "bot" && this.kindOf.get(a.attacker) === "bot") continue;
      if (a.troops > bestTroops) {
        bestTroops = a.troops;
        best = a.attacker;
      }
    }
    return best;
  }

  /**
   * Farm neighbouring tribes: weakest-density first, several in parallel on
   * harder tiers (Easy 1, Medium 1–2, Hard 3, Impossible all).
   */
  private attackBots(grid: TerritoryGrid, map: GameMap, enemies: Array<{ target: PlayerId; sample: TileRef }>): boolean {
    const tribes = enemies.filter((e) => this.kindOf.get(e.target) === "bot");
    if (tribes.length === 0) return false;
    this.botAttackTroopsSent = 0;
    const density = (id: PlayerId): number => grid.troopsOf(id) / Math.max(1, grid.tileCountOf(id));
    const sorted = [...tribes].sort((a, b) => density(a.target) - density(b.target) || a.target - b.target);
    let parallelism: number;
    switch (this.difficulty) {
      case "easy": parallelism = 1; break;
      case "medium": parallelism = this.prng.chance(2) ? 1 : 2; break;
      case "hard": parallelism = 3; break;
      case "impossible": parallelism = sorted.length; break;
    }
    for (const tribe of sorted.slice(0, parallelism)) {
      this.sendAttack(grid, map, tribe.target);
    }
    return this.botAttackTroopsSent > 0;
  }

  /** Honour an ally's target request (relation permitting) — the favour costs goodwill. */
  private assistAllies(grid: TerritoryGrid, map: GameMap): boolean {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    const relations = session.peekRelations();
    for (const req of alliances.targetRequestsFor(me)) {
      const ally = req.from;
      if (relations.tierOf(me, ally) < RELATION_FRIENDLY) continue;
      const target = req.target;
      if (target === me || !grid.hasPlayer(target)) continue;
      if (alliances.areAllied(me, target)) continue;
      if (!this.sendAttack(grid, map, target)) continue;
      relations.update(me, ally, ASSIST_FAVOR_COST);
      return true;
    }
    return false;
  }

  /** OpenFront's betrayal judgement, per difficulty (see NationAllianceBehavior.maybeBetray). */
  private maybeBetray(grid: TerritoryGrid, friend: PlayerId, borderingPlayerCount: number): boolean {
    const me = this.myPlayerId!;
    const session = this.session!;
    const myTroops = grid.troopsOf(me);
    const friendTroops = grid.troopsOf(friend);
    const diff = this.difficulty;

    // Hard/Impossible read the real strength: a friend under 20% of their
    // ceiling (counting troops already marching) who is weaker than us is prey.
    if (diff === "hard" || diff === "impossible") {
      const friendTotal = friendTroops + session.peekOutgoingAttackTroops(friend);
      if (friendTotal < this.troopCapOf(grid, friend) * 0.2 && friendTroops < myTroops) {
        return this.betray(friend);
      }
    }
    // Easy/Medium use the blunt 10× rule — but an Easy nation never betrays a human.
    if (
      (diff === "easy" || diff === "medium") &&
      !(diff === "easy" && this.kindOf.get(friend) === "human") &&
      myTroops >= friendTroops * 10
    ) {
      return this.betray(friend);
    }
    // A traitor ally who isn't clearly stronger deserves what's coming (not on Easy).
    if (diff !== "easy" && this.isTraitor(friend) && friendTroops < myTroops * 1.2) {
      return this.betray(friend);
    }
    // Our only neighbour, three times weaker: the pact is the only thing saving them.
    if (diff !== "easy" && borderingPlayerCount === 1 && friendTroops * 3 < myTroops) {
      return this.betray(friend);
    }
    return false;
  }

  private betray(friend: PlayerId): boolean {
    const session = this.session!;
    session.breakAlliance(this.config.botId, friend);
    session.sendEmoji(this.config.botId, friend, EMOJI_ANGRY);
    return true;
  }

  private isTraitor(id: PlayerId): boolean {
    // The conflict engine owns the 30-second traitor mark.
    return this.session!.peekConflictTraitor(id);
  }

  /**
   * No bordering enemies at all: take the fight across the water to the
   * weakest living rival a boat can reach (approximation of OpenFront's
   * nearest-island search; 1-in-3 the second choice for variety).
   */
  private attackNearestIslandEnemy(grid: TerritoryGrid, map: GameMap): boolean {
    const me = this.myPlayerId!;
    const alliances = this.session!.peekAlliances();
    const candidates = grid
      .players()
      .filter(
        (p) =>
          p !== me &&
          grid.tileCountOf(p) > 0 &&
          !alliances.areAllied(me, p) &&
          grid.troopsOf(p) < grid.troopsOf(me),
      )
      .sort((a, b) => grid.troopsOf(a) - grid.troopsOf(b) || a - b);
    if (candidates.length === 0) return false;
    const pick = candidates.length >= 2 && this.prng.chance(3) ? candidates[1] : candidates[0];
    return this.sendAttack(grid, map, pick);
  }

  /**
   * Occasionally probe a random spot across the sea (OpenFront's random boat):
   * scan around a random own shore tile for land we don't own — preferring
   * unowned or tribe coast — and ship a fifth of the pool at it. Never at a
   * player we already border, never (in FFA) at someone stronger.
   */
  private attackWithRandomBoat(grid: TerritoryGrid, map: GameMap, enemies: Array<{ target: PlayerId; sample: TileRef }>): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    const shore = this.sampleOwnShoreTile(grid, map);
    if (shore === null) return;
    const bordering = new Set(enemies.map((e) => e.target));
    const sx = map.x(shore);
    const sy = map.y(shore);

    const scan = (highInterestOnly: boolean): TileRef | null => {
      for (let i = 0; i < RANDOM_BOAT_SCAN_TRIES; i += 1) {
        const x = this.prng.nextInt(sx - RANDOM_BOAT_SCAN_RADIUS, sx + RANDOM_BOAT_SCAN_RADIUS);
        const y = this.prng.nextInt(sy - RANDOM_BOAT_SCAN_RADIUS, sy + RANDOM_BOAT_SCAN_RADIUS);
        if (!map.inBounds(x, y)) continue;
        const ref = map.ref(x, y);
        if (!grid.isCapturable(ref)) continue;
        const owner = grid.ownerOf(ref);
        if (owner === me) continue;
        if (owner !== NEUTRAL_PLAYER) {
          if (bordering.has(owner)) continue;
          if (grid.troopsOf(owner) > grid.troopsOf(me)) continue;
          if (this.session!.peekAlliances().areAllied(me, owner)) continue;
          if (highInterestOnly && this.kindOf.get(owner) !== "bot") continue;
        }
        return ref;
      }
      return null;
    };

    const dst = scan(true) ?? scan(false);
    if (dst === null) return;
    const owner = grid.ownerOf(dst);
    let troops = Math.floor(grid.troopsOf(me) / 5);
    if (owner !== NEUTRAL_PLAYER) {
      troops = Math.min(troops, this.troopSendCap(grid));
      if (this.isAttackTooWeak(grid, troops, owner)) return;
    }
    if (troops < 1) return;
    session.queueExpand(this.config.botId, {
      targetX: map.x(dst),
      targetY: map.y(dst),
      percent: this.troopsToPercent(grid, troops),
      mode: "sea",
    });
  }

  /** A deterministic-random own shore tile (strided sampling keeps it O(sample)). */
  private sampleOwnShoreTile(grid: TerritoryGrid, map: GameMap): TileRef | null {
    const me = this.myPlayerId!;
    const tiles = grid.tilesOf(me);
    if (tiles.length === 0) return null;
    for (let i = 0; i < 40; i += 1) {
      const ref = tiles[this.prng.nextInt(0, tiles.length)];
      if (map.isShore(ref)) return ref;
    }
    return null;
  }

  // --- attack dispatch / sizing (OpenFront's sendAttack + calculateAttackTroops) ---

  /**
   * Difficulty throttle on aggression against HUMANS (OpenFront's
   * `shouldAttack`) — the single biggest "easy feels easy" rule: an Easy
   * nation follows through on only 1 in 4 attack decisions against a human,
   * Medium on 3 in 4; neutral land, tribes and traitors are always fair game,
   * and a tribe never holds back.
   */
  private shouldAttack(target: PlayerId): boolean {
    if (target === NEUTRAL_PLAYER) return true;
    if ((this.config.kind ?? "nation") === "bot") return true;
    if (this.kindOf.get(target) !== "human") return true;
    if (this.isTraitor(target)) return true;
    if (this.difficulty === "easy") return this.prng.nextInt(0, 4) === 0;
    if (this.difficulty === "medium") return !this.prng.chance(4);
    return true;
  }

  /**
   * Hard/Impossible keep a strategic home guard: never let the pool drop below
   * 75% (Hard) / 90% (Impossible) of the strongest non-allied, non-tribe
   * neighbour — except that a nation under attack may always answer with at
   * least the incoming force.
   */
  private troopSendCap(grid: TerritoryGrid): number {
    if ((this.config.kind ?? "nation") === "bot") return Number.POSITIVE_INFINITY;
    let retain: number;
    if (this.difficulty === "hard") retain = 0.75;
    else if (this.difficulty === "impossible") retain = 0.9;
    else return Number.POSITIVE_INFINITY;

    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    let strongest = 0;
    for (const t of this.frontier(grid)) {
      if (t.target === NEUTRAL_PLAYER) continue;
      if (alliances.areAllied(me, t.target)) continue;
      if (this.kindOf.get(t.target) === "bot") continue;
      strongest = Math.max(strongest, grid.troopsOf(t.target));
    }
    let cap = strongest === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, grid.troopsOf(me) - Math.ceil(strongest * retain));
    const incoming = session.peekIncomingAttacks(me).reduce((s, a) => s + a.troops, 0);
    if (incoming > 0) cap = Math.max(cap, incoming);
    return cap;
  }

  /** Hard/Impossible skip strikes under 20% of the target's troops (retaliation exempt). */
  private isAttackTooWeak(grid: TerritoryGrid, troops: number, target: PlayerId): boolean {
    if ((this.config.kind ?? "nation") === "bot") return false;
    if (this.difficulty !== "hard" && this.difficulty !== "impossible") return false;
    if (this.session!.peekIncomingAttacks(this.myPlayerId!).length > 0) return false;
    return troops < grid.troopsOf(target) * 0.2;
  }

  /**
   * Troops a strike on `target` commits: everything above the war reserve
   * (`maxTroops × reserveRatio`; the smaller expand reserve for neutral land) —
   * except that a nation FARMS a tribe with `4 × the tribe's pool`, skipping
   * the strike entirely when the budget can't spare `2×` (Easy nations dump
   * the whole budget instead; OpenFront's calculateBotAttackTroops).
   */
  private attackTroopsFor(grid: TerritoryGrid, target: PlayerId): number | null {
    const me = this.myPlayerId!;
    const reserveRatio = target === NEUTRAL_PLAYER ? this.expandRatio : this.reserveRatio;
    const reserve = this.troopCapOf(grid, me) * reserveRatio;

    let troops: number;
    if (target !== NEUTRAL_PLAYER && this.kindOf.get(target) === "bot" && (this.config.kind ?? "nation") !== "bot") {
      const budget = Math.floor(grid.troopsOf(me) - reserve - this.botAttackTroopsSent);
      if (this.difficulty === "easy") {
        troops = budget;
      } else {
        troops = Math.floor(grid.troopsOf(target) * 4);
        if (troops > budget) troops = budget < grid.troopsOf(target) * 2 ? 0 : budget;
      }
      this.botAttackTroopsSent += Math.max(0, troops);
    } else {
      troops = Math.floor(grid.troopsOf(me) - reserve);
    }

    if (target !== NEUTRAL_PLAYER) {
      troops = Math.min(troops, this.troopSendCap(grid));
    }
    if (troops < 1) return null;
    if (target !== NEUTRAL_PLAYER && this.isAttackTooWeak(grid, troops, target)) return null;
    return troops;
  }

  /** Send a sized attack at `target` (frontier sample; falls back to any tile of theirs). */
  private sendAttack(grid: TerritoryGrid, map: GameMap, target: PlayerId, force = false): boolean {
    const sample =
      this.frontier(grid).find((t) => t.target === target)?.sample ??
      (target === NEUTRAL_PLAYER ? undefined : grid.anyTileOf(target));
    if (sample === undefined) return false;
    return this.sendAttackAt(grid, map, target, sample, force);
  }

  private sendAttackAt(grid: TerritoryGrid, map: GameMap, target: PlayerId, sample: TileRef, force = false): boolean {
    if (!force && !this.shouldAttack(target)) return false;
    const troops = this.attackTroopsFor(grid, target);
    if (troops === null) return false;
    this.queueTroops(grid, map, this.myPlayerId!, sample, troops);
    return true;
  }

  /** Convert an absolute troop commitment to the wire's percent-of-pool. */
  private troopsToPercent(grid: TerritoryGrid, troops: number): number {
    const pool = Math.max(1, grid.troopsOf(this.myPlayerId!));
    return Math.min(100, Math.max(1, Math.round((troops / pool) * 100)));
  }

  /** Queue an expand order committing `troops` toward `sample` (auto land/sea routing). */
  private queueTroops(grid: TerritoryGrid, map: GameMap, me: PlayerId, sample: TileRef, troops: number): void {
    const session = this.session;
    if (!session || troops < 1) return;
    session.queueExpand(this.config.botId, {
      targetX: map.x(sample),
      targetY: map.y(sample),
      percent: this.troopsToPercent(grid, troops),
    });
  }

  // -------------------------------------------------------------------------
  // Tribe (passive Bot) brain — OpenFront's TribeExecution.
  // -------------------------------------------------------------------------

  private tribeTick(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();

    // A tribe welcomes every offer and every renewal, no judgement at all.
    for (const from of alliances.incomingProposals(me)) {
      session.respondAlliance(this.config.botId, from, true);
      session.sendEmoji(this.config.botId, from, EMOJI_HANDSHAKE);
    }
    const now = session.peekTick();
    for (const ally of alliances.alliesOf(me)) {
      const left = alliances.ticksLeft(me, ally, now);
      if (left === null || left > ALLIANCE_RENEWAL_WINDOW_TICKS) continue;
      // Only second the extension once the partner has asked for it (OpenFront's
      // tribes never initiate a renewal on their own).
      if (!alliances.hasRenewVote(ally, me) || alliances.hasRenewVote(me, ally)) continue;
      session.renewAlliance(this.config.botId, ally);
    }

    // A bordering traitor gets punished at 1/3 odds (1/6 for a traitor *ally*,
    // pact broken first).
    const { friends, enemies } = this.borderSplit(grid);
    const traitorFoe = enemies.find((e) => this.isTraitor(e.target));
    const traitorFriend = friends.find((f) => this.isTraitor(f.target));
    const mark = traitorFoe ?? traitorFriend;
    if (mark && this.prng.chance(traitorFriend && mark === traitorFriend ? 6 : 3)) {
      if (mark === traitorFriend) session.breakAlliance(this.config.botId, mark.target);
      if (this.sendAttack(grid, map, mark.target)) return;
    }

    // The land rush: blanket bordering neutral land until none is left, then
    // latch off the scan for good (OpenFront's neighborsTerraNullius flag).
    if (this.neutralLatch) {
      const neutral = this.frontier(grid).find((t) => t.target === NEUTRAL_PLAYER);
      if (neutral) {
        if (this.sendAttackAt(grid, map, NEUTRAL_PLAYER, neutral.sample)) return;
      } else {
        this.neutralLatch = false;
      }
    }

    this.attackRandomTarget(grid, map, enemies);
  }

  /** Boxed-in tribe: bank to the trigger, then hit back / punish / poke someone random. */
  private attackRandomTarget(grid: TerritoryGrid, map: GameMap, enemies: Array<{ target: PlayerId; sample: TileRef }>): void {
    const me = this.myPlayerId!;
    if (!this.hasTriggerRatioTroops(grid, me)) return;

    // Retaliate against the largest incoming attack (tribes answer anyone).
    const attacker = this.findIncomingAttacker(grid);
    if (attacker !== null && this.sendAttack(grid, map, attacker, true)) return;

    const traitorFoe = enemies.find((e) => this.isTraitor(e.target));
    if (traitorFoe && this.prng.chance(3)) {
      if (this.sendAttack(grid, map, traitorFoe.target)) return;
    }

    // A random neighbour — but nations and humans are skipped half the time
    // (tribes mostly squabble among themselves).
    for (const e of this.prng.shuffled(enemies)) {
      const kind = this.kindOf.get(e.target);
      if ((kind === "nation" || kind === "human") && this.prng.chance(2)) continue;
      if (this.sendAttack(grid, map, e.target)) return;
    }
  }

  // -------------------------------------------------------------------------
  // Nation diplomacy — OpenFront's NationAllianceBehavior.
  // -------------------------------------------------------------------------

  private handleAllianceRequests(grid: TerritoryGrid): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    for (const from of session.peekAlliances().incomingProposals(me)) {
      const accept = this.allianceDecision(grid, from, true);
      session.respondAlliance(this.config.botId, from, accept);
      session.sendEmoji(this.config.botId, from, accept ? EMOJI_HANDSHAKE : EMOJI_THUMBS_DOWN);
    }
  }

  private handleAllianceExtensions(grid: TerritoryGrid): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    const now = session.peekTick();
    for (const ally of alliances.alliesOf(me)) {
      const left = alliances.ticksLeft(me, ally, now);
      if (left === null || left > ALLIANCE_RENEWAL_WINDOW_TICKS) continue;
      // Respond only once the partner has asked (OpenFront nations never
      // initiate an extension), and judge them like a fresh offer.
      if (!alliances.hasRenewVote(ally, me) || alliances.hasRenewVote(me, ally)) continue;
      if (!this.allianceDecision(grid, ally, true)) continue;
      session.renewAlliance(this.config.botId, ally);
    }
  }

  /** 1-in-30 per bordering enemy: consider offering peace (Easy may even court tribes). */
  private maybeSendAllianceRequests(grid: TerritoryGrid, enemies: Array<{ target: PlayerId; sample: TileRef }>): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    for (const e of enemies) {
      if (!this.prng.chance(30)) continue;
      const isTribe = this.kindOf.get(e.target) === "bot";
      if (isTribe && this.difficulty !== "easy") continue;
      if (alliances.hasProposal(me, e.target) || alliances.hasProposal(e.target, me)) continue;
      if (!this.allianceDecision(grid, e.target, false)) continue;
      session.proposeAlliance(this.config.botId, e.target);
    }
  }

  /**
   * OpenFront's alliance judgement, gate by gate: confusion → traitor →
   * over-allied → threat → bad relation → friendly relation → enough allies →
   * earlygame honeymoon → similar strength. Every threshold per difficulty.
   */
  private allianceDecision(grid: TerritoryGrid, other: PlayerId, isResponse: boolean): boolean {
    const me = this.myPlayerId!;
    const session = this.session!;
    const relations = session.peekRelations();
    const alliances = session.peekAlliances();

    // Dumber tiers sometimes just flip a coin (Easy 10%, Medium 5%, Hard 2.5%).
    const confusionOdds = this.difficulty === "easy" ? 10 : this.difficulty === "medium" ? 20 : this.difficulty === "hard" ? 40 : 0;
    if (confusionOdds > 0 && this.prng.chance(confusionOdds)) return this.prng.chance(2);

    // A marked traitor is refused 90% of the time, whoever they are.
    if (this.isTraitor(other) && this.prng.nextInt(0, 100) >= 10) return false;

    // Hard/Impossible refuse anyone already allied with much of the field.
    if (this.difficulty === "hard" || this.difficulty === "impossible") {
      let nonTribes = 0;
      for (const p of grid.players()) {
        if (grid.tileCountOf(p) > 0 && this.kindOf.get(p) !== "bot") nonTribes += 1;
      }
      const cap = this.difficulty === "hard" ? nonTribes * 0.5 : nonTribes * 0.25;
      if (alliances.alliesOf(other).length >= cap) return false;
    }

    // A genuine threat is worth appeasing — each tier reads "threat" differently.
    if (this.isAlliancePartnerThreat(grid, other)) return true;

    // Grudges close the door outright.
    if (relations.tierOf(me, other) < RELATION_NEUTRAL) return false;

    // Standing goodwill mostly opens it (Hard/Impossible stay pickier).
    if (relations.tierOf(me, other) >= RELATION_FRIENDLY) {
      if (this.difficulty === "hard") return this.prng.nextInt(0, 100) >= 17;
      if (this.difficulty === "impossible") return this.prng.nextInt(0, 100) >= 33;
      return true;
    }

    if (this.hasEnoughAlliances(grid, other)) return false;

    // The early game is a honeymoon: most offers are welcome while the map is young.
    if (this.isEarlygame()) return true;

    return this.isSimilarlyStrong(grid, other);
  }

  private isAlliancePartnerThreat(grid: TerritoryGrid, other: PlayerId): boolean {
    const me = this.myPlayerId!;
    const myTroops = grid.troopsOf(me);
    const otherTroops = grid.troopsOf(other);
    switch (this.difficulty) {
      case "easy":
        return false; // too dumb to see threats
      case "medium":
        return otherTroops > myTroops * 2.5;
      case "hard":
        return otherTroops > myTroops && this.troopCapOf(grid, other) > this.troopCapOf(grid, me) * 2;
      case "impossible": {
        const moreTroops = otherTroops > myTroops * 1.5;
        const moreCap = otherTroops > myTroops && this.troopCapOf(grid, other) > this.troopCapOf(grid, me) * 1.5;
        const moreTiles = otherTroops > myTroops && grid.tileCountOf(other) > grid.tileCountOf(me) * 1.5;
        return moreTroops || moreCap || moreTiles;
      }
    }
  }

  private isEarlygame(): boolean {
    const tick = this.session!.peekTick();
    switch (this.difficulty) {
      case "easy":
        return tick < 3000 && this.prng.nextInt(0, 100) >= 10;
      case "medium":
        return tick < 1800 && this.prng.nextInt(0, 100) >= 30;
      case "hard":
        return tick < 1800 && this.prng.nextInt(0, 100) >= 50;
      case "impossible":
        return tick < 600 && this.prng.nextInt(0, 100) >= 70;
    }
  }

  private hasEnoughAlliances(grid: TerritoryGrid, other: PlayerId): boolean {
    const me = this.myPlayerId!;
    const alliances = this.session!.peekAlliances();
    const count = alliances.alliesOf(me).length;
    switch (this.difficulty) {
      case "easy":
        return false; // an Easy nation never turns down company
      case "medium":
        return count >= this.prng.nextInt(4, 6);
      case "hard":
      case "impossible": {
        // Keep at least one non-friendly neighbour when there are 2+ of them.
        const bordering = this.frontier(grid)
          .filter((t) => t.target !== NEUTRAL_PLAYER && this.kindOf.get(t.target) !== "bot")
          .map((t) => t.target);
        const borderingFriends = bordering.filter((id) => alliances.areAllied(me, id));
        if (bordering.length >= 2 && bordering.includes(other)) {
          return bordering.length <= borderingFriends.length + 1;
        }
        return count >= (this.difficulty === "hard" ? this.prng.nextInt(3, 5) : this.prng.nextInt(2, 4));
      }
    }
  }

  private isSimilarlyStrong(grid: TerritoryGrid, other: PlayerId): boolean {
    const me = this.myPlayerId!;
    const session = this.session!;
    const troopBand: Record<RasterDifficulty, readonly [number, number]> = {
      easy: [60, 70],
      medium: [70, 80],
      hard: [75, 85],
      impossible: [80, 90],
    };
    const tileBand: Record<RasterDifficulty, readonly [number, number]> = {
      easy: [70, 80],
      medium: [80, 90],
      hard: [85, 95],
      impossible: [90, 100],
    };
    const myTotal = grid.troopsOf(me) + session.peekOutgoingAttackTroops(me);
    const otherTotal = grid.troopsOf(other) + session.peekOutgoingAttackTroops(other);
    const troopThreshold = myTotal * (this.prng.nextInt(...troopBand[this.difficulty]) / 100);
    const tileThreshold = grid.tileCountOf(me) * (this.prng.nextInt(...tileBand[this.difficulty]) / 100);
    const comparableTroops = otherTotal > troopThreshold;
    const comparableTiles = grid.tileCountOf(other) > tileThreshold && otherTotal > myTotal * 0.5;
    return comparableTroops || comparableTiles;
  }

  /**
   * Embargo automation (OpenFront's NationExecution): a hostile rival is cut
   * off from trade; the embargo lifts once tempers cool to neutral — but Hard
   * holds it until *friendly*, and Impossible never forgives at all.
   */
  private handleEmbargoes(grid: TerritoryGrid): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    const alliances = session.peekAlliances();
    const relations = session.peekRelations();
    for (const other of grid.players()) {
      if (other === me || grid.tileCountOf(other) === 0) continue;
      const tier = relations.tierOf(me, other);
      const embargoed = alliances.hasEmbargo(me, other);
      if (tier <= RELATION_HOSTILE && !embargoed) {
        session.setEmbargo(this.config.botId, other, true);
      } else if (
        embargoed &&
        ((tier >= RELATION_NEUTRAL && this.difficulty !== "hard" && this.difficulty !== "impossible") ||
          (tier >= RELATION_FRIENDLY && this.difficulty !== "impossible"))
      ) {
        session.setEmbargo(this.config.botId, other, false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Nation structures — OpenFront's NationStructureBehavior (ratio system).
  // -------------------------------------------------------------------------

  private handleStructures(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId!;
    if (grid.tileCountOf(me) === 0) return;

    // Reactive defense posts run outside the normal pacing: when incoming land
    // attacks reach 35% of our pool, forts go up near the pressed border —
    // never on Easy; Medium manages one post half the time; Hard/Impossible
    // one per 40% of the incoming ratio.
    if (this.placements > 0 && this.tryBuildDefensePost(grid, map)) return;
    if (this.defensePostNeeded(grid)) return; // hold other spending while the wall is due

    if (this.doHandleStructures(grid, map)) this.placements += 1;
  }

  private incomingLandRatio(grid: TerritoryGrid): number {
    const me = this.myPlayerId!;
    const myTroops = grid.troopsOf(me);
    if (myTroops <= 0) return 0;
    const incoming = this.session!.peekIncomingAttacks(me).reduce((s, a) => s + a.troops, 0);
    return incoming / myTroops;
  }

  private defensePostNeeded(grid: TerritoryGrid): boolean {
    if (this.difficulty === "easy") return false;
    return this.incomingLandRatio(grid) >= UNDER_ATTACK_THREAT_RATIO;
  }

  private tryBuildDefensePost(grid: TerritoryGrid, map: GameMap): boolean {
    if (this.difficulty === "easy") return false;
    if (this.difficulty === "medium" && !this.prng.chance(2)) return false;
    const ratio = this.incomingLandRatio(grid);
    if (ratio < UNDER_ATTACK_THREAT_RATIO) return false;
    const allowed = this.difficulty === "medium" ? 1 : Math.ceil(ratio / DEFENSE_POST_RATIO_PER_POST);
    const me = this.myPlayerId!;
    if (grid.buildingCountOf(me, "fort") >= allowed) return false;

    // Place near the border pressed by an attacker.
    const session = this.session!;
    const attackers = new Set(session.peekIncomingAttacks(me).map((a) => a.attacker));
    const fronts = this.frontier(grid).filter((t) => attackers.has(t.target));
    if (fronts.length === 0) return false;
    const samples = fronts.map((t) => [map.x(t.sample), map.y(t.sample)] as const);
    const nearFront = (ref: TileRef): boolean => {
      const x = map.x(ref);
      const y = map.y(ref);
      return samples.some(([sx, sy]) => Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= FORT_BORDER_RANGE);
    };
    return this.tryQueueBuild(grid, map, "fort", nearFront, allowed);
  }

  private doHandleStructures(grid: TerritoryGrid, map: GameMap): boolean {
    const me = this.myPlayerId!;
    const cities = grid.buildingCountOf(me, "city");

    // Non-city structures follow their per-city ratios, in priority order.
    const order: Array<{ type: BuildingType; ratio: number }> = [
      { type: "port", ratio: PORT_RATIO },
      { type: "factory", ratio: FACTORY_RATIO * (grid.buildingCountOf(me, "port") > 0 ? FACTORY_COASTAL_MULTIPLIER : 1) },
      { type: "sam", ratio: SAM_RATIO[this.difficulty] },
      { type: "silo", ratio: grid.buildingCountOf(me, "silo") === 0 ? FIRST_SILO_RATIO : SILO_RATIO },
    ];
    for (const { type, ratio } of order) {
      const owned = grid.buildingCountOf(me, type);
      if (type === "silo" && owned >= MAX_MISSILE_SILOS) continue;
      if (owned >= Math.floor(cities * ratio)) continue;
      if (this.maybeSpawnStructure(grid, map, type)) return true;
    }

    // Cities are the default gold sink.
    return this.maybeSpawnStructure(grid, map, "city");
  }

  /**
   * Buy one structure of `type` if the *perceived* price clears: while the
   * treasury is still short of the warhead stockpile target, each owned
   * structure of a type inflates the next one's felt cost, so nations
   * organically save toward their nuclear programme (OpenFront's perceived
   * costs). Above the structure-density threshold, upgrade instead of build.
   */
  private maybeSpawnStructure(grid: TerritoryGrid, map: GameMap, type: BuildingType): boolean {
    const me = this.myPlayerId!;
    const owned = grid.buildingCountOf(me, type);
    const realCost = this.nextBuildCost(grid, me, type);
    let perceived = realCost;
    if (grid.goldOf(me) < this.saveUpTarget(grid, me)) {
      const inflate = PERCEIVED_COST_INCREASE[type] ?? 0.1;
      perceived = Math.ceil(realCost * (1 + inflate * owned));
    }
    if (grid.goldOf(me) < perceived) return false;

    // Dense territory: climb levels instead of carpeting tiles.
    let structures = 0;
    for (const [ref] of grid.buildingEntries()) if (grid.ownerOf(ref) === me) structures += 1;
    if (
      structures / Math.max(1, grid.tileCountOf(me)) > UPGRADE_DENSITY_THRESHOLD &&
      (UPGRADABLE_BUILDING_TYPES as readonly BuildingType[]).includes(type)
    ) {
      if (this.tryQueueUpgrade(grid, map, type)) return true;
      if (owned > 0) return false;
      // No structure of the type yet — fall through and place the first one.
    }

    const eligible = this.eligibilityFor(grid, map, type);
    return this.tryQueueBuild(grid, map, type, eligible);
  }

  /** Placement predicate per type (shore for ports, rail-served for factories). */
  private eligibilityFor(grid: TerritoryGrid, map: GameMap, type: BuildingType): (ref: TileRef) => boolean {
    if (type === "port") return (ref) => map.isShore(ref);
    if (type === "factory") {
      const me = this.myPlayerId!;
      const stations: Array<readonly [number, number]> = [];
      for (const [ref, t] of grid.buildingEntries()) {
        if ((t === "city" || t === "port") && grid.ownerOf(ref) === me) {
          stations.push([map.x(ref), map.y(ref)] as const);
        }
      }
      const minSq = RAIL_STATION_MIN_RANGE * RAIL_STATION_MIN_RANGE;
      const maxSq = RAIL_STATION_MAX_RANGE * RAIL_STATION_MAX_RANGE;
      return (ref) => {
        const x = map.x(ref);
        const y = map.y(ref);
        return stations.some(([sx, sy]) => {
          const dSq = (sx - x) * (sx - x) + (sy - y) * (sy - y);
          return dSq >= minSq && dSq <= maxSq;
        });
      };
    }
    return () => true;
  }

  /**
   * The stockpile the treasury aims for before spending freely: a MIRV plus a
   * hydrogen bomb (OpenFront's FFA save-up target). While short of it,
   * perceived structure costs inflate.
   */
  private saveUpTarget(grid: TerritoryGrid, me: PlayerId): number {
    const silos = grid.buildingCountOf(me, "silo");
    return nukeCost("mirv", silos) + nukeCost("hydrogen", silos);
  }

  /** The next ramp price of `type` for this bot (cost group's summed levels). */
  private nextBuildCost(grid: TerritoryGrid, me: PlayerId, type: BuildingType): number {
    const ramp = costCounterTypes(type).reduce((sum, t) => sum + grid.totalLevelsOf(me, t), 0);
    return buildingCost(type, ramp);
  }

  /**
   * Queue a build of `type` on the lowest-`TileRef` owned, unbuilt, `eligible`
   * tile that honours structure spacing. Deterministic (replays identical).
   */
  private tryQueueBuild(
    grid: TerritoryGrid,
    map: GameMap,
    type: BuildingType,
    eligible: (ref: TileRef) => boolean,
    cap = Number.POSITIVE_INFINITY,
  ): boolean {
    const me = this.myPlayerId!;
    const session = this.session;
    if (!session) return false;
    if (grid.buildingCountOf(me, type) >= cap) return false;
    if (grid.goldOf(me) < this.nextBuildCost(grid, me, type)) return false;

    const mine: Array<[number, number]> = [];
    for (const [ref] of grid.buildingEntries()) {
      if (grid.ownerOf(ref) === me) mine.push([map.x(ref), map.y(ref)]);
    }
    const minSq = STRUCTURE_MIN_DIST * STRUCTURE_MIN_DIST;

    for (const ref of grid.tilesOf(me)) {
      if (grid.hasBuilding(ref) || !eligible(ref)) continue;
      const x = map.x(ref);
      const y = map.y(ref);
      if (mine.some(([bx, by]) => (bx - x) * (bx - x) + (by - y) * (by - y) < minSq)) continue;
      session.queueBuild(this.config.botId, { targetX: x, targetY: y, building: type });
      return true;
    }
    return false;
  }

  /** Queue an upgrade of the lowest-ref finished `type` structure, if affordable. */
  private tryQueueUpgrade(grid: TerritoryGrid, map: GameMap, type: BuildingType): boolean {
    const me = this.myPlayerId!;
    const session = this.session;
    if (!session) return false;
    if (grid.goldOf(me) < this.nextBuildCost(grid, me, type)) return false;
    for (const [ref, t] of grid.buildingEntries()) {
      if (t !== type || grid.ownerOf(ref) !== me || grid.isUnderConstruction(ref)) continue;
      session.queueBuild(this.config.botId, { targetX: map.x(ref), targetY: map.y(ref), building: type });
      return true;
    }
    return false;
  }

  /**
   * A nation floats at most ONE patrol warship, checked at 1-in-50 odds per
   * decision (OpenFront's maybeSpawnWarship) — the patrol point is the water
   * off one of its ports.
   */
  private maybeSpawnWarship(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    if (!this.prng.chance(50)) return;
    if (grid.buildingCountOf(me, "port") === 0) return;
    if (session.peekWarshipCount(me) > 0) return;
    if (grid.goldOf(me) < buildingCost("warship", 0)) return;
    for (const [ref, type] of grid.activeBuildingEntries()) {
      if (type !== "port" || grid.ownerOf(ref) !== me) continue;
      for (const n of map.neighbors(ref)) {
        if (!map.isWater(n)) continue;
        session.queueBuild(this.config.botId, { targetX: map.x(n), targetY: map.y(n), building: "warship" });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Nation nukes — OpenFront's NationNukeBehavior (targeting + save-up pacing).
  // -------------------------------------------------------------------------

  private maybeSendNuke(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId!;
    const session = this.session!;
    if (grid.activeLevelsOf(me, "silo") === 0) return;

    const target = this.findBestNukeTarget(grid);
    if (target === null) return;
    // Never a tribe (a warhead on a map-filler is a waste), never an ally, and
    // the anti-human throttle applies to the button that hurts most too.
    if (this.kindOf.get(target) === "bot") return;
    if (session.peekAlliances().areAllied(me, target)) return;
    if (!this.shouldAttack(target)) return;

    const silos = grid.buildingCountOf(me, "silo");
    const gold = grid.goldOf(me);
    let kind: NukeKind;
    if (gold >= this.perceivedNukeCost(grid, "hydrogen", silos)) {
      kind = "hydrogen";
    } else if (
      (!this.isHydroNation || this.isUnderHeavyAttack(grid)) &&
      gold >= this.perceivedNukeCost(grid, "atom", silos)
    ) {
      kind = "atom";
    } else {
      return;
    }

    const aim = this.pickNukeAim(grid, map, target);
    if (aim === null) return;
    session.queueNuke(this.config.botId, { targetX: map.x(aim), targetY: map.y(aim), kind });
    // Launching inflates the next warhead's felt price (atom ×1.5, hydrogen
    // ×1.25) — the simulated saving-for-a-MIRV that stops atom spam.
    if (kind === "atom") this.atomPerceivedCost = Math.ceil(this.atomPerceivedCost * 1.5);
    else this.hydroPerceivedCost = Math.ceil(this.hydroPerceivedCost * 1.25);
  }

  /** OpenFront's nuke target priorities, top first. */
  private findBestNukeTarget(grid: TerritoryGrid): PlayerId | null {
    const me = this.myPlayerId!;
    const session = this.session!;
    const relations = session.peekRelations();
    const alliances = session.peekAlliances();
    const living = grid.players().filter((p) => grid.tileCountOf(p) > 0);

    // Hard/Impossible endgame: two players left → the other one.
    if ((this.difficulty === "hard" || this.difficulty === "impossible") && living.length === 2) {
      const other = living.find((p) => p !== me);
      if (other !== undefined) return other;
    }

    // Retaliation is the lead trigger.
    const attacker = this.findIncomingAttacker(grid);
    if (attacker !== null) return attacker;

    // Impossible + FFA: decapitate a >50%-of-the-map crown outright.
    const cleanLand = Math.max(1, grid.capturableCount - grid.falloutCount);
    if (this.difficulty === "impossible") {
      const crown = [...living].sort((a, b) => grid.tileCountOf(b) - grid.tileCountOf(a))[0];
      if (crown !== undefined && crown !== me && !alliances.areAllied(me, crown)) {
        if (grid.tileCountOf(crown) / cleanLand > 0.5) return crown;
      }
    }

    // An ally's painted target is our target.
    for (const req of alliances.targetRequestsFor(me)) {
      if (relations.tierOf(me, req.from) < RELATION_FRIENDLY) continue;
      if (req.target === me || alliances.areAllied(me, req.target)) continue;
      if (grid.tileCountOf(req.target) > 0) return req.target;
    }

    // The most hated player — unless they're already so weak the army handles it.
    for (const entry of relations.sortedOf(me)) {
      if (entry.tier !== RELATION_HOSTILE) continue;
      const other = entry.other;
      if (!grid.hasPlayer(other) || grid.tileCountOf(other) === 0) continue;
      if (alliances.areAllied(me, other)) continue;
      if (this.troopCapOf(grid, me) >= this.troopCapOf(grid, other) * 2) continue;
      return other;
    }

    // The FFA crown, once its lead over us passes the difficulty threshold.
    const sorted = [...living].sort((a, b) => grid.tileCountOf(b) - grid.tileCountOf(a));
    const crown = sorted[0];
    if (crown !== undefined) {
      if (this.difficulty === "impossible" && crown === me && sorted.length >= 2) {
        const second = sorted[1];
        if (!alliances.areAllied(me, second)) return second;
      }
      if (crown !== me && !alliances.areAllied(me, crown)) {
        const lead = grid.tileCountOf(crown) / cleanLand - grid.tileCountOf(me) / cleanLand;
        const threshold =
          this.difficulty === "easy" ? 0.4 : this.difficulty === "medium" ? 0.3 : this.difficulty === "hard" ? 0.2 : 0.1;
        if (lead > threshold) return crown;
      }
    }
    return null;
  }

  private isUnderHeavyAttack(grid: TerritoryGrid): boolean {
    const me = this.myPlayerId!;
    const incoming = this.session!.peekIncomingAttacks(me).reduce((s, a) => s + a.troops, 0);
    return incoming >= grid.troopsOf(me);
  }

  /**
   * The warhead's *felt* price while saving toward the MIRV+hydrogen stockpile
   * (real price once the stockpile is banked, only two players remain, or —
   * on Hard/Impossible — the nation is fighting for its life).
   */
  private perceivedNukeCost(grid: TerritoryGrid, kind: NukeKind, silos: number): number {
    const me = this.myPlayerId!;
    const real = nukeCost(kind, silos);
    const living = grid.players().filter((p) => grid.tileCountOf(p) > 0);
    if (living.length === 2) return real;
    if (grid.goldOf(me) > nukeCost("mirv", silos) + nukeCost("hydrogen", silos)) return real;
    if ((this.difficulty === "hard" || this.difficulty === "impossible") && this.isUnderHeavyAttack(grid)) return real;
    return kind === "atom" ? Math.max(real, this.atomPerceivedCost) : Math.max(real, this.hydroPerceivedCost);
  }

  /**
   * The tile the warhead aims at: a bounded, deterministic sample of the
   * victim's territory, preferring ground far from our shared border so the
   * fallout doesn't sterilise land we'd take next. (This engine's aiming —
   * OpenFront additionally scores structures and dodges SAM trajectories.)
   */
  private pickNukeAim(grid: TerritoryGrid, map: GameMap, target: PlayerId): TileRef | null {
    const me = this.myPlayerId!;
    const tiles = grid.tilesViewOf(target);
    const total = grid.tileCountOf(target);
    if (total === 0) return null;
    const front = this.frontier(grid).find((t) => t.target === target);
    const refX = front ? map.x(front.sample) : null;
    const refY = front ? map.y(front.sample) : null;

    const stride = Math.max(1, Math.floor(total / 64));
    let best: TileRef | null = null;
    let bestDist = -1;
    let i = 0;
    for (const ref of tiles) {
      if (i++ % stride !== 0) continue;
      if (refX === null || refY === null) return ref;
      const d = Math.max(Math.abs(map.x(ref) - refX), Math.abs(map.y(ref) - refY));
      if (d > bestDist) {
        bestDist = d;
        best = ref;
      }
    }
    return best;
  }
}
