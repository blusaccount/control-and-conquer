import { generateTerrain } from "../Core/terrainGenerator.js";
import { buildRealMap, getRealMap } from "../Core/realMaps.js";
import { NEUTRAL_PLAYER, TerritoryGrid, type PlayerId } from "../Core/TerritoryGrid.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { RasterConflict, type AttackIntent, type AttackRejectReason, type SeaAttackIntent } from "../Core/RasterConflict.js";
import { AllianceRegistry } from "../Core/alliances.js";
import type {
  RasterActionRejectedEvent,
  RasterAttackFront,
  RasterBuildIntent,
  RasterCrossing,
  RasterExpandIntent,
  RasterMatchEndReason,
  RasterNuke,
  RasterNukeDetonation,
  RasterNukeInterception,
  RasterNukeIntent,
  RasterRejectReason,
  RasterRail,
  RasterRunStats,
  RasterServerMessage,
  RasterShip,
  RasterTrade,
  RasterTrain,
  RasterWarship,
} from "../Core/types.js";
import { LAND_ATTACK_REACH, SPAWN_IMMUNITY_SECONDS, WIN_TILE_FRACTION } from "../Core/rasterCombatConfig.js";
import { NUKE_DEFS, nukeCost, SILO_RELOAD_TICKS, type NukeKind } from "../Core/nukes.js";
import { BUILDING_CONSTRUCTION_TICKS, BUILDING_DEFS, buildingCost, COASTAL_BUILDING_TYPES, COASTAL_SNAP_RADIUS, CONQUER_GOLD_FRACTION_AI, CONQUER_GOLD_FRACTION_HUMAN, costCounterTypes, STRUCTURE_MIN_DIST, UPGRADABLE_BUILDING_TYPES } from "../Core/buildings.js";
import { SIMULATION_TICK_RATE } from "./simulationConfig.js";
import { RASTER_EMOJIS, type RasterDifficulty } from "../Core/messages.js";
import { IDENTITY_MODIFIERS } from "../Core/playerModifiers.js";
import {
  BOT_GROWTH_MULTIPLIER,
  BOT_START_MANPOWER,
  BOT_TROOP_CAP_MULTIPLIER,
  MAX_FIELD,
  NATION_GROWTH_MULTIPLIER,
  NATION_START_MANPOWER,
  NATION_TROOP_CAP_MULTIPLIER,
  tribeName,
  type RasterPlayerKind,
} from "./botField.js";
import type { RasterMatchPhase } from "../Core/types.js";
import { attachOwnership, buildSharedSnapshot, encodeOwnerDelta, encodeOwners, encodeTerrain, type PlayerMeta } from "./rasterSerialization.js";
import type { RasterSnapshot } from "../Core/types.js";

/** Human-readable, correctly-articled label for an event-log line, e.g. "an Atom Bomb". */
const nukeLabel = (kind: NukeKind): string => `${NUKE_DEFS[kind].article} ${NUKE_DEFS[kind].name}`;

export type RasterMessageHandler = (message: RasterServerMessage) => void;

/** Subscriber-internal record: which player they are + whether they have the terrain yet. */
interface RasterSubscriber {
  clientId: string;
  playerId: PlayerId;
  send: RasterMessageHandler;
  /** False until the client has received a snapshot containing terrain bytes. */
  hasTerrain: boolean;
  /**
   * Whether this subscriber wants the ownership raster (terrain + owner deltas)
   * on the wire. Real clients render it, so `true`; server-side bots read engine
   * state directly and discard the wire ownership, so they subscribe with
   * `false` — skipping the per-tick, whole-map owner encoding that would
   * otherwise be paid once per bot and dominate the tick cost.
   */
  wantsRaster: boolean;
  /**
   * Which AI tier this player is (or `"human"` for a real client). Drives the
   * post-spawn handicaps (Bot: flat OpenFront filler numbers; Nation: the
   * per-difficulty handicaps; human: full strength) and the conquer bounty
   * (an AI's whole treasury is seized; a human's only half).
   */
  kind: RasterPlayerKind;
  /**
   * Per-subscriber owner baseline: the ownership raster this client last
   * received. Owner snapshots after the first are encoded as a delta against
   * this array, which is then advanced to match. `null` until the first
   * (full-owner) snapshot is sent. Always `null` for headless subscribers.
   */
  lastOwner: Uint16Array | null;
}

interface PendingExpand {
  clientId: string;
  intent: RasterExpandIntent;
}

interface PendingBuild {
  clientId: string;
  intent: RasterBuildIntent;
}

interface PendingNuke {
  clientId: string;
  intent: RasterNukeIntent;
}

const MAX_EVENTS = 10;

/** Minimum ticks between two emoji reactions from the same player (anti-spam). */
const EMOJI_COOLDOWN_TICKS = 10;
/** How long an emoji reaction floats before it is dropped from the snapshot (~2s at 10 TPS). */
const EMOJI_LIFETIME_TICKS = 20;

/**
 * Per-client cap on expand/build intents queued between ticks. A legitimate
 * player can't click faster than this in one ~100ms tick window; without a
 * cap, a client that floods CLIENT_RASTER_EXPAND/BUILD messages could grow
 * `pendingExpands`/`pendingBuilds` unboundedly before the next tick drains
 * them.
 */
const MAX_PENDING_PER_CLIENT = 16;

/**
 * Curated hex colours for the first players, indexed by playerId-1. Small games
 * read identically to before; ids past this list get a distinct generated hue
 * (see {@link colorForPlayer}) so the now much larger, OpenFront-style fields
 * stay legible instead of cycling a tiny palette.
 */
const PLAYER_COLORS: readonly string[] = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4",
  "#ec4899", "#84cc16", "#f97316", "#0ea5e9",
];

/**
 * Pick a colour for a player id. The curated palette covers the first nations;
 * beyond it we walk the hue wheel with the golden-angle so successive nations
 * land far apart in colour, keeping a crowded map readable without hand-listing
 * dozens of hex codes.
 */
const colorForPlayer = (id: PlayerId): string => {
  if (id - 1 < PLAYER_COLORS.length) return PLAYER_COLORS[id - 1];
  const hue = ((id - 1 - PLAYER_COLORS.length) * 137.508) % 360;
  // Alternate lightness so neighbouring generated hues never read as twins.
  const light = (id - PLAYER_COLORS.length) % 2 === 0 ? 55 : 42;
  return hslToHex(hue, 62, light);
};

/** Minimal HSL→hex (h in degrees, s/l in percent) for generated nation colours. */
const hslToHex = (h: number, s: number, l: number): string => {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

/**
 * Nation names, indexed by playerId-1. The first six keep the classic colour
 * names (so small games read identically); the rest are distinct so a crowded
 * map of many small nations stays legible. Length sets the player cap — kept
 * large so the bigger Earth maps can seat an OpenFront-style field of rivals.
 */
const NATION_NAMES: readonly string[] = [
  "Blue Empire", "Red Empire", "Green Empire", "Amber Empire", "Violet Empire", "Cyan Empire",
  "Iron Pact", "Sun Dominion", "Frost Clans", "Ember League", "Stone Republic", "Tide Union",
  "Ash Horde", "Dawn Coalition", "Storm Reach", "Ridge Confederacy", "Dust Khanate", "Reed Princes",
  "Granite Order", "Marsh Syndicate", "Cinder Tribes", "Vale Compact", "Salt Barony", "Pine Hegemony",
  "Wolf Banner", "Falcon State", "Boar Clans", "Serpent Cult", "Bear Holds", "Shark Fleet",
  "Crane Court", "Lynx Reach", "Onyx Pact", "Coral League", "Briar Clans", "Harbor Union",
  "Glass Dominion", "Thorn Reach", "Copper Court", "Mire Princes", "Slate Order", "Quartz Barony",
  "Raven Banner", "Otter State", "Bison Clans", "Viper Cult", "Moose Holds", "Orca Fleet",
];

/**
 * Maximum players a single session can seat — decoupled from the curated
 * {@link NATION_NAMES} list (Bot/Tribe seats draw procedural {@link tribeName}s,
 * so the field can far outgrow the name list). Sized to {@link MAX_FIELD} AI
 * plus headroom for human seats, so a crowded OpenFront-style world fits.
 */
const MAX_PLAYERS = MAX_FIELD + 8;

/**
 * Display name + colour for a player id. A Bot seat gets a procedural
 * two-word tribal name (see {@link tribeName}); a human or Nation seat draws
 * from the curated {@link NATION_NAMES} list (wrapping for ids beyond it).
 */
const metaForPlayer = (id: PlayerId, kind: RasterPlayerKind): { name: string; color: string } => ({
  name: kind === "bot" ? tribeName(id - 1) : NATION_NAMES[(id - 1) % NATION_NAMES.length],
  color: colorForPlayer(id),
});

export interface RasterGameSessionOptions {
  /** Width in tiles. Default 64. Ignored when `realMapId` is set. */
  width?: number;
  /** Height in tiles. Default 40. Ignored when `realMapId` is set. */
  height?: number;
  /** Integer seed for the terrain generator. Default uses a fixed seed. */
  seed?: number;
  /** Map name shown in the UI. Default "Procedural Continent". */
  mapName?: string;
  /** Starting troop pool every player begins with. Default 25 000 (OpenFront's
   * human start manpower). */
  startingTroops?: number;
  /**
   * When set to a known map id, the match runs on that map instead of
   * procedural terrain. Resolved against the hand-authored ASCII maps
   * (`realMaps`, e.g. `world`); unknown ids fall back to procedural generation.
   * Heightmap maps (e.g. `earth`) are **not** built here — the caller resolves
   * those via {@link resolveHeightmapSessionMap} and passes the result as
   * {@link prebuiltMap}, keeping this class free of the Node fs/zlib loaders.
   */
  realMapId?: string;
  /**
   * A fully built {@link GameMap} to run the match on, bypassing all built-in
   * map resolution. Used for heightmap maps (resolved server-side) and for a
   * browser Web Worker that builds its map from fetched terrain. Takes
   * precedence over `realMapId`, `width`/`height` and `seed`.
   */
  prebuiltMap?: GameMap;
  /**
   * Target width in tiles for heightmap maps (height is derived to keep a
   * geographic aspect ratio). Ignored for ASCII and procedural maps. `0` uses
   * the map's default size.
   */
  mapSize?: number;
  /**
   * Hard match length in ticks. When reached, the match ends on the time limit
   * and the territory leader wins. Defaults to `Infinity` — **no time limit**,
   * exactly like OpenFront, whose FFA runs until someone wins by domination.
   * Exposed so tests can run short matches.
   */
  maxDurationTicks?: number;
  /**
   * Length of the opening "start phase" in ticks. While it runs, every player
   * picks their start position and nobody can take territory or earn income —
   * the game (and the match clock) only begins once it elapses. `0` (the
   * default) skips the start phase entirely so the match is live from tick one;
   * the real game seats a 15-second phase via {@link MatchRegistry}.
   */
  spawnPhaseTicks?: number;
  /**
   * Difficulty of the AI nations, which scales their starting troops, population
   * ceiling and growth (OpenFront's per-difficulty nation handicaps). Has no
   * effect on the human player. Default `"medium"`.
   */
  difficulty?: RasterDifficulty;
}

const DEFAULT_OPTIONS: Required<Omit<RasterGameSessionOptions, "prebuiltMap">> = {
  width: 64,
  height: 40,
  seed: 1,
  mapName: "Procedural Continent",
  startingTroops: 25_000,
  realMapId: "",
  mapSize: 0,
  maxDurationTicks: Infinity,
  spawnPhaseTicks: 0,
  difficulty: "medium",
};

/**
 * A live raster (openfront-style) match.
 *
 * Wraps a generated `GameMap`, the mutable `TerritoryGrid`, and a
 * `RasterConflict` engine. Each `tick()` drains queued expand intents, advances
 * combat, and broadcasts a fresh `RasterSnapshot` to every subscriber.
 *
 * Determinism: the only inputs to the engine are the (player-supplied) intents
 * and the terrain that was generated once at construction from a fixed seed.
 * No `Math.random`, no `Date.now`.
 */
export class RasterGameSession {
  private readonly map: GameMap;
  private readonly grid: TerritoryGrid;
  /** Diplomacy state: who is allied, pending proposals, embargoes and target requests. */
  private readonly alliances = new AllianceRegistry();
  /** Live floating emoji reactions (sender, tile, emoji, spawn tick), aged out each tick. */
  private emojiReactions: Array<{ from: PlayerId; x: number; y: number; emoji: number; bornTick: number }> = [];
  /** Tick each player last flashed an emoji, for the per-sender rate limit. */
  private readonly lastEmojiTick = new Map<PlayerId, number>();
  private readonly conflict: RasterConflict;
  private readonly mapName: string;
  private readonly startingTroops: number;
  /** AI-nation difficulty (scales their start troops, cap and growth). */
  private readonly difficulty: RasterDifficulty;
  private readonly terrainHash: string;
  private readonly terrainBase64: string;
  private readonly playerMeta = new Map<PlayerId, PlayerMeta>();
  private readonly subscribers = new Map<string, RasterSubscriber>();
  private readonly pendingExpands: PendingExpand[] = [];
  private readonly pendingBuilds: PendingBuild[] = [];
  private readonly pendingNukes: PendingNuke[] = [];
  /** Tick (exclusive) each Missile Silo, keyed by tile, is ready to fire again. */
  private readonly siloReadyAt = new Map<TileRef, number>();
  private recentEvents: string[] = ["Match started."];
  /** Transport-ship landings from the most recent tick, broadcast for animation. */
  private lastCrossings: RasterCrossing[] = [];
  /** Transport ships in flight as of the most recent tick, broadcast for animation. */
  private lastShips: RasterShip[] = [];
  /** Live mobile warships as of the most recent tick, broadcast for animation. */
  private lastWarships: RasterWarship[] = [];
  /** Active land-attack fronts from the most recent tick, for on-map troop labels. */
  private lastFronts: RasterAttackFront[] = [];
  /** Auto-routed railroads as of the most recent tick, for the client to draw. */
  private lastRails: RasterRail[] = [];
  /** Trains riding the rails as of the most recent tick, for the client to draw. */
  private lastTrains: RasterTrain[] = [];
  /** Trade ships sailing between ports as of the most recent tick. */
  private lastTradeShips: RasterTrade[] = [];
  /** Warheads in flight as of the most recent tick, broadcast for animation. */
  private lastNukes: RasterNuke[] = [];
  /** Warhead detonations from the most recent tick, for the explosion flash. */
  private lastNukeDetonations: RasterNukeDetonation[] = [];
  /** Warhead interceptions from the most recent tick, for the interception flash. */
  private lastNukeInterceptions: RasterNukeInterception[] = [];
  /** Determines spawn placement: each new subscriber takes the next slot. */
  private nextPlayerId: PlayerId = 1;
  private matchEndedBroadcast = false;
  /**
   * The match's winner once decided, including a timeLimit finish (where
   * {@link RasterConflict.winner} itself stays null — only conquest sets it).
   * Snapshots use this so a spectating, previously-eliminated client's
   * winnerPlayerId poll (its only way to learn the match ended) also fires on
   * a timeLimit finish, not just conquest.
   */
  private finalWinnerId: PlayerId | null = null;
  /** Cached spawn tiles per player, chosen deterministically from the terrain. */
  private readonly spawnTiles: TileRef[] = [];
  /** Players wiped off the map — their entire territory has been captured. */
  private readonly eliminated = new Set<PlayerId>();
  /**
   * Last tile each living player was seen holding, refreshed at the start of
   * every tick. When a player is wiped out, whoever owns this tile afterwards is
   * the conqueror who took their final ground — so they can be credited with the
   * kill even though the eliminated player now holds nothing to inspect.
   */
  private readonly lastTileSeen = new Map<PlayerId, TileRef>();
  /** Hard tick budget for the run; the match ends on the time limit when hit. */
  private readonly maxDurationTicks: number;
  /**
   * Current match phase. The session opens in `spawn` (the start phase) when a
   * spawn-phase length is configured, then flips to `playing` once it elapses.
   * With no start phase configured it is `playing` from construction.
   */
  private phase: RasterMatchPhase;
  /** Total ticks the opening start phase lasts (0 = no start phase). */
  private readonly spawnPhaseTicks: number;
  /** Ticks elapsed in the start phase so far, counted only while `spawn`. */
  private spawnTicksElapsed = 0;
  /** Most tiles each player has held at any point — a run-stat. */
  private readonly peakTiles = new Map<PlayerId, number>();
  /** Nations each player has wiped out (eliminations they caused) — a run-stat. */
  private readonly kills = new Map<PlayerId, number>();
  /** Tick at which a player was eliminated, for their survival-time stat. */
  private readonly eliminationTick = new Map<PlayerId, number>();
  /**
   * Players already sent their personal end-of-run summary — either when they
   * were wiped off the map (a defeat screen the instant they die) or at the
   * overall match end. Guards against sending a second summary at match end to
   * someone who was already eliminated mid-match.
   */
  private readonly endedSent = new Set<PlayerId>();

  public constructor(options: RasterGameSessionOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    // Heightmap maps arrive pre-built via `prebuiltMap` (resolved server-side);
    // only ASCII real maps are resolved from an id here.
    const realMap = !options.prebuiltMap && opts.realMapId ? getRealMap(opts.realMapId) : undefined;
    // Prefer the map's own name unless the caller explicitly set one.
    this.mapName = options.mapName ?? (realMap ? realMap.name : opts.mapName);
    this.startingTroops = opts.startingTroops;
    this.difficulty = opts.difficulty;
    // `Infinity` (the default) means no time limit at all, as in OpenFront.
    this.maxDurationTicks = Number.isFinite(opts.maxDurationTicks)
      ? Math.max(1, Math.floor(opts.maxDurationTicks))
      : Infinity;
    this.spawnPhaseTicks = Math.max(0, Math.floor(opts.spawnPhaseTicks));
    this.phase = this.spawnPhaseTicks > 0 ? "spawn" : "playing";

    let map;
    if (options.prebuiltMap) {
      // A fully built map supplied by the caller — heightmap maps (resolved
      // server-side via `resolveHeightmapSessionMap`) and the browser worker's
      // fetched-terrain map both take this path. They always carry playable land.
      map = options.prebuiltMap;
    } else if (realMap) {
      // Real-world maps already guarantee playable land, so use them verbatim.
      map = buildRealMap(realMap);
    } else {
      // Generate terrain. Some (seed × dims) combinations produce a fully
      // water grid (especially small maps), which leaves no playable land.
      // Walk down seaLevel until at least 8% of tiles are passable land — that
      // floor guarantees both a spawn corner and room to expand.
      map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed });
      const minLand = Math.max(8, Math.floor(opts.width * opts.height * 0.08));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let landTiles = 0;
        for (let i = 0; i < map.terrain.length; i += 1) if (map.isLand(i) && !map.isImpassable(i)) landTiles += 1;
        if (landTiles >= minLand) break;
        const seaLevel = 0.5 - 0.1 * (attempt + 1);
        map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed, seaLevel });
      }
    }
    this.map = map;
    this.grid = new TerritoryGrid(this.map);
    this.conflict = new RasterConflict(this.grid, this.alliances);
    const { terrainBase64, terrainHash } = encodeTerrain(this.map);
    this.terrainBase64 = terrainBase64;
    this.terrainHash = terrainHash;
    this.spawnTiles = this.pickSpawnTiles();
  }

  /**
   * Pre-pick spawn tiles for up to PLAYER_PALETTE.length players.
   *
   * Spread them around the perimeter of the land mass so two players never
   * start touching each other. Deterministic: iterates ascending TileRef and
   * picks the most distant land tile from already-claimed spawns.
   */
  private pickSpawnTiles(): TileRef[] {
    const landTiles: TileRef[] = [];
    for (let ref = 0; ref < this.map.size; ref += 1) {
      if (this.map.isLand(ref) && !this.map.isImpassable(ref)) {
        landTiles.push(ref);
      }
    }
    if (landTiles.length === 0) {
      throw new Error("Generated terrain has no land tiles — cannot start raster match.");
    }

    // Farthest-point sampling over a strided subset of the land tiles. On big
    // maps the land array holds hundreds of thousands of tiles; scanning all of
    // them per spawn would be wasteful, so we cap the candidate pool with a
    // deterministic stride. The sampling still spreads spawns well because the
    // pool stays evenly distributed across the whole land mass. Distances use
    // squared magnitude (monotonic, so the argmax is identical to Euclidean).
    const MAX_CANDIDATES = 3000;
    const stride = Math.max(1, Math.floor(landTiles.length / MAX_CANDIDATES));
    const candidates: TileRef[] = [];
    for (let k = 0; k < landTiles.length; k += stride) candidates.push(landTiles[k]);

    // Farthest-point sampling, incremental so it stays O(players × candidates)
    // even for a crowded {@link MAX_FIELD} field: keep each candidate's squared
    // distance to its nearest chosen seat, and after adding a seat update only
    // against that new seat (one O(candidates) pass), then take the argmax.
    // (A naïve re-scan against every chosen seat would be O(players² × cands)
    // and stall tick 0 once the field grows past a few dozen.)
    const cx = candidates.map((c) => this.map.x(c));
    const cy = candidates.map((c) => this.map.y(c));
    const nearest = new Float64Array(candidates.length).fill(Infinity);
    const chosen: TileRef[] = [];
    const chosenSet = new Set<TileRef>();
    const addSeat = (ref: TileRef): void => {
      chosen.push(ref);
      chosenSet.add(ref);
      const sx = this.map.x(ref);
      const sy = this.map.y(ref);
      for (let i = 0; i < candidates.length; i += 1) {
        const dx = cx[i] - sx;
        const dy = cy[i] - sy;
        const d = dx * dx + dy * dy;
        if (d < nearest[i]) nearest[i] = d;
      }
    };
    // First spawn: the corner-most land tile (low x, low y).
    addSeat(landTiles[0]);
    while (chosen.length < MAX_PLAYERS) {
      let bestRef = -1;
      let bestScore = -1;
      for (let i = 0; i < candidates.length; i += 1) {
        if (chosenSet.has(candidates[i])) continue;
        if (nearest[i] > bestScore) {
          bestScore = nearest[i];
          bestRef = candidates[i];
        }
      }
      // No distinct candidate left (tiny map) — stop rather than duplicate spawns.
      if (bestRef < 0) break;
      addSeat(bestRef);
    }
    return chosen;
  }

  /**
   * Seat `clientId` as a new player. Returns an unsubscribe function, or `null`
   * if the session has already seated {@link MAX_PLAYERS} nations — callers must
   * check for `null` instead of assuming a seat is always available.
   */
  public subscribe(
    clientId: string,
    send: RasterMessageHandler,
    autoSpawn = true,
    wantsRaster = true,
    playerName?: string,
    kind: RasterPlayerKind = "human",
  ): (() => void) | null {
    if (this.nextPlayerId > MAX_PLAYERS) {
      return null;
    }
    const playerId = this.nextPlayerId;
    this.nextPlayerId += 1;
    const meta = metaForPlayer(playerId, kind);
    if (playerName) meta.name = playerName;
    this.playerMeta.set(playerId, meta);

    const subscriber: RasterSubscriber = {
      clientId,
      playerId,
      send,
      hasTerrain: false,
      wantsRaster,
      kind,
      lastOwner: null,
    };
    this.subscribers.set(clientId, subscriber);

    // Bots (and any auto-spawn caller) take their precomputed spawn immediately;
    // a human is left *unspawned* until they pick a start position via
    // {@link selectSpawn}, so the player chooses where their empire begins.
    if (autoSpawn) {
      const spawn = this.spawnTiles[playerId - 1] ?? this.firstFreeSpawn();
      if (spawn !== undefined) this.seatPlayer(playerId, spawn, kind);
    }

    send({
      type: "SERVER_RASTER_PLAYER_ASSIGNED",
      payload: { playerId, name: meta.name, color: meta.color },
    });
    // First snapshot includes the terrain so the client can paint the map.
    this.sendSnapshotTo(subscriber);

    return () => {
      this.subscribers.delete(clientId);
    };
  }

  /**
   * First open (neutral, capturable) land tile, used as a fallback spawn when a
   * precomputed spawn tile is exhausted (e.g. more bots than the spread sampler
   * placed on a small map). Returns undefined only if no open land remains.
   */
  private firstFreeSpawn(): TileRef | undefined {
    for (let ref = 0; ref < this.map.size; ref += 1) {
      if (this.grid.isCapturable(ref) && this.grid.ownerOf(ref) === NEUTRAL_PLAYER) return ref;
    }
    return undefined;
  }

  /**
   * Place a player on the map at `spawnRef`: their founding (and, at this
   * instant, only) tile. There is no capital — a nation is beaten only once its
   * whole territory is captured — so the spawn tile carries no special status.
   *
   * A **Nation** is seated with OpenFront's per-difficulty handicaps: a
   * smaller starting army, a lower population ceiling and slower growth, so
   * easier games field weaker rivals. A **Bot** filler instead takes
   * OpenFront's flat, difficulty-independent Tribe numbers. The human always
   * plays at full strength.
   */
  private seatPlayer(playerId: PlayerId, spawnRef: TileRef, kind: RasterPlayerKind = "human"): void {
    const startTroops =
      kind === "human" ? this.startingTroops : kind === "bot" ? BOT_START_MANPOWER : NATION_START_MANPOWER[this.difficulty];
    this.grid.addPlayer(playerId, startTroops);
    if (kind === "bot") {
      this.grid.setModifiers(playerId, {
        ...IDENTITY_MODIFIERS,
        income: BOT_GROWTH_MULTIPLIER,
        troopCapMultiplier: BOT_TROOP_CAP_MULTIPLIER,
        // OpenFront's Tribes claim neutral land at half cost (mag/10), so they
        // blanket the map's empty ground fast.
        neutralCostMultiplier: 0.5,
        // …and earn gold at half rate (goldAdditionRate: Bot base 50 vs 100).
        goldMultiplier: 0.5,
      });
    } else if (kind === "nation") {
      this.grid.setModifiers(playerId, {
        ...IDENTITY_MODIFIERS,
        income: NATION_GROWTH_MULTIPLIER[this.difficulty],
        troopCapMultiplier: NATION_TROOP_CAP_MULTIPLIER[this.difficulty],
      });
    }
    this.grid.claim(spawnRef, playerId);
    this.peakTiles.set(playerId, this.grid.tileCountOf(playerId));
    this.kills.set(playerId, 0);
  }

  /**
   * Move an already-seated player's founding tile to `ref`, releasing whatever
   * (single) tile they currently hold. Only meaningful during the start phase,
   * where a player owns nothing but their freshly picked spawn — it lets them
   * relocate their nation freely before the countdown elapses.
   */
  private moveSpawn(playerId: PlayerId, ref: TileRef): void {
    for (const old of this.grid.tilesOf(playerId)) this.grid.claim(old, NEUTRAL_PLAYER);
    this.grid.claim(ref, playerId);
    this.peakTiles.set(playerId, this.grid.tileCountOf(playerId));
  }

  /**
   * Seat a player at the tile they clicked, if it is open land. The map clicks
   * of a human's run during the start phase are spawn picks (OpenFront's "choose
   * a start position"): the first founds their nation and each later one
   * relocates it, so a player can flexibly move their spawn until the countdown
   * ends. Once the game is live and they hold ground, spawn picks are ignored.
   */
  public selectSpawn(clientId: string, x: number, y: number): void {
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber || this.matchEndedBroadcast) return;
    const playerId = subscriber.playerId;
    const alreadySpawned = this.grid.hasPlayer(playerId);
    // Re-picking is only allowed while the start phase runs; once territory is
    // live a player keeps the ground they hold.
    if (alreadySpawned && this.phase !== "spawn") return;

    const reject = (message: string): void =>
      subscriber.send({
        type: "SERVER_RASTER_ACTION_REJECTED",
        payload: {
          reason: "INVALID_TILE",
          message,
          intent: { targetX: Math.max(0, x | 0), targetY: Math.max(0, y | 0), percent: 50 },
        },
      });

    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.map.inBounds(x, y)) {
      reject("Pick a tile on the map to start on.");
      return;
    }
    const ref = this.map.ref(x, y);
    // Clicking your own current spawn is a harmless no-op rather than a rejection.
    if (alreadySpawned && this.grid.ownerOf(ref) === playerId) return;
    if (!this.grid.isCapturable(ref) || this.grid.ownerOf(ref) !== NEUTRAL_PLAYER) {
      reject("Choose open, unclaimed land for your start position.");
      return;
    }
    if (alreadySpawned) this.moveSpawn(playerId, ref);
    else this.seatPlayer(playerId, ref);
    // Push the seated state straight away so the client can zoom to the spawn
    // without waiting for the next tick.
    this.sendSnapshotTo(subscriber);
  }

  /**
   * End the start phase and begin the live game. Any subscriber who never picked
   * a start position (a human who sat out the countdown) is auto-seated at their
   * reserved spawn so they still drop into the match, and the phase flips to
   * `playing` so the next tick resolves combat. Idempotent in effect — only ever
   * called once, on the tick the countdown elapses.
   */
  private beginPlayingPhase(): void {
    for (const subscriber of this.subscribers.values()) {
      if (this.grid.hasPlayer(subscriber.playerId)) continue;
      const spawn = this.spawnTiles[subscriber.playerId - 1] ?? this.firstFreeSpawn();
      if (spawn !== undefined) this.seatPlayer(subscriber.playerId, spawn, subscriber.kind);
    }
    // Grant every seated nation a post-spawn immunity window so the opening of
    // the live game is a protected land-grab — nobody can be attacked until it
    // elapses, so a fresh spawn establishes a border before combat opens.
    const immunityTicks = Math.round(SPAWN_IMMUNITY_SECONDS * SIMULATION_TICK_RATE);
    for (const id of this.grid.players()) this.conflict.grantImmunity(id, immunityTicks);
    this.phase = "playing";
    this.recentEvents = ["The start phase is over — seize territory!", ...this.recentEvents].slice(0, MAX_EVENTS);
  }

  public queueExpand(clientId: string, intent: RasterExpandIntent): void {
    if (!this.subscribers.has(clientId)) return;
    const pending = this.pendingExpands.reduce((n, p) => (p.clientId === clientId ? n + 1 : n), 0);
    if (pending >= MAX_PENDING_PER_CLIENT) return;
    this.pendingExpands.push({ clientId, intent });
  }

  public queueBuild(clientId: string, intent: RasterBuildIntent): void {
    if (!this.subscribers.has(clientId)) return;
    const pending = this.pendingBuilds.reduce((n, p) => (p.clientId === clientId ? n + 1 : n), 0);
    if (pending >= MAX_PENDING_PER_CLIENT) return;
    this.pendingBuilds.push({ clientId, intent });
  }

  public queueNuke(clientId: string, intent: RasterNukeIntent): void {
    if (!this.subscribers.has(clientId)) return;
    const pending = this.pendingNukes.reduce((n, p) => (p.clientId === clientId ? n + 1 : n), 0);
    if (pending >= MAX_PENDING_PER_CLIENT) return;
    this.pendingNukes.push({ clientId, intent });
  }

  /** Prepend a line to the shared event log, trimmed to the most recent few. */
  private pushEvent(line: string): void {
    this.recentEvents = [line, ...this.recentEvents].slice(0, MAX_EVENTS);
  }

  /**
   * Resolve a diplomacy command's two parties: the sender (from their socket)
   * and the named counterparty. Returns `null` — silently dropping the command —
   * unless both are real, seated, living players and distinct from each other.
   * Diplomacy is settled the instant it is issued (unlike expand/build, which
   * queue for the next tick), so this runs synchronously off the message.
   */
  private resolveDiplomacy(clientId: string, targetId: PlayerId): PlayerId | null {
    if (this.matchEndedBroadcast) return null;
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber) return null;
    const me = subscriber.playerId;
    if (targetId === me) return null;
    if (!this.grid.hasPlayer(me) || this.eliminated.has(me)) return null;
    if (!this.grid.hasPlayer(targetId) || this.eliminated.has(targetId)) return null;
    return me;
  }

  /**
   * Offer an alliance to `targetId` on behalf of `clientId`. A crossing offer
   * (the target had already proposed to us) seals the pact at once; otherwise it
   * is parked pending their response. No-op on an invalid/dead counterparty or an
   * existing pact.
   */
  public proposeAlliance(clientId: string, targetId: PlayerId): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    const outcome = this.alliances.propose(me, targetId, this.conflict.tick);
    if (outcome === "proposed") {
      this.pushEvent(`${this.nameOf(me)} proposed an alliance to ${this.nameOf(targetId)}.`);
    } else if (outcome === "accepted") {
      this.pushEvent(`${this.nameOf(me)} and ${this.nameOf(targetId)} formed an alliance.`);
    }
  }

  /** Accept (`accept: true`) or decline a pending alliance offer from `targetId`. */
  public respondAlliance(clientId: string, targetId: PlayerId, accept: boolean): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    if (accept) {
      if (this.alliances.accept(me, targetId, this.conflict.tick)) {
        this.pushEvent(`${this.nameOf(me)} and ${this.nameOf(targetId)} formed an alliance.`);
      }
    } else if (this.alliances.decline(me, targetId)) {
      this.pushEvent(`${this.nameOf(me)} declined ${this.nameOf(targetId)}'s alliance offer.`);
    }
  }

  /**
   * Vote to renew the alliance with `targetId`. Both sides must vote; the
   * pact's clock restarts on the second vote (OpenFront's renewal prompt
   * shortly before an alliance lapses).
   */
  public renewAlliance(clientId: string, targetId: PlayerId): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    const outcome = this.alliances.voteRenew(me, targetId, this.conflict.tick);
    if (outcome === "voted") {
      this.pushEvent(`${this.nameOf(me)} wants to renew the alliance with ${this.nameOf(targetId)}.`);
    } else if (outcome === "renewed") {
      this.pushEvent(`${this.nameOf(me)} and ${this.nameOf(targetId)} renewed their alliance.`);
    }
  }

  /** Break an existing alliance with `targetId` — a betrayal, effective at once. */
  public breakAlliance(clientId: string, targetId: PlayerId): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    if (this.alliances.breakAlliance(me, targetId)) {
      // Betrayal marks the breaker a traitor: a temporary combat penalty
      // (OpenFront's traitor debuffs) — see RasterConflict.markTraitor. The
      // registry also auto-embargoes the wronged partner.
      this.conflict.markTraitor(me);
      this.pushEvent(`${this.nameOf(me)} betrayed their alliance with ${this.nameOf(targetId)}.`);
    }
  }

  /**
   * Donate `percent`% of your `resource` (troops or gold) to an **ally** —
   * OpenFront's ally donation. No-op unless the two are currently allied and
   * the amount rounds to at least 1. The donor's pool falls and the ally's
   * rises by the same integer amount.
   */
  public donate(clientId: string, targetId: PlayerId, resource: "troops" | "gold", percent: number): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    if (!this.alliances.areAllied(me, targetId)) return;
    const pct = Math.min(100, Math.max(1, Math.floor(percent)));
    if (resource === "troops") {
      const amount = Math.floor(this.grid.troopsOf(me) * (pct / 100));
      if (amount < 1) return;
      this.grid.addTroops(me, -amount);
      this.grid.addTroops(targetId, amount);
      this.pushEvent(`${this.nameOf(me)} sent ${amount} troops to ${this.nameOf(targetId)}.`);
    } else {
      const amount = Math.floor(this.grid.goldOf(me) * (pct / 100));
      if (amount < 1) return;
      this.grid.addGold(me, -amount);
      this.grid.addGold(targetId, amount);
      this.pushEvent(`${this.nameOf(me)} sent ${amount} gold to ${this.nameOf(targetId)}.`);
    }
  }

  /**
   * Manually retreat `clientId`'s active attack against `targetId` (0 =
   * neutral land) — OpenFront's ordered retreat. The engine refunds the
   * committed troops, taxed 25% when pulling off a player; an event line makes
   * the pull-back public, like every other combat action.
   */
  public retreat(clientId: string, targetId: PlayerId): void {
    if (this.matchEndedBroadcast) return;
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber) return;
    const me = subscriber.playerId;
    if (targetId === me) return;
    if (!this.grid.hasPlayer(me) || this.eliminated.has(me)) return;
    const refunded = this.conflict.orderRetreat(me, targetId);
    if (refunded === null) return;
    const targetName = targetId === NEUTRAL_PLAYER ? "neutral land" : this.nameOf(targetId);
    this.pushEvent(`${this.nameOf(me)} pulled its forces back from ${targetName}.`);
  }

  /** Set (`on: true`) or lift a trade embargo against `targetId`. */
  public setEmbargo(clientId: string, targetId: PlayerId, on: boolean): void {
    const me = this.resolveDiplomacy(clientId, targetId);
    if (me === null) return;
    if (on) {
      if (this.alliances.setEmbargo(me, targetId)) {
        this.pushEvent(`${this.nameOf(me)} placed a trade embargo on ${this.nameOf(targetId)}.`);
      }
    } else if (this.alliances.clearEmbargo(me, targetId)) {
      this.pushEvent(`${this.nameOf(me)} lifted its trade embargo on ${this.nameOf(targetId)}.`);
    }
  }

  /** Ask ally `allyId` to attack `targetId` — recorded and announced to the ally. */
  public requestTarget(clientId: string, allyId: PlayerId, targetId: PlayerId): void {
    const me = this.resolveDiplomacy(clientId, allyId);
    if (me === null) return;
    if (!this.grid.hasPlayer(targetId) || this.eliminated.has(targetId)) return;
    if (this.alliances.requestTarget(me, allyId, targetId)) {
      this.pushEvent(`${this.nameOf(me)} asked ${this.nameOf(allyId)} to attack ${this.nameOf(targetId)}.`);
    }
  }

  /**
   * Flash an emoji reaction over `targetId`'s territory (or your own, for a
   * broadcast). Rate-limited per sender; purely cosmetic, so it never touches
   * the simulation — it rides the snapshot as a transient reaction that the
   * client floats and fades. Dropped silently when the sender is spamming.
   */
  public sendEmoji(clientId: string, targetId: PlayerId, emoji: number): void {
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber || this.matchEndedBroadcast) return;
    const me = subscriber.playerId;
    if (!this.grid.hasPlayer(me) || this.eliminated.has(me)) return;
    if (!this.grid.hasPlayer(targetId) || this.eliminated.has(targetId)) return;
    if (emoji < 0 || emoji >= RASTER_EMOJIS.length) return;
    // Rate-limit: at most one reaction per sender per EMOJI_COOLDOWN_TICKS.
    const last = this.lastEmojiTick.get(me);
    if (last !== undefined && this.conflict.tick - last < EMOJI_COOLDOWN_TICKS) return;
    this.lastEmojiTick.set(me, this.conflict.tick);
    // Float it over a tile of the reacted-to player (their land is the anchor).
    const anchor = this.grid.anyTileOf(targetId);
    if (anchor === undefined) return;
    this.emojiReactions.push({
      from: me,
      x: this.map.x(anchor),
      y: this.map.y(anchor),
      emoji,
      bornTick: this.conflict.tick,
    });
  }

  /**
   * Drive one simulation step: validate queued expands, convert valid ones into
   * `AttackIntent`s, advance the conflict engine, then broadcast snapshots.
   */
  public tick(): void {
    // Once the match has ended (conquest or time limit) the simulation freezes:
    // no further state changes or broadcasts.
    if (this.matchEndedBroadcast) return;

    // Start phase: players are still choosing where to found their nations. The
    // world is frozen — no expansion, combat, income or match clock — until the
    // countdown elapses. Any actions queued now (clients gate this, so this is a
    // safety net) are dropped rather than applied.
    if (this.phase === "spawn") {
      this.spawnTicksElapsed += 1;
      this.pendingExpands.length = 0;
      this.pendingBuilds.length = 0;
      this.pendingNukes.length = 0;
      if (this.spawnTicksElapsed < this.spawnPhaseTicks) {
        this.broadcastSnapshots();
        return;
      }
      // Countdown over: seat any no-shows and switch to the game phase, then fall
      // through to run this very tick as the first live one.
      this.beginPlayingPhase();
    }

    const intents: AttackIntent[] = [];
    const eventLines: string[] = [];
    const rejections: Array<{ clientId: string; rejection: RasterActionRejectedEvent }> = [];

    for (const pending of this.pendingExpands) {
      const subscriber = this.subscribers.get(pending.clientId);
      if (!subscriber) continue;
      const attacker = subscriber.playerId;
      const result = this.validateAndBuildIntent(attacker, pending.intent);
      if (result.kind === "rejected") {
        rejections.push({
          clientId: pending.clientId,
          rejection: { reason: result.reason, message: result.message, intent: pending.intent },
        });
      } else if (result.kind === "land") {
        intents.push(result.intent);
        eventLines.push(this.landEventLine(result.intent));
      } else {
        // Sea assault: dispatch a transport ship now (it persists across ticks).
        const reason = this.conflict.launchShip(result.intent);
        if (reason) {
          rejections.push({
            clientId: pending.clientId,
            rejection: { ...this.shipRejection(attacker, reason), intent: pending.intent },
          });
        } else {
          eventLines.push(this.shipEventLine(result.intent));
        }
      }
    }
    this.pendingExpands.length = 0;

    // Resolve queued build orders before combat advances, so a fort raised this
    // tick already fortifies the ground it stands on. Each spends gold and places
    // a structure, or is rejected (unaffordable, occupied, not your land).
    for (const pending of this.pendingBuilds) {
      const subscriber = this.subscribers.get(pending.clientId);
      if (!subscriber) continue;
      const result = this.processBuild(subscriber.playerId, pending.intent);
      if (result.kind === "rejected") {
        rejections.push({
          clientId: pending.clientId,
          rejection: { reason: result.reason, message: result.message, intent: pending.intent },
        });
      } else {
        eventLines.push(result.line);
      }
    }
    this.pendingBuilds.length = 0;

    // Resolve queued nuke launches the same way as builds: each spends gold and
    // reloads its silo, or is rejected (unaffordable, no ready silo, bad target).
    for (const pending of this.pendingNukes) {
      const subscriber = this.subscribers.get(pending.clientId);
      if (!subscriber) continue;
      const result = this.processNuke(subscriber.playerId, pending.intent);
      if (result.kind === "rejected") {
        rejections.push({
          clientId: pending.clientId,
          rejection: { reason: result.reason, message: result.message, intent: pending.intent },
        });
      } else {
        eventLines.push(result.line);
      }
    }
    this.pendingNukes.length = 0;

    // Sample one tile of each living player just before combat resolves, so the
    // conqueror who takes their last ground can be credited with the kill. O(players),
    // so it stays cheap even on million-tile maps.
    for (const id of this.grid.players()) {
      if (this.grid.tileCountOf(id) > 0) {
        const sample = this.grid.anyTileOf(id);
        if (sample !== undefined) this.lastTileSeen.set(id, sample);
      }
    }

    const tickResult = this.conflict.processTick(intents);

    // Track each player's peak territory for the run stats.
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      if (tiles > (this.peakTiles.get(id) ?? 0)) this.peakTiles.set(id, tiles);
    }

    // Convert this tick's transport-ship landings to wire coordinates for the
    // landing flash, and snapshot every ship still in flight for animation.
    this.lastCrossings = tickResult.crossings.map((c) => ({
      playerId: c.attacker,
      fromX: this.map.x(c.from),
      fromY: this.map.y(c.from),
      toX: this.map.x(c.to),
      toY: this.map.y(c.to),
    }));
    this.lastShips = this.conflict.activeShips().map((s) => ({
      shipId: s.id,
      playerId: s.attacker,
      x: this.map.x(s.tile),
      y: this.map.y(s.tile),
      troops: s.troops,
    }));
    this.lastWarships = this.conflict.activeWarships().map((w) => ({
      warshipId: w.id,
      playerId: w.owner,
      x: w.x,
      y: w.y,
      hp: w.hp,
      maxHp: w.maxHp,
      retreating: w.retreating,
    }));
    this.lastNukes = this.conflict.activeNukes().map((n) => ({
      nukeId: n.id,
      playerId: n.attacker,
      x: n.x,
      y: n.y,
      toX: n.toX,
      toY: n.toY,
      kind: n.kind,
    }));
    this.lastNukeDetonations = tickResult.nukeDetonations.map((d) => ({
      playerId: d.attacker,
      x: d.targetX,
      y: d.targetY,
      kind: d.kind,
    }));
    this.lastNukeInterceptions = tickResult.nukeInterceptions.map((i) => ({
      playerId: i.attacker,
      defenderId: i.defender,
      x: i.x,
      y: i.y,
    }));
    // A nuke that hits an ally severs the pact and marks the attacker a traitor,
    // exactly like breaking it from the diplomacy menu — nuking a friend is a
    // betrayal whichever button triggered it.
    for (const detonation of tickResult.nukeDetonations) {
      for (const victim of detonation.victims) {
        if (victim === detonation.attacker) continue;
        if (this.alliances.areAllied(detonation.attacker, victim)) {
          this.alliances.breakAlliance(detonation.attacker, victim);
          this.conflict.markTraitor(detonation.attacker);
          this.pushEvent(`${this.nameOf(detonation.attacker)} nuked their ally ${this.nameOf(victim)} — the pact is broken!`);
        } else {
          this.pushEvent(`${this.nameOf(detonation.attacker)} detonated ${nukeLabel(detonation.kind)} on ${this.nameOf(victim)}'s territory.`);
        }
      }
    }
    for (const interception of tickResult.nukeInterceptions) {
      this.pushEvent(
        `${this.nameOf(interception.defender)}'s SAM Launcher shot down a warhead from ${this.nameOf(interception.attacker)}.`,
      );
    }
    // Alliances are time-limited pacts (OpenFront's 5-minute lifetime): lapse
    // any whose clock ran out this tick. Natural expiry is not a betrayal — no
    // traitor mark, no reputation hit — the two sides simply part ways.
    for (const [a, b] of this.alliances.expireDue(this.conflict.tick)) {
      this.pushEvent(`The alliance between ${this.nameOf(a)} and ${this.nameOf(b)} has expired.`);
    }
    // Active land-attack fronts → wire coordinates for the on-map troop labels,
    // so each contested border shows how many troops are fighting there.
    this.lastFronts = this.conflict.activeFronts().map((f) => ({
      playerId: f.attacker,
      targetId: f.target,
      troops: f.troops,
      x: this.map.x(f.tile),
      y: this.map.y(f.tile),
    }));
    // Auto-routed railroads and the trains riding them → wire records, so the
    // client can draw the track network and the moving trains over the map.
    this.lastRails = this.conflict.railLinks().map((r) => ({ playerId: r.owner, points: r.points }));
    this.lastTrains = this.conflict.activeTrains().map((t) => ({ playerId: t.owner, x: t.x, y: t.y }));
    this.lastTradeShips = this.conflict.tradeShips().map((t) => ({ playerId: t.owner, x: t.x, y: t.y }));

    // Age out floating emoji reactions past their lifetime (cheap; the list is
    // empty on the vast majority of ticks).
    if (this.emojiReactions.length > 0) {
      const cutoff = this.conflict.tick - EMOJI_LIFETIME_TICKS;
      this.emojiReactions = this.emojiReactions.filter((e) => e.bornTick > cutoff);
    }

    // Append a single event line per command issued this tick, newest first.
    if (eventLines.length > 0) {
      this.recentEvents = [...eventLines.reverse(), ...this.recentEvents].slice(0, MAX_EVENTS);
    }

    // A player whose last tile was captured this tick is wiped off the map; the
    // conqueror keeps the ground they took and an elimination event is broadcast.
    const { lines: eliminationLines, eliminated: justEliminated } = this.resolveEliminations();
    if (eliminationLines.length > 0) {
      this.recentEvents = [...eliminationLines, ...this.recentEvents].slice(0, MAX_EVENTS);
    }

    for (const { clientId, rejection } of rejections) {
      this.subscribers.get(clientId)?.send({
        type: "SERVER_RASTER_ACTION_REJECTED",
        payload: rejection,
      });
    }

    // Decide the match winner (if any) before broadcasting this tick's
    // snapshot: a timeLimit finish's winner comes from leaderByTiles(), not
    // from the engine's own `conflict.winner` (conquest-only), and this is the
    // last snapshot ever sent once the match ends — a spectating,
    // previously-eliminated client relies on this snapshot's winnerPlayerId to
    // learn the match is over, since it doesn't get a second MATCH_ENDED here.
    const timeUp = this.conflict.tick >= this.maxDurationTicks;
    if (tickResult.winner !== null || timeUp) {
      this.finalWinnerId = tickResult.winner !== null ? tickResult.winner : this.leaderByTiles();
    }

    this.broadcastSnapshots();

    // Give every player eliminated this tick their own end-of-run summary now —
    // a defeat screen the instant their last tile falls, rather than leaving them
    // staring at dead controls until the whole match resolves. Sent after the
    // snapshot so the client first paints their final loss of territory.
    if (justEliminated.length > 0) {
      const endTick = this.conflict.tick;
      for (const subscriber of this.subscribers.values()) {
        if (!justEliminated.includes(subscriber.playerId) || this.endedSent.has(subscriber.playerId)) continue;
        this.endedSent.add(subscriber.playerId);
        subscriber.send({
          type: "SERVER_RASTER_MATCH_ENDED",
          payload: {
            winnerPlayerId: null,
            reason: "conquest",
            durationTicks: endTick,
            tickRate: SIMULATION_TICK_RATE,
            stats: this.buildRunStats(subscriber.playerId, endTick, null),
          },
        });
      }
    }

    // End the match on conquest (a player dominates WIN_TILE_FRACTION of the
    // land) or when the clock runs out (the territory leader is crowned).
    // Either way, broadcast a per-player run summary for the stats screen.
    if (tickResult.winner !== null || timeUp) {
      this.matchEndedBroadcast = true;
      const reason: RasterMatchEndReason = tickResult.winner !== null ? "conquest" : "timeLimit";
      const winnerId = this.finalWinnerId;
      const endTick = this.conflict.tick;

      const endLine = winnerId === null
        ? "The match ended with no survivors."
        : reason === "conquest"
          ? `${this.nameOf(winnerId)} has won by domination — ${Math.round(WIN_TILE_FRACTION * 100)}% of the map.`
          : `Time's up — ${this.nameOf(winnerId)} leads with the most territory.`;
      this.recentEvents = [endLine, ...this.recentEvents].slice(0, MAX_EVENTS);

      for (const subscriber of this.subscribers.values()) {
        // Players eliminated mid-match already got their summary; don't send a second.
        if (this.endedSent.has(subscriber.playerId)) continue;
        this.endedSent.add(subscriber.playerId);
        subscriber.send({
          type: "SERVER_RASTER_MATCH_ENDED",
          payload: {
            winnerPlayerId: winnerId,
            reason,
            durationTicks: endTick,
            tickRate: SIMULATION_TICK_RATE,
            stats: this.buildRunStats(subscriber.playerId, endTick, winnerId),
          },
        });
      }
      return;
    }
  }

  private nameOf(id: PlayerId): string {
    return this.playerMeta.get(id)?.name ?? `Player ${id}`;
  }

  /** The player holding the most tiles, ties broken by lowest id; null if none. */
  private leaderByTiles(): PlayerId | null {
    let leader: PlayerId | null = null;
    let best = 0;
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      if (tiles > best) {
        best = tiles;
        leader = id;
      }
    }
    return leader;
  }

  /** Assemble a player's end-of-run statistics for the post-match screen. */
  private buildRunStats(playerId: PlayerId, endTick: number, winnerId: PlayerId | null): RasterRunStats {
    return {
      playerId,
      peakTiles: this.peakTiles.get(playerId) ?? 0,
      finalTiles: this.grid.hasPlayer(playerId) ? this.grid.tileCountOf(playerId) : 0,
      kills: this.kills.get(playerId) ?? 0,
      survivedTicks: this.eliminationTick.get(playerId) ?? endTick,
      eliminated: this.eliminated.has(playerId),
      won: winnerId === playerId,
    };
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  public getPendingExpandCount(): number {
    return this.pendingExpands.length;
  }

  /** Test/bot helper: peek at the engine state without forcing a tick. */
  public peekGrid(): TerritoryGrid {
    return this.grid;
  }

  public peekMap(): GameMap {
    return this.map;
  }

  /** Test/bot helper: peek at the diplomacy state (alliances + proposals). */
  public peekAlliances(): AllianceRegistry {
    return this.alliances;
  }

  /** Test/bot helper: the engine's current tick (for pact countdowns). */
  public peekTick(): number {
    return this.conflict.tick;
  }

  /** Test helper: the engine's active attack fronts (attacker/target/troops/anchor). */
  public peekFronts(): ReturnType<RasterConflict["activeFronts"]> {
    return this.conflict.activeFronts();
  }

  /**
   * Eliminate any player that now holds no territory — a nation is beaten only
   * when its *entire* territory has been captured; there is no capital shortcut.
   * A seated player with zero tiles, not already eliminated, is wiped off the
   * map: the conqueror keeps everything they took and is credited with the kill
   * (read off {@link lastTileSeen} — the player's last sampled ground, whose
   * current owner is whoever finished them). Returns the elimination event lines
   * (newest first) plus the ids eliminated this call. Pure bookkeeping
   * otherwise — no broadcast here.
   */
  /** Whether `id` is a human (a real client) rather than an AI (Bot or Nation) seat. */
  private isHuman(id: PlayerId): boolean {
    for (const sub of this.subscribers.values()) if (sub.playerId === id) return sub.kind === "human";
    return false;
  }

  private resolveEliminations(): { lines: string[]; eliminated: PlayerId[] } {
    const lines: string[] = [];
    const eliminated: PlayerId[] = [];
    for (const playerId of this.grid.players()) {
      if (this.eliminated.has(playerId)) continue;
      if (this.grid.tileCountOf(playerId) > 0) continue; // Still holding ground.

      this.eliminated.add(playerId);
      eliminated.push(playerId);
      this.eliminationTick.set(playerId, this.conflict.tick);
      // A wiped-out nation leaves the diplomacy graph — its pacts and any pending
      // offers dissolve with it.
      this.alliances.removePlayer(playerId);

      // Credit the player now holding the eliminated nation's last sampled tile.
      const sample = this.lastTileSeen.get(playerId);
      const conqueror = sample !== undefined ? this.grid.ownerOf(sample) : NEUTRAL_PLAYER;
      if (conqueror !== NEUTRAL_PLAYER && conqueror !== playerId) {
        this.kills.set(conqueror, (this.kills.get(conqueror) ?? 0) + 1);
        // Conquer bounty (OpenFront's `conquerGoldAmount`): the victor inherits
        // the fallen nation's treasury — all of an AI's gold, half of a human's.
        const fraction = this.isHuman(playerId) ? CONQUER_GOLD_FRACTION_HUMAN : CONQUER_GOLD_FRACTION_AI;
        const bounty = Math.floor(this.grid.goldOf(playerId) * fraction);
        if (bounty > 0) this.grid.addGold(conqueror, bounty);
      }
      this.grid.setGold(playerId, 0); // the fallen nation's treasury is gone

      const fallenName = this.playerMeta.get(playerId)?.name ?? `Player ${playerId}`;
      const conquerorName = conqueror === NEUTRAL_PLAYER || conqueror === playerId
        ? "Rival nations"
        : this.playerMeta.get(conqueror)?.name ?? `Player ${conqueror}`;
      lines.unshift(`${conquerorName} conquered the last of ${fallenName}'s territory — ${fallenName} is eliminated!`);
    }
    return { lines, eliminated };
  }

  /**
   * Classify a clicked tile into a land attack or a transport-ship assault.
   *
   * A target the attacker shares a land border with becomes a contiguous land
   * push; one reachable only across water becomes a single transport ship sailing
   * the shortest route to that exact tile. The ship's full validation (path, the
   * three-ship cap, troop count) is left to {@link RasterConflict.launchShip} so
   * a path is only searched once — here we just route and size the commitment.
   */
  private validateAndBuildIntent(
    attacker: PlayerId,
    intent: RasterExpandIntent,
  ):
    | { kind: "land"; intent: AttackIntent }
    | { kind: "sea"; intent: SeaAttackIntent }
    | { kind: "rejected"; reason: RasterRejectReason; message: string } {
    if (this.conflict.winner !== null) {
      return { kind: "rejected", reason: "MATCH_ENDED", message: "The match has already ended." };
    }
    if (!this.grid.hasPlayer(attacker)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Choose a starting position first." };
    }
    if (!Number.isInteger(intent.targetX) || !Number.isInteger(intent.targetY) ||
        !this.map.inBounds(intent.targetX, intent.targetY)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Target tile is out of bounds." };
    }
    if (!Number.isInteger(intent.percent) || intent.percent < 1 || intent.percent > 100) {
      return { kind: "rejected", reason: "INVALID_PERCENT", message: "Percent must be an integer 1..100." };
    }
    // B(oat)/G(round) hotkeys force the route instead of the automatic choice
    // below: "land" requires a shared land border (never crosses water, even
    // if a crossing would reach the target); "sea" always launches a transport
    // ship, even where a land border also exists — letting a player flank an
    // enemy from the water instead of grinding through a defended frontier.
    const mode = intent.mode ?? "auto";

    const rawRef = this.map.ref(intent.targetX, intent.targetY);
    const pool = this.grid.troopsOf(attacker);
    const troops = Math.max(1, Math.floor((pool * intent.percent) / 100));
    if (troops > pool) {
      return { kind: "rejected", reason: "INSUFFICIENT_TROOPS", message: "Not enough troops in your pool." };
    }
    // A transport ship carries OpenFront's `boatAttackAmount`: one-fifth of the
    // pool, and never more than the slider asked for — `min(clicked, ⌊pool/5⌋)`.
    // Land attacks still commit the full slider amount; only boats are rationed.
    const boatTroops = Math.min(troops, Math.floor(pool / 5));

    // Snap a click that fell on un-ownable terrain (open water or impassable
    // rock) to the nearest land the player plausibly meant, so targeting works
    // by territory rather than by exact pixel — a tap just off a coastline or on
    // a mountain pixel inside enemy land resolves to the obvious land.
    const ref = this.grid.nearestCapturable(rawRef);
    if (ref === null) {
      if (mode === "land") {
        return { kind: "rejected", reason: "NO_FRONTIER", message: "No land route reaches that area." };
      }
      // The click landed on open water (or rock) too far from any land to snap to
      // — but the snap radius is much shorter than how far a boat can cross, so a
      // tap mid-channel toward a far coast would otherwise die as "no land there".
      // Before giving up, treat it as an amphibious order: if a transport ship can
      // reach a shore near the click, sail there. Only a click with no reachable
      // shore at all is finally rejected.
      const landing = boatTroops >= 1 ? this.grid.resolveSeaLanding(attacker, rawRef) : null;
      if (landing !== null) {
        return { kind: "sea", intent: { attacker, dest: landing, troops: boatTroops } };
      }
      return { kind: "rejected", reason: "INVALID_TILE", message: "No land near there to target." };
    }

    const target = this.grid.ownerOf(ref);
    if (target === attacker) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "You already own that tile." };
    }
    // A non-aggression pact bars attacking an ally's ground — by land or by sea.
    if (target !== NEUTRAL_PLAYER && this.alliances.areAllied(attacker, target)) {
      return {
        kind: "rejected",
        reason: "ALLIED",
        message: `You're allied with ${this.nameOf(target)} — break the alliance to attack.`,
      };
    }

    // Land-vs-boat, exactly as OpenFront's `canAttack` decides it:
    //   • an enemy player's tile is a land attack **only across a shared border**
    //     — there is no "march the long way round" to a rival you don't touch;
    //   • a neutral tile is a land attack when a bounded corridor of *unowned*
    //     land reaches back to us ({@link TerritoryGrid.canReachByLand});
    //   • anything else routes to a transport ship if the water reaches it.
    // An enemy wedged between our two coasts fails both land tests (no border,
    // and the corridor isn't neutral), so it correctly becomes a boat.
    // `mode` overrides this default: "sea" skips the land check entirely (even
    // a bordering enemy can be flanked from the water); "land" never falls
    // through to a boat.
    const canMarch = mode === "sea"
      ? false
      : target === NEUTRAL_PLAYER
        ? this.grid.canReachByLand(attacker, ref, LAND_ATTACK_REACH)
        : this.grid.hasLandBorderWith(attacker, target);
    if (canMarch) {
      return { kind: "land", intent: { attacker, target, troops } };
    }
    if (mode === "land") {
      return {
        kind: "rejected",
        reason: "NO_FRONTIER",
        message: "No land route reaches that area.",
      };
    }
    // Not marchable → a transport ship to the reachable shore nearest the click
    // (its own tile wins when that tile is itself reachable). Rather than demand
    // the player hit an exact in-range coastal tile, the boat picks the shore.
    const landing = boatTroops >= 1 ? this.grid.resolveSeaLanding(attacker, ref) : null;
    if (landing !== null) {
      return { kind: "sea", intent: { attacker, dest: landing, troops: boatTroops } };
    }
    return {
      kind: "rejected",
      reason: "NO_FRONTIER",
      message: "No route reaches that area — no land border, and no water crossing to it.",
    };
  }

  /**
   * Validate and apply one build order: the clicked tile must be open, owned
   * land the player holds, carry no existing structure, and the player must
   * afford the gold cost — which scales with how many of the
   * type they already own. On success the gold is spent, the structure placed,
   * and an event line returned; otherwise a typed rejection.
   */
  private processBuild(
    attacker: PlayerId,
    intent: RasterBuildIntent,
  ): { kind: "ok"; line: string } | { kind: "rejected"; reason: RasterRejectReason; message: string } {
    if (this.conflict.winner !== null || this.matchEndedBroadcast) {
      return { kind: "rejected", reason: "MATCH_ENDED", message: "The match has already ended." };
    }
    if (!this.grid.hasPlayer(attacker)) {
      return { kind: "rejected", reason: "NOT_BUILDABLE", message: "Choose a starting position first." };
    }
    if (!Number.isInteger(intent.targetX) || !Number.isInteger(intent.targetY) ||
        !this.map.inBounds(intent.targetX, intent.targetY)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Target tile is out of bounds." };
    }
    const def = BUILDING_DEFS[intent.building];
    if (!def) {
      return { kind: "rejected", reason: "INVALID_BUILDING", message: "Unknown building type." };
    }

    const clickRef = this.map.ref(intent.targetX, intent.targetY);
    if (!this.grid.isCapturable(clickRef) || this.grid.ownerOf(clickRef) !== attacker) {
      return { kind: "rejected", reason: "NOT_BUILDABLE", message: `Build a ${def.name.toLowerCase()} on land you own.` };
    }
    // Building on your own finished structure of the same type **upgrades** it
    // a level (OpenFront's v24 structure upgrades): same cost ramp — the next
    // step's price — no spacing check (it's the same tile), effect applies at
    // once. Only the economy structures are upgradable (see
    // UPGRADABLE_BUILDING_TYPES); the click must land on the structure itself.
    if (this.grid.buildingAt(clickRef) === intent.building) {
      if (!UPGRADABLE_BUILDING_TYPES.includes(intent.building)) {
        return { kind: "rejected", reason: "TILE_OCCUPIED", message: `A ${def.name.toLowerCase()} can't be upgraded.` };
      }
      if (this.grid.isUnderConstruction(clickRef)) {
        return { kind: "rejected", reason: "TILE_OCCUPIED", message: `That ${def.name.toLowerCase()} is still under construction.` };
      }
      const ownedLevels = costCounterTypes(intent.building).reduce(
        (sum, t) => sum + this.grid.totalLevelsOf(attacker, t),
        0,
      );
      const upgradeCost = buildingCost(intent.building, ownedLevels);
      if (this.grid.goldOf(attacker) < upgradeCost) {
        return {
          kind: "rejected",
          reason: "INSUFFICIENT_GOLD",
          message: `Not enough gold — upgrading this ${def.name.toLowerCase()} costs ${upgradeCost}.`,
        };
      }
      this.grid.addGold(attacker, -upgradeCost);
      const level = this.grid.upgradeBuilding(clickRef);
      const upgraderName = this.playerMeta.get(attacker)?.name ?? `Player ${attacker}`;
      return {
        kind: "ok",
        line: `${upgraderName} upgraded a ${def.name} to level ${level} (${upgradeCost} gold).`,
      };
    }
    // Coastal structures (ports, warships) can only stand where the land meets
    // navigable water. A coastline is a single tile wide, so rather than demand a
    // pixel-perfect click on it (OpenFront never does), snap to the nearest owned
    // shore tile within {@link COASTAL_SNAP_RADIUS} — clicking your coast "near
    // enough" just works. Only if no owned shore sits within reach is it rejected.
    const isCoastal = COASTAL_BUILDING_TYPES.includes(intent.building);
    const ref = isCoastal && !this.map.isShore(clickRef)
      ? this.nearestOwnedShore(attacker, intent.targetX, intent.targetY)
      : clickRef;
    if (ref === null) {
      return { kind: "rejected", reason: "NOT_BUILDABLE", message: `A ${def.name.toLowerCase()} must be built near your coast.` };
    }
    if (this.grid.hasBuilding(ref)) {
      return { kind: "rejected", reason: "TILE_OCCUPIED", message: "That tile already has a building." };
    }
    const targetX = this.map.x(ref);
    const targetY = this.map.y(ref);
    // Structures can't be packed together: enforce OpenFront's minimum spacing
    // (Euclidean) against the builder's other buildings.
    const minDistSq = STRUCTURE_MIN_DIST * STRUCTURE_MIN_DIST;
    for (const [other] of this.grid.buildingEntries()) {
      if (this.grid.ownerOf(other) !== attacker) continue;
      const dx = this.map.x(other) - targetX;
      const dy = this.map.y(other) - targetY;
      if (dx * dx + dy * dy < minDistSq) {
        return {
          kind: "rejected",
          reason: "TILE_OCCUPIED",
          message: `Too close to another building — keep ${STRUCTURE_MIN_DIST} tiles between structures.`,
        };
      }
    }

    // Ports and Factories share a cost counter, so sum the owned **levels**
    // across the building's cost group (just itself for the others): every
    // build or upgrade of the group advances the ramp.
    const owned = costCounterTypes(intent.building).reduce(
      (sum, t) => sum + this.grid.totalLevelsOf(attacker, t),
      0,
    );
    const cost = buildingCost(intent.building, owned);
    if (this.grid.goldOf(attacker) < cost) {
      return {
        kind: "rejected",
        reason: "INSUFFICIENT_GOLD",
        message: `Not enough gold — a ${def.name.toLowerCase()} costs ${cost}.`,
      };
    }

    this.grid.addGold(attacker, -cost);
    // The structure goes up over time: it counts toward the cost ramp at once,
    // but its effects only switch on after its construction window elapses.
    const start = this.conflict.tick;
    this.grid.placeBuilding(ref, intent.building, start, start + BUILDING_CONSTRUCTION_TICKS[intent.building]);
    const builderName = this.playerMeta.get(attacker)?.name ?? `Player ${attacker}`;
    return {
      kind: "ok",
      line: `${builderName} built a ${def.name} (${cost} gold) at (${targetX}, ${targetY}).`,
    };
  }

  /**
   * Validate and dispatch a warhead launch: the target must be land, the
   * attacker must own a Missile Silo that isn't under construction or
   * reloading, and afford the kind's cost (a MIRV's cost scales with how many
   * silos the attacker owns, see {@link nukeCost}). On success the gold is
   * spent, that silo starts reloading, and the flight is handed to
   * {@link RasterConflict.launchNuke}; the blast(s) land on arrival, subject to
   * any SAM Launcher interception along the way.
   */
  private processNuke(
    attacker: PlayerId,
    intent: RasterNukeIntent,
  ): { kind: "ok"; line: string } | { kind: "rejected"; reason: RasterRejectReason; message: string } {
    if (this.conflict.winner !== null || this.matchEndedBroadcast) {
      return { kind: "rejected", reason: "MATCH_ENDED", message: "The match has already ended." };
    }
    if (!this.grid.hasPlayer(attacker)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Choose a starting position first." };
    }
    if (!Number.isInteger(intent.targetX) || !Number.isInteger(intent.targetY) ||
        !this.map.inBounds(intent.targetX, intent.targetY)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Target tile is out of bounds." };
    }
    const targetRef = this.map.ref(intent.targetX, intent.targetY);
    if (!this.map.isLand(targetRef)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "A warhead can only target land." };
    }
    const kind: NukeKind = intent.kind ?? "atom";

    let siloRef: TileRef | null = null;
    for (const [ref, type] of this.grid.buildingEntries()) {
      if (type !== "silo" || this.grid.ownerOf(ref) !== attacker || this.grid.isUnderConstruction(ref)) continue;
      if ((this.siloReadyAt.get(ref) ?? 0) > this.conflict.tick) continue;
      siloRef = ref;
      break;
    }
    if (siloRef === null) {
      return { kind: "rejected", reason: "NO_SILO_READY", message: "No Missile Silo is ready — build one or wait for it to reload." };
    }
    const cost = nukeCost(kind, this.grid.buildingCountOf(attacker, "silo"));
    if (this.grid.goldOf(attacker) < cost) {
      return { kind: "rejected", reason: "INSUFFICIENT_GOLD", message: `Not enough gold — ${nukeLabel(kind)} costs ${cost}.` };
    }

    this.grid.addGold(attacker, -cost);
    this.siloReadyAt.set(siloRef, this.conflict.tick + SILO_RELOAD_TICKS);
    this.conflict.launchNuke(attacker, this.map.x(siloRef), this.map.y(siloRef), intent.targetX, intent.targetY, kind);

    return {
      kind: "ok",
      line: `${this.nameOf(attacker)} launched ${nukeLabel(kind)} at (${intent.targetX}, ${intent.targetY}).`,
    };
  }

  /**
   * Nearest tile the player owns that sits on a coastline, searched outward from
   * (`cx`,`cy`) in growing Chebyshev rings up to {@link COASTAL_SNAP_RADIUS}.
   * Returns the closest owned, capturable shore tile (so a port/warship can stand
   * there), or `null` if the player holds no coast within reach. Rings are walked
   * nearest-first so the snap lands on the coast the player most plausibly meant.
   */
  private nearestOwnedShore(owner: PlayerId, cx: number, cy: number): TileRef | null {
    for (let r = 0; r <= COASTAL_SNAP_RADIUS; r += 1) {
      let best: TileRef | null = null;
      let bestDistSq = Infinity;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          // Only the perimeter of this ring is new; interior tiles were already
          // examined by a smaller radius.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!this.map.inBounds(x, y)) continue;
          const ref = this.map.ref(x, y);
          if (!this.map.isShore(ref)) continue;
          if (!this.grid.isCapturable(ref) || this.grid.ownerOf(ref) !== owner) continue;
          if (this.grid.hasBuilding(ref)) continue;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = ref;
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  }

  /** Event-log line for a committed land attack. */
  private landEventLine(intent: AttackIntent): string {
    const attackerName = this.playerMeta.get(intent.attacker)?.name ?? `Player ${intent.attacker}`;
    const targetName = intent.target === NEUTRAL_PLAYER
      ? "neutral land"
      : this.playerMeta.get(intent.target)?.name ?? `Player ${intent.target}`;
    return `${attackerName} committed ${intent.troops} troops toward ${targetName}.`;
  }

  /** Event-log line for a dispatched transport ship. */
  private shipEventLine(intent: SeaAttackIntent): string {
    const attackerName = this.playerMeta.get(intent.attacker)?.name ?? `Player ${intent.attacker}`;
    return `${attackerName} launched a transport ship with ${intent.troops} troops.`;
  }

  /** Map a ship-launch reject reason to a wire rejection (without the intent). */
  private shipRejection(
    attacker: PlayerId,
    reason: AttackRejectReason,
  ): { reason: RasterRejectReason; message: string } {
    switch (reason) {
      case "TOO_MANY_SHIPS":
        return {
          reason: "TOO_MANY_SHIPS",
          message: `You already have ${this.conflict.shipCountOf(attacker)} transport ships at sea (max ${this.grid.maxShipsOf(attacker)}).`,
        };
      case "INSUFFICIENT_TROOPS":
        return { reason: "INSUFFICIENT_TROOPS", message: "Not enough troops in your pool." };
      case "ALLIED":
        return { reason: "ALLIED", message: "That shore belongs to an ally — break the alliance to attack." };
      case "NO_FRONTIER":
        return { reason: "NO_FRONTIER", message: "No water route reaches that tile." };
      default:
        return { reason: "INVALID_TILE", message: "That tile can't be reached by sea." };
    }
  }

  /**
   * Assemble the subscriber-independent snapshot body for the current tick —
   * the player standings, buildings, fronts and all scalar/diplomacy state. The
   * ownership raster and terrain bytes are *not* included; those are attached
   * per subscriber in {@link sendSnapshotTo}. Built once and shared across every
   * subscriber so the (allocation-heavy) player/building assembly runs once per
   * tick rather than once per client.
   */
  private buildSharedBody(): RasterSnapshot {
    const spawnRemainingTicks =
      this.phase === "spawn" ? Math.max(0, this.spawnPhaseTicks - this.spawnTicksElapsed) : 0;
    return buildSharedSnapshot({
      tick: this.conflict.tick,
      mapName: this.mapName,
      phase: this.phase,
      spawnRemainingSeconds: Math.ceil(spawnRemainingTicks / SIMULATION_TICK_RATE),
      map: this.map,
      grid: this.grid,
      playerMeta: this.playerMeta,
      includeTerrain: false,
      terrainHash: this.terrainHash,
      terrainBase64: this.terrainBase64,
      winnerPlayerId: this.finalWinnerId ?? this.conflict.winner,
      recentEvents: this.recentEvents,
      crossings: this.lastCrossings,
      ships: this.lastShips,
      warships: this.lastWarships,
      nukes: this.lastNukes,
      nukeDetonations: this.lastNukeDetonations,
      nukeInterceptions: this.lastNukeInterceptions,
      falloutTiles: this.grid.falloutTiles(),
      fronts: this.lastFronts,
      rails: this.lastRails,
      trains: this.lastTrains,
      tradeShips: this.lastTradeShips,
      eliminated: this.eliminated,
      alliances: this.alliances.infos(this.conflict.tick),
      allianceRequests: this.alliances.proposals(),
      embargoes: this.alliances.allEmbargoes(),
      targetRequests: this.alliances.allTargetRequests(),
      emojis: this.emojiReactions.map((e) => ({
        from: e.from,
        x: e.x,
        y: e.y,
        emoji: e.emoji,
        age: this.conflict.tick - e.bornTick,
      })),
      lastAttackerOf: (playerId) => this.conflict.lastAttackerOf(playerId) ?? 0,
      betrayalsOf: (playerId) => this.alliances.betrayalsOf(playerId),
    });
  }

  /**
   * Broadcast a snapshot to every subscriber for the current tick, building the
   * shared body just once and memoising any full-owner encoding so a high-churn
   * tick encodes the whole raster at most once even with many human clients.
   */
  private broadcastSnapshots(): void {
    const shared = this.buildSharedBody();
    let fullOwnerCache: string | undefined;
    const fullOwner = (): string => (fullOwnerCache ??= encodeOwners(this.grid.owner));
    for (const subscriber of this.subscribers.values()) {
      this.sendSnapshotTo(subscriber, shared, fullOwner);
    }
  }

  /**
   * Send one subscriber its snapshot. Reuses the shared body (built once per
   * broadcast) and attaches this subscriber's ownership view:
   *  - Headless subscribers (bots) read engine state directly and discard the
   *    wire ownership, so they take the shared body verbatim — no terrain bytes,
   *    no owner encoding, no per-subscriber allocation at all.
   *  - Real clients get the terrain once, then per-tile owner deltas against
   *    their own baseline (falling back to a full resend when churn is high).
   *
   * `shared`/`fullOwner` default so a one-off send (on subscribe / spawn pick)
   * outside the broadcast loop still works.
   */
  private sendSnapshotTo(
    subscriber: RasterSubscriber,
    shared: RasterSnapshot = this.buildSharedBody(),
    fullOwner: () => string = () => encodeOwners(this.grid.owner),
  ): void {
    if (!subscriber.wantsRaster) {
      // Bots only read tick/phase/winner off the body — share it as-is.
      subscriber.send({ type: "SERVER_RASTER_SNAPSHOT", payload: shared });
      return;
    }

    const includeTerrain = !subscriber.hasTerrain;
    const owner = this.grid.owner;

    // Owner encoding: the first snapshot (and any with no baseline yet) carries
    // the full raster and seeds the baseline. Later snapshots send only the
    // tiles that changed — unless the churn is so high that a full resend would
    // be smaller, in which case we resend in full. encodeOwnerDelta advances the
    // baseline in place either way, so it stays in sync even on a full resend.
    let ownerDeltaBase64: string | undefined;
    if (subscriber.lastOwner === null) {
      subscriber.lastOwner = Uint16Array.from(owner);
    } else {
      const { deltaBase64, changed } = encodeOwnerDelta(subscriber.lastOwner, owner);
      // 6 bytes/change vs 2 bytes/tile full: a delta only wins below ~1/3 churn.
      if (changed * 3 <= owner.length) ownerDeltaBase64 = deltaBase64;
    }

    const snapshot = attachOwnership(shared, {
      includeTerrain,
      terrainBase64: this.terrainBase64,
      ownerDeltaBase64,
      fullOwner,
    });
    subscriber.send({ type: "SERVER_RASTER_SNAPSHOT", payload: snapshot });
    if (includeTerrain) {
      subscriber.hasTerrain = true;
    }
  }
}
