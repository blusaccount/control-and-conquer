import type { RasterGameSession } from "./RasterGameSession.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "../Core/TerritoryGrid.js";
import { maxTroops } from "../Core/rasterCombatConfig.js";
import { ALLIANCE_RENEWAL_WINDOW_TICKS } from "../Core/alliances.js";
import {
  buildingCost,
  costCounterTypes,
  RAIL_STATION_MAX_RANGE,
  RAIL_STATION_MIN_RANGE,
  STRUCTURE_MIN_DIST,
  type BuildingType,
} from "../Core/buildings.js";
import { nukeCost, type NukeKind } from "../Core/nukes.js";
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
  /** Only attack an enemy when `myPool >= theirPool * this`. Lower = braver. */
  readonly attackPoolRatio: number;
  /** Tendency to strike a beatable enemy even while neutral land remains (0..1).
   * At >= 0.5 the bot opens a war the moment it holds a decisive edge. */
  readonly aggression: number;
}

/**
 * The most betrayals a nation forgives when weighing an alliance offer: anyone
 * who has broken more pacts than this is refused outright, whatever the
 * personality — a serial traitor's word is worthless. (Reputation heuristic of
 * our own; OpenFront tracks a public betrayal count but doesn't document how
 * its nations weigh it.)
 */
const NATION_BETRAYAL_TOLERANCE = 1;

// ---------------------------------------------------------------------------
// Nation military programme.
//
// OpenFront's nations run dedicated late-game behaviours (its
// NationStructureBehavior builds, NationWarshipBehavior floats patrols,
// NationNukeBehavior + retaliation lead its target list) — the exact triggers
// aren't publicly documented, so the gates below are our own readable
// adaptation of that arc: economy first, then border forts, a coastal patrol,
// a silo once the economy matures, warheads at threats, and SAM cover once
// bombs start flying. All deterministic (no RNG).
// ---------------------------------------------------------------------------

/** Defense posts a nation garrisons contested borders with. */
const FORT_CAP = 2;
/**
 * How close to a hostile border a fort must stand (Chebyshev tiles). Kept at
 * the structure-spacing distance so two forts fit around one contact point.
 */
const FORT_BORDER_RANGE = 15;
/** Base warship fleet for a coastal nation; aggressive admirals float one more. */
const WARSHIP_CAP_BASE = 1;
/** Base silo programme; the ruthless dig a second launch site. */
const SILO_CAP_BASE = 1;
/** SAM batteries a nation stands up once warheads are flying. */
const SAM_CAP = 1;
/** Don't spend a warhead on an empire smaller than this. */
const NUKE_MIN_TARGET_TILES = 25;
/** A bordering rival at this pool ratio over ours is a threat worth nuking. */
const NUKE_THREAT_RATIO = 1.2;
/** Rival tiles sampled when picking a warhead aim point (bounded for huge empires). */
const NUKE_AIM_SAMPLE_BUDGET = 64;

// Emoji indices into RASTER_EMOJIS (["👍","👎","😂","😡","🤝","🫡","💀","🔥"])
// that nations flash as contextual reactions.
const EMOJI_THUMBS_DOWN = 1;
const EMOJI_ANGRY = 3;
const EMOJI_HANDSHAKE = 4;

/**
 * Odds a Tribe opens an attack on a bordering rival on a decision with no
 * neutral land left, mirroring OpenFront's `TribeExecution`/`AiAttackBehavior`
 * odds (~1/3 against a non-ally). The attack itself is sized by the OpenFront
 * ratio model (see {@link attackSizeTroops}) — a real strike down to the
 * tribe's reserve, not a token poke — but it only comes once the tribe has
 * banked past its trigger ratio, so tribes are farmable most of the time and
 * dangerous in bursts.
 */
const TRIBE_POKE_ODDS = 1 / 3;

// ---------------------------------------------------------------------------
// OpenFront AI attack sizing (`AiAttackBehavior`, current upstream main).
//
// Both Tribes and Nations draw three per-seat ratios of their max population:
//   triggerRatio 50–60% — bank until the pool crosses this before opening a
//                          war (expansion into wilderness is exempt);
//   reserveRatio 30–40% — a war strike sends `troops − maxTroops·reserve`;
//   expandRatio  10–20% — a wilderness grab sends `troops − maxTroops·expand`
//                          (nearly the whole pool — the OpenFront land rush).
// Values are behaviour constants from the documented upstream behaviour, not
// ported code; per-seat variation comes from a deterministic hash, standing in
// for OpenFront's per-player seeded `nextInt` rolls.
// ---------------------------------------------------------------------------
export const AI_TRIGGER_RATIO: readonly [number, number] = [0.5, 0.6];
export const AI_RESERVE_RATIO: readonly [number, number] = [0.3, 0.4];
export const AI_EXPAND_RATIO: readonly [number, number] = [0.1, 0.2];

/** Deterministic per-seat ratio inside `[lo, hi]` (stand-in for OF's seeded nextInt). */
export const seatRatio = (playerId: number, salt: number, [lo, hi]: readonly [number, number]): number =>
  lo + hash01(playerId, salt) * (hi - lo);

// Hash salts separating the three per-seat ratio rolls (arbitrary, fixed).
const SALT_EXPAND = 101;
const SALT_RESERVE = 103;
const SALT_TRIGGER = 107;

/**
 * Cheap deterministic hash of two integers onto [0, 1) — the confusion roll.
 * No RNG anywhere in bot decisions, so identical (terrain, intents) replays
 * stay identical (same guarantee as the engine's fallout/SAM hashing).
 */
const hash01 = (a: number, b: number): number => {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * A spread of opponent archetypes. {@link MatchRegistry} hands these out in
 * order so a solo match fields a recognisable mix — a land-grabber, a warmonger,
 * a measured all-rounder, an opportunist and a turtle — rather than five clones.
 */
// Attack *sizing* is no longer a personality trait: every AI seat sends
// OpenFront's ratio-model strikes (see {@link AI_EXPAND_RATIO} etc.), exactly
// like upstream, where all nations share the same nextInt ratio ranges. What a
// personality still shapes is *when and whom* to fight (`aggression`,
// `attackPoolRatio`) and how often it acts. `decisionCooldownTicks` here is
// only a fallback — the seat loop overrides it with a per-seat
// `nationDecisionCadence` (Easy 65–100 … Impossible 30–50 ticks).
export const RASTER_BOT_PERSONALITIES: readonly RasterBotPersonality[] = [
  // Expander: races for neutral land to compound income, fights only when boxed in.
  { id: "expander", decisionCooldownTicks: 80, minPool: 5, attackPoolRatio: 1.5, aggression: 0.2 },
  // Aggressor: hunts the weakest neighbour early and commits harder to the kill.
  { id: "aggressor", decisionCooldownTicks: 55, minPool: 5, attackPoolRatio: 1.0, aggression: 0.9 },
  // Balanced: grabs land first, then turns on a clearly weaker rival.
  { id: "balanced", decisionCooldownTicks: 65, minPool: 8, attackPoolRatio: 1.25, aggression: 0.5 },
  // Opportunist: expands patiently but pounces on a lopsided advantage.
  { id: "opportunist", decisionCooldownTicks: 65, minPool: 6, attackPoolRatio: 1.4, aggression: 0.6 },
  // Turtle: banks a deep reserve, expands cautiously, rarely starts a war.
  { id: "turtle", decisionCooldownTicks: 90, minPool: 12, attackPoolRatio: 1.8, aggression: 0.15 },
];

/**
 * The passive **Bot** ("Tribe") personality: OpenFront's low-threat map
 * filler. It shares the universal OpenFront attack-ratio model (bank to the
 * trigger, strike down to the reserve, dump the pool into wilderness), grabs
 * neutral land cheaply (OpenFront's `mag/10`; see the Bot
 * `neutralCostMultiplier`) and picks fights only by odds, never by strategy.
 * Paired with `kind: "bot"` (see {@link RasterBotConfig.kind}), which
 * additionally skips building and always accepts alliance offers rather than
 * weighing them — see {@link RasterBotController.maybeBuild}/
 * {@link RasterBotController.manageDiplomacy}. `decisionCooldownTicks` is a
 * fallback — the seat loop overrides it with a per-seat `botDecisionCadence`
 * (OpenFront's `nextInt(40, 80)`).
 */
export const FILLER_PERSONALITY: RasterBotPersonality = {
  id: "filler",
  decisionCooldownTicks: 60,
  minPool: 20,
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
  /**
   * Chance per decision that this nation **misdirects** its move at a
   * different border target than the one it meant (OpenFront's "nation
   * confusion", 10%/5%/2.5%/0% by difficulty — see `NATION_CONFUSION_CHANCE`).
   * Rolled deterministically; 0/absent = never confused.
   */
  readonly confusionChance?: number;
  /**
   * Ticks to delay this seat's first decision, so a large field doesn't all
   * decide on tick 0 (a thundering herd). Spread deterministically per seat by
   * {@link seatPhaseOffset}; 0/absent = decide as soon as it has banked `minPool`.
   */
  readonly phaseOffset?: number;
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
  /** Latest attacker on this bot (0 = nobody yet), read off each snapshot — the retaliation target. */
  private lastAttackedBy = 0;
  /** True once any warhead has flown this match — the cue to stand up SAM cover. */
  private nukesSeen = false;
  /** Each seat's public player class, read off the snapshot (drives tribe-farming sizing). */
  private readonly kindOf = new Map<PlayerId, RasterPlayerKind>();

  /**
   * The bot reinvests in a city once it holds at least this much land — early
   * game it pours everything into expansion; a maturing empire banks gold into
   * structures that compound its economy.
   */
  private static readonly MIN_TILES_TO_BUILD = 8;

  public constructor(private readonly config: RasterBotConfig = DEFAULT_RASTER_BOT_CONFIG) {}

  public attach(session: RasterGameSession): () => void {
    this.session = session;
    // Seed the throttle so this seat's first decision fires after its
    // `phaseOffset` ticks rather than every seat firing on tick 0 (a thundering
    // herd on a crowded field). The throttle compares `tick - lastDecisionTick`.
    this.lastDecisionTick = -(this.config.phaseOffset ?? 0);
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
      this.lastAttackedBy = 0;
      this.nukesSeen = false;
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

    // Passive awareness runs on every snapshot (cheap), not just decision
    // ticks: who hit us last (the retaliation target) and whether any warhead
    // has flown yet this match (the cue to stand up SAM cover) — a short
    // flight between two throttled decisions must not go unnoticed.
    const mine = snapshot.players.find((p) => p.playerId === this.myPlayerId);
    if (mine) this.lastAttackedBy = mine.lastAttackedBy;
    if (!this.nukesSeen && (snapshot.nukes.length > 0 || snapshot.nukeDetonations.length > 0)) {
      this.nukesSeen = true;
    }
    // Public player classes (as in OpenFront's player overlay): a nation farms
    // a bordering tribe with a proportional strike rather than its full army.
    for (const p of snapshot.players) this.kindOf.set(p.playerId, p.kind);

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
    if (kind !== "bot") {
      this.maybeBuild(grid, map);
      // The nuclear programme: once a silo stands and the war chest covers a
      // warhead, a nation retaliates against its last attacker or deters the
      // biggest bordering threat — OpenFront's late-game nuclear exchanges.
      this.maybeNuke(grid, map);
    }

    // Diplomacy: answer pending offers, sue for peace with a dangerous rival, or
    // (for the ruthless) betray a pact that has boxed it in. One move per tick.
    // A Bot filler only ever does the first half of that — it auto-accepts
    // any offer and never proposes or betrays (OpenFront's Tribe "accepts
    // every incoming alliance request").
    this.manageDiplomacy(grid, kind);

    if (grid.troopsOf(this.myPlayerId) < this.config.personality.minPool) return;

    // Tribes and Nations decide differently: a Tribe is a busy little map-filler
    // (grab neutral land, else weakly poke a neighbour), a Nation plays the full
    // strategy game.
    if (kind === "bot") this.decideBot(grid, map);
    else this.decide(grid, map);
  }

  /**
   * Reinvest banked gold into one structure this decision. A coastal bot opens a
   * **port** first — a steady trade dividend that compounds its economy — then
   * arms up through the military ladder ({@link maybeBuildMilitary}), and pours
   * whatever the war chest doesn't claim into **cities**. At most one structure
   * per call so the bot doesn't dump its whole treasury at once. Deterministic
   * throughout (lowest-`TileRef` eligible tile).
   */
  private maybeBuild(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    if (me === null || !this.session) return;
    if (grid.tileCountOf(me) < RasterBotController.MIN_TILES_TO_BUILD) return;
    // One port for the coastal gold dividend, then the military ladder.
    if (this.tryQueueBuild(grid, map, "port", (ref) => map.isShore(ref), 1)) return;
    if (this.maybeBuildMilitary(grid, map)) return;
    // Everything below spends out of the surplus above the war chest: once the
    // nation is saving for a silo, its next warhead or SAM cover, civilian
    // spending never raids that reserve.
    const chest = this.warChest(grid, me);
    const canSpend = (type: BuildingType): boolean =>
      grid.goldOf(me) - this.nextBuildCost(grid, me, type) >= chest;
    // A second port compounds the trade dividend, but only out of the surplus —
    // unlike the factory it must never delay the silo programme.
    if (canSpend("port") && this.tryQueueBuild(grid, map, "port", (ref) => map.isShore(ref), 2)) return;
    // Cities are the default gold sink.
    if (!canSpend("city")) return;
    if (this.tryQueueBuild(grid, map, "city", () => true)) return;
    // No legal spot left for a fresh city (structure spacing) — sink the
    // surplus into **upgrading** one instead, so a boxed-in nation keeps
    // climbing the same cost ramp (OpenFront's structure upgrades).
    this.tryQueueUpgrade(grid, map, "city");
  }

  /**
   * Gold this nation keeps aside for its military programme instead of sinking
   * everything into cities: the next **silo** once the economy has matured
   * (two cities), then the next **warhead** once a silo stands. Zero while the
   * economy is still young, so the early build-up is untouched.
   */
  private warChest(grid: TerritoryGrid, me: PlayerId): number {
    if ((this.config.kind ?? "nation") !== "nation") return 0;
    if (grid.buildingCountOf(me, "city") < 2) return 0; // economy first
    const silos = grid.buildingCountOf(me, "silo");
    if (silos > 0) {
      // Reserve the next warhead — and, once bombs are flying and we still
      // have no cover, the SAM battery too (defence must outlast the urge to
      // fire every reload, or no nation would ever field one).
      let chest = nukeCost("atom", silos);
      if (this.nukesSeen && grid.buildingCountOf(me, "sam") < SAM_CAP) {
        chest += this.nextBuildCost(grid, me, "sam");
      }
      return chest;
    }
    const siloCap = SILO_CAP_BASE + (this.config.personality.aggression >= 0.9 ? 1 : 0);
    return silos < siloCap ? this.nextBuildCost(grid, me, "silo") : 0;
  }

  /**
   * One step of the build ladder, mirroring the arc of OpenFront's nation
   * behaviours: **forts** on contested borders, then the **train-and-trade
   * economy** (factory + second port) whose dividends bankroll everything
   * dearer, a **warship** patrol for a coastal nation, a **missile silo** once
   * the economy matures, and **SAM** cover once warheads are flying this
   * match. Economy comes first (nothing before the first city); at most one
   * order per decision. Returns whether a build was queued.
   */
  private maybeBuildMilitary(grid: TerritoryGrid, map: GameMap): boolean {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return false;
    const p = this.config.personality;
    const cities = grid.buildingCountOf(me, "city");
    if (cities < 1) return false; // the first city always precedes the army

    // 1) Defense posts where a non-allied rival presses our border.
    const alliances = session.peekAlliances();
    const hostiles = grid
      .frontierTargets(me)
      .filter((t) => t.target !== NEUTRAL_PLAYER && !alliances.areAllied(me, t.target));
    if (hostiles.length > 0) {
      const samples = hostiles.map((t) => [map.x(t.sample), map.y(t.sample)] as const);
      const nearHostileBorder = (ref: TileRef): boolean => {
        const x = map.x(ref);
        const y = map.y(ref);
        return samples.some(([sx, sy]) => Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= FORT_BORDER_RANGE);
      };
      if (this.tryQueueBuild(grid, map, "fort", nearHostileBorder, FORT_CAP)) return true;
    }

    if (cities < 2) return false; // the dearer tiers wait for a second city

    // 2) The train-and-trade economy that funds the arms race: one factory
    //    (its trains pay a steady gold dividend) and a second port (each trade
    //    arrival pays both endpoints). These are income *multipliers*, so they
    //    spend raw gold ahead of the war chest — a nation that saved for its
    //    silo on the flat trickle alone would never afford the warheads after.
    //    The factory must land where rails can actually serve it: a city/port
    //    becomes a station only within [RAIL_STATION_MIN_RANGE,
    //    RAIL_STATION_MAX_RANGE] straight-line tiles of the factory (see
    //    railNetwork) — anywhere else the factory would earn nothing.
    if (grid.buildingCountOf(me, "factory") < 1) {
      const stations: Array<readonly [number, number]> = [];
      for (const [ref, type] of grid.buildingEntries()) {
        if ((type === "city" || type === "port") && grid.ownerOf(ref) === me) {
          stations.push([map.x(ref), map.y(ref)] as const);
        }
      }
      const minSq = RAIL_STATION_MIN_RANGE * RAIL_STATION_MIN_RANGE;
      const maxSq = RAIL_STATION_MAX_RANGE * RAIL_STATION_MAX_RANGE;
      const railServed = (ref: TileRef): boolean => {
        const x = map.x(ref);
        const y = map.y(ref);
        return stations.some(([sx, sy]) => {
          const dSq = (sx - x) * (sx - x) + (sy - y) * (sy - y);
          return dSq >= minSq && dSq <= maxSq;
        });
      };
      if (this.tryQueueBuild(grid, map, "factory", railServed, 1)) return true;
    }

    // 3) A coastal nation floats a warship to patrol its waters.
    const warshipCap = WARSHIP_CAP_BASE + (p.aggression >= 0.6 ? 1 : 0);
    if (this.tryQueueBuild(grid, map, "warship", (ref) => map.isShore(ref), warshipCap)) return true;

    // 4) The silo — the war chest has been reserving for it (see warChest).
    const siloCap = SILO_CAP_BASE + (p.aggression >= 0.9 ? 1 : 0);
    if (this.tryQueueBuild(grid, map, "silo", () => true, siloCap)) return true;

    // 5) SAM cover, once anyone's warheads have flown this match.
    if (this.nukesSeen && this.tryQueueBuild(grid, map, "sam", () => true, SAM_CAP)) return true;

    return false;
  }

  /**
   * Launch a warhead when the programme is ready: an active silo, a war chest
   * that covers the bomb, and a target worth it — the **last attacker**
   * (retaliation, OpenFront's lead trigger), else the biggest **bordering
   * threat** (deterrence), else — for the ruthless — the run-away leader. The
   * aim point is picked deep in the victim's territory, away from our own
   * shared border, so the fallout doesn't poison the ground we'd take next.
   * The session still validates silo cooldown/gold, so a premature attempt is
   * merely rejected.
   */
  private maybeNuke(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    if (grid.activeLevelsOf(me, "silo") === 0) return; // no finished launch site
    const silos = grid.buildingCountOf(me, "silo");
    // The dearest warhead the treasury affords: hydrogen when rich, else atom.
    const kind: NukeKind = grid.goldOf(me) >= nukeCost("hydrogen", silos) ? "hydrogen" : "atom";
    if (grid.goldOf(me) < nukeCost(kind, silos)) return;
    // Defence before the next salvo: once bombs are flying and we still lack
    // SAM cover, hold fire until the treasury covers warhead + battery — the
    // build ladder stands the SAM up on the next decision, then firing resumes.
    if (this.nukesSeen && grid.buildingCountOf(me, "sam") < SAM_CAP) {
      if (grid.goldOf(me) < nukeCost(kind, silos) + this.nextBuildCost(grid, me, "sam")) return;
    }

    const target = this.pickNukeTarget(grid);
    if (target === null) return;
    const aim = this.pickNukeAim(grid, map, target);
    if (aim === null) return;
    session.queueNuke(this.config.botId, { targetX: map.x(aim), targetY: map.y(aim), kind });
  }

  /** The player this nation's next warhead goes to, or null when nobody deserves one. */
  private pickNukeTarget(grid: TerritoryGrid): PlayerId | null {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return null;
    const alliances = session.peekAlliances();
    const worthIt = (id: PlayerId): boolean =>
      id !== me &&
      id !== NEUTRAL_PLAYER &&
      grid.hasPlayer(id) &&
      grid.tileCountOf(id) >= NUKE_MIN_TARGET_TILES &&
      !alliances.areAllied(me, id);

    // 1) Retaliation: whoever hit us last eats the warhead.
    if (this.lastAttackedBy !== 0 && worthIt(this.lastAttackedBy)) return this.lastAttackedBy;

    // 2) The border war: the strongest non-allied rival pressing our border.
    //    A rival outgrowing our pool is a threat everyone deters; a mere war
    //    rival gets the warhead only from the aggressive half of the
    //    personalities — a turtle keeps its powder for real danger.
    const myPool = grid.troopsOf(me);
    let foe: PlayerId | null = null;
    let foePool = -1;
    for (const t of grid.frontierTargets(me)) {
      if (!worthIt(t.target)) continue;
      const pool = grid.troopsOf(t.target);
      if (pool > foePool) {
        foePool = pool;
        foe = t.target;
      }
    }
    if (foe !== null && (foePool >= myPool * NUKE_THREAT_RATIO || this.config.personality.aggression >= 0.5)) {
      return foe;
    }

    // 3) The ruthless also decapitate a run-away leader (bigger than us).
    if (this.config.personality.aggression >= 0.6) {
      const myTiles = grid.tileCountOf(me);
      let leader: PlayerId | null = null;
      let leaderTiles = myTiles;
      for (const id of grid.players()) {
        if (!worthIt(id)) continue;
        const tiles = grid.tileCountOf(id);
        if (tiles > leaderTiles) {
          leaderTiles = tiles;
          leader = id;
        }
      }
      return leader;
    }
    return null;
  }

  /**
   * The tile the warhead aims at: a bounded, deterministic sample of the
   * victim's territory, preferring ground **far from our shared border** so
   * the blast's fallout doesn't sterilise the land we would conquer next. When
   * the victim doesn't border us at all, any sampled tile serves.
   */
  private pickNukeAim(grid: TerritoryGrid, map: GameMap, target: PlayerId): TileRef | null {
    const me = this.myPlayerId;
    if (me === null) return null;
    const tiles = grid.tilesOf(target);
    const total = grid.tileCountOf(target);
    if (total === 0) return null;
    // Our reference point: the shared frontier toward the victim, if any.
    const front = grid.frontierTargets(me).find((t) => t.target === target);
    const refX = front ? map.x(front.sample) : null;
    const refY = front ? map.y(front.sample) : null;

    const stride = Math.max(1, Math.floor(total / NUKE_AIM_SAMPLE_BUDGET));
    let best: TileRef | null = null;
    let bestDist = -1;
    let i = 0;
    for (const ref of tiles) {
      if (i++ % stride !== 0) continue;
      if (refX === null || refY === null) return ref; // no shared border — any tile serves
      const d = Math.max(Math.abs(map.x(ref) - refX), Math.abs(map.y(ref) - refY));
      if (d > bestDist) {
        bestDist = d;
        best = ref;
      }
    }
    return best;
  }

  /**
   * Queue a build of `type` on the lowest-`TileRef` owned, unbuilt, `eligible`
   * tile that also honours the structure-spacing rule (so the order isn't
   * doomed to a server rejection), when the bot can afford its next one and
   * owns fewer than `cap` of the type. Returns whether an order was queued, so
   * the caller can fall through to the next building choice. Deterministic, so
   * replays stay identical.
   */
  /** The next ramp price of `type` for this bot (cost group's summed levels). */
  private nextBuildCost(grid: TerritoryGrid, me: PlayerId, type: BuildingType): number {
    const ramp = costCounterTypes(type).reduce((sum, t) => sum + grid.totalLevelsOf(me, t), 0);
    return buildingCost(type, ramp);
  }

  private tryQueueBuild(
    grid: TerritoryGrid,
    map: GameMap,
    type: BuildingType,
    eligible: (ref: TileRef) => boolean,
    cap = Number.POSITIVE_INFINITY,
  ): boolean {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return false;
    if (grid.buildingCountOf(me, type) >= cap) return false;
    if (grid.goldOf(me) < this.nextBuildCost(grid, me, type)) return false;

    // The bot's own structures, for the spacing check (a handful at most).
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

  /**
   * Queue an **upgrade** of the bot's lowest-`TileRef` finished `type`
   * structure (a build order on its own tile), when the next ramp step is
   * affordable. Returns whether an order was queued. Deterministic.
   */
  private tryQueueUpgrade(grid: TerritoryGrid, map: GameMap, type: BuildingType): boolean {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return false;
    if (grid.goldOf(me) < this.nextBuildCost(grid, me, type)) return false;
    for (const [ref, t] of grid.buildingEntries()) {
      if (t !== type || grid.ownerOf(ref) !== me || grid.isUnderConstruction(ref)) continue;
      session.queueBuild(this.config.botId, { targetX: map.x(ref), targetY: map.y(ref), building: type });
      return true;
    }
    return false;
  }

  /**
   * Run at most one diplomacy move per decision, in priority order:
   *  1. **Answer** the lowest-id pending alliance offer. Defensive personalities
   *     welcome any ally; aggressive ones accept only an offer from someone at
   *     least as strong (never a weakling they could simply eat). A nation
   *     refuses anyone who has betrayed more than {@link NATION_BETRAYAL_TOLERANCE}
   *     pacts — a serial traitor's word is worthless.
   *  2. **Renew** a pact inside its renewal window: tribes and defensive
   *     nations always vote to extend; aggressive ones only keep an ally still
   *     worth having (at least as strong as themselves).
   *  3. **Propose** peace to the strongest rival on its border that clearly
   *     outguns it — only defensive bots sue for peace, and only against a real
   *     threat.
   *  4. **Betray:** a ruthless bot hemmed in *only* by allies (no neutral land,
   *     no other rival to fight) turns on the weakest ally it decisively outguns
   *     rather than stagnate behind its own pacts.
   * A passive Bot filler (`kind: "bot"`) only ever does steps 1–2, and
   * unconditionally accepts/renews — OpenFront's Tribe welcomes every offer and
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
      const trusted = alliances.betrayalsOf(from) <= NATION_BETRAYAL_TOLERANCE;
      const accept =
        kind === "bot" || (trusted && (p.aggression < 0.5 || grid.troopsOf(from) >= myPool));
      session.respondAlliance(this.config.botId, from, accept);
      // React like an OpenFront nation: 🤝 on a new pact, 👎 on a snub. The
      // session rate-limits emoji, so this never spams.
      session.sendEmoji(this.config.botId, from, accept ? EMOJI_HANDSHAKE : EMOJI_THUMBS_DOWN);
      return;
    }

    // 2) Renew an expiring pact (one vote per decision, lowest ally id first).
    const now = session.peekTick();
    for (const ally of alliances.alliesOf(me)) {
      const left = alliances.ticksLeft(me, ally, now);
      if (left === null || left > ALLIANCE_RENEWAL_WINDOW_TICKS) continue;
      const wants = kind === "bot" || p.aggression < 0.5 || grid.troopsOf(ally) >= myPool;
      if (!wants || alliances.hasRenewVote(me, ally)) continue;
      session.renewAlliance(this.config.botId, ally);
      return;
    }
    if (kind === "bot") return;

    const bordering = grid.frontierTargets(me).filter((t) => t.target !== NEUTRAL_PLAYER);

    // 3) Defensive bots sue for peace with a clearly stronger bordering rival.
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

    // 4) Betrayal — only for the ruthless, and only when fully hemmed in by allies.
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
      if (prey !== null) {
        session.breakAlliance(this.config.botId, prey);
        session.sendEmoji(this.config.botId, prey, EMOJI_ANGRY); // 😡 at the ally it just stabbed
      }
    }
  }

  /** This seat's max troop pool (its territory-scaled, handicap-adjusted ceiling). */
  private troopCapOf(grid: TerritoryGrid, me: PlayerId): number {
    return (
      maxTroops(grid.tileCountOf(me), grid.activeLevelsOf(me, "city")) *
      grid.modifiersOf(me).troopCapMultiplier
    );
  }

  /**
   * OpenFront's AI attack sizing (`AiAttackBehavior.calculateAttackTroops`):
   * everything above `maxTroops × ratio` marches — the ratio names what stays
   * *home*, not what is sent. A wilderness grab keeps only the small
   * {@link AI_EXPAND_RATIO} (near-full commitment, the OpenFront land rush); a
   * war strike keeps the deeper {@link AI_RESERVE_RATIO}. Returns 0 when the
   * pool sits at or below the reserve (OpenFront skips the attack entirely).
   */
  private attackSizeTroops(grid: TerritoryGrid, me: PlayerId, ratio: readonly [number, number], salt: number): number {
    const reserve = this.troopCapOf(grid, me) * seatRatio(me, salt, ratio);
    return Math.max(0, Math.floor(grid.troopsOf(me) - reserve));
  }

  /** OpenFront's war gate: bank until the pool crosses `triggerRatio × maxTroops`. */
  private hasTriggerTroops(grid: TerritoryGrid, me: PlayerId): boolean {
    return grid.troopsOf(me) >= this.troopCapOf(grid, me) * seatRatio(me, SALT_TRIGGER, AI_TRIGGER_RATIO);
  }

  /**
   * A passive **Bot** (Tribe)'s move, mirroring OpenFront's current
   * `TribeExecution`/`AiAttackBehavior`: while **neutral** land borders it,
   * dump the pool (minus the small expand reserve) into the wilderness — the
   * early-game blanket. Once boxed in, **bank to the trigger ratio**, then
   * strike: first back at whoever attacked it last (OpenFront retaliates
   * against the largest incoming attack), else the weakest bordering non-ally
   * at ~1/3 odds — a real strike down to the war reserve, so tribes are
   * farmable between bursts but genuinely bite back.
   * Deterministic (the odds roll is a per-tick/-seat hash, no RNG).
   */
  private decideBot(grid: TerritoryGrid, map: GameMap): void {
    const me = this.myPlayerId;
    const session = this.session;
    if (me === null || !session) return;
    const alliances = session.peekAlliances();

    const targets = grid.frontierTargets(me);
    if (targets.length === 0) return;

    // Prefer cheap neutral land whenever it borders us (OpenFront's terraNullius
    // preference) — this is what makes tribes blanket the empty map so fast.
    const neutral = targets.find((t) => t.target === NEUTRAL_PLAYER) ?? null;
    if (neutral) {
      this.queueSizedAttack(grid, map, me, neutral.sample, AI_EXPAND_RATIO, SALT_EXPAND);
      return;
    }

    // No neutral land left: bank until the trigger ratio, then strike.
    if (!this.hasTriggerTroops(grid, me)) return;
    const enemies = targets.filter((t) => t.target !== NEUTRAL_PLAYER && !alliances.areAllied(me, t.target));
    if (enemies.length === 0) return;
    // Retaliation first (OpenFront answers the largest incoming attack), no
    // odds roll — someone is already on our soil.
    const retaliate = this.lastAttackedBy !== 0 ? enemies.find((e) => e.target === this.lastAttackedBy) : undefined;
    if (retaliate) {
      this.queueSizedAttack(grid, map, me, retaliate.sample, AI_RESERVE_RATIO, SALT_RESERVE);
      return;
    }
    // Otherwise open a fight only at OpenFront's ~1/3 odds per decision, on the
    // weakest bordering rival — a Tribe attacks by odds, not strategy.
    if (hash01(session.peekTick(), me) >= TRIBE_POKE_ODDS) return;
    const prey = enemies.reduce((a, b) => (grid.troopsOf(b.target) < grid.troopsOf(a.target) ? b : a));
    this.queueSizedAttack(grid, map, me, prey.sample, AI_RESERVE_RATIO, SALT_RESERVE);
  }

  /** Queue an OpenFront ratio-model strike toward `sample` (no-op when the pool is spent). */
  private queueSizedAttack(
    grid: TerritoryGrid,
    map: GameMap,
    me: PlayerId,
    sample: TileRef,
    ratio: readonly [number, number],
    salt: number,
  ): void {
    this.queueTroops(grid, map, me, sample, this.attackSizeTroops(grid, me, ratio, salt));
  }

  /** Queue an expand order committing `troops` toward `sample` (no-op below 1). */
  private queueTroops(grid: TerritoryGrid, map: GameMap, me: PlayerId, sample: TileRef, troops: number): void {
    const session = this.session;
    if (!session || troops < 1) return;
    const pool = grid.troopsOf(me);
    session.queueExpand(this.config.botId, {
      targetX: map.x(sample),
      targetY: map.y(sample),
      percent: Math.min(100, Math.max(1, Math.round((troops / Math.max(1, pool)) * 100))),
    });
  }

  /**
   * Troops a **war** strike on `target` commits, mirroring OpenFront's
   * `calculateAttackTroops`: normally everything above the war reserve; but a
   * *nation* attacking a *tribe* farms it proportionally
   * (`calculateBotAttackTroops`) — send `4× the tribe's pool`, capped by the
   * above-reserve budget, and skip entirely when the budget can't spare at
   * least `2×` (too weak a strike would just bleed). This is why OpenFront
   * nations graze on bots for the whole match instead of emptying their army
   * into every tribal border.
   */
  private warStrikeTroops(grid: TerritoryGrid, me: PlayerId, target: PlayerId): number {
    const budget = this.attackSizeTroops(grid, me, AI_RESERVE_RATIO, SALT_RESERVE);
    if ((this.config.kind ?? "nation") === "nation" && this.kindOf.get(target) === "bot") {
      const tribePool = Math.max(0, grid.troopsOf(target));
      const wanted = Math.floor(tribePool * 4);
      if (wanted <= budget) return wanted;
      return budget < tribePool * 2 ? 0 : budget;
    }
    return budget;
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

    // Honour an ally's target request (OpenFront): if an ally has asked us to
    // attack someone we border and can plausibly beat, oblige at once — a
    // nation is a helpful ally. Deterministic (lowest requester/target first).
    const requested = new Set(alliances.targetRequestsFor(me).map((r) => r.target));
    if (requested.size > 0) {
      const ask = enemies.find((e) => requested.has(e.target) && pool >= grid.troopsOf(e.target) * p.attackPoolRatio);
      if (ask) {
        this.queueTroops(grid, map, me, ask.sample, this.warStrikeTroops(grid, me, ask.target));
        return;
      }
    }

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
    /** The player a war strike aims at (drives OpenFront's tribe-farming sizing); null = wilderness grab. */
    let warTarget: PlayerId | null;
    // A "decisive" edge is well beyond the bare ratio — enough to be worth opening
    // a war over while cheap neutral land is still on the table.
    const decisive = beatable !== null && pool >= beatablePool * (p.attackPoolRatio + 0.5);
    // OpenFront's war gate: attacks on players wait until the pool has banked
    // past the seat's trigger ratio (expansion into wilderness is exempt) —
    // nations strike in deliberate, weighty pushes instead of a constant drip.
    const warReady = this.hasTriggerTroops(grid, me);

    if (beatable && warReady && (!neutral || (p.aggression >= 0.5 && decisive))) {
      sample = beatable.sample;
      warTarget = beatable.target;
    } else if (neutral) {
      sample = neutral.sample;
      warTarget = null;
    } else if (beatable && warReady) {
      // No neutral land and only this rival is beatable.
      sample = beatable.sample;
      warTarget = beatable.target;
    } else if (beatable) {
      // Boxed in with a beatable rival but still below the trigger — bank.
      return;
    } else {
      // Boxed in by stronger rivals only. Banking income is the right call —
      // unless the pool is saturating (capped at the territory-scaled ceiling),
      // in which case further income is lost, so spend down on the softest target.
      // With nothing left to fight (only allies or neutral-free borders), bank.
      if (enemies.length === 0) return;
      if (pool < this.troopCapOf(grid, me) * 0.9) return;
      const softest = enemies.reduce((a, b) => (grid.troopsOf(b.target) < grid.troopsOf(a.target) ? b : a));
      sample = softest.sample;
      warTarget = softest.target;
    }

    // Nation confusion (OpenFront): on lower difficulties a nation sometimes
    // misdirects its move at a *different* border target than the one it
    // meant — a readable mistake, not a random click. Candidates exclude
    // allies (the engine would just reject those); the roll and the pick are
    // deterministic (hashed tick × seat), so replays stay identical.
    const confusion = this.config.confusionChance ?? 0;
    if (confusion > 0 && hash01(session.peekTick(), me) < confusion) {
      const misdirects = targets.filter(
        (t) => t.sample !== sample && (t.target === NEUTRAL_PLAYER || !alliances.areAllied(me, t.target)),
      );
      if (misdirects.length > 0) {
        sample = misdirects[(session.peekTick() + me) % misdirects.length].sample;
      }
    }

    // OpenFront sizing: a war strike keeps the deep reserve at home (and farms
    // a tribe proportionally), a wilderness grab keeps only the small expand
    // reserve (near-full commitment). Sizing follows the *intended* target even
    // when confusion misdirected the click — the mistake is in the aim, not the
    // muster.
    if (warTarget !== null) {
      this.queueTroops(grid, map, me, sample, this.warStrikeTroops(grid, me, warTarget));
    } else {
      this.queueSizedAttack(grid, map, me, sample, AI_EXPAND_RATIO, SALT_EXPAND);
    }
  }
}
