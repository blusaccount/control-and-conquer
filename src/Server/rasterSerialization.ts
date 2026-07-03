import type { GameMap } from "../Core/GameMap.js";
import type { TerritoryGrid } from "../Core/TerritoryGrid.js";
import { maxTroops, troopsPerSecond } from "../Core/rasterCombatConfig.js";
import { goldPerSecond } from "../Core/buildings.js";
import { SIMULATION_TICK_RATE } from "./simulationConfig.js";
import type { RasterAllianceInfo, RasterAllianceRequest, RasterAttackFront, RasterBuilding, RasterCrossing, RasterEmbargoPair, RasterEmojiReaction, RasterMatchPhase, RasterNuke, RasterNukeDetonation, RasterNukeInterception, RasterPlayerInfo, RasterRail, RasterShip, RasterSnapshot, RasterTargetRequestInfo, RasterTrade, RasterTrain, RasterWarship } from "../Core/types.js";

/**
 * Stable 12-hex-char fingerprint of the terrain bytes, used purely as a
 * client-side cache key (no cryptographic strength required). Two independent
 * FNV-1a passes give 48 bits — ample to tell our handful of maps apart — using
 * only portable integer math, so this module stays free of `node:crypto` and can
 * run unchanged in a browser Web Worker.
 */
const hashTerrain = (bytes: Uint8Array): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0xcafebabe;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
};

/** A `Buffer`-like shape exposing just the static base64 helper we need. */
interface BufferLike {
  from(bytes: Uint8Array): { toString(encoding: string): string };
}

/**
 * Base64-encode a byte array, isomorphically. On the server the Node `Buffer`
 * global gives a fast native encode; in a browser Web Worker (where `Buffer`
 * does not exist) it falls back to chunked `btoa`. This keeps the whole module
 * runnable in the worker that hosts a solo match, with no Node dependency and no
 * server-side slowdown.
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  const maybeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString("base64");
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

/**
 * Serialize a `GameMap`'s static terrain into base64 plus a stable hash.
 */
export const encodeTerrain = (map: GameMap): { terrainBase64: string; terrainHash: string } => ({
  terrainBase64: bytesToBase64(map.terrain),
  terrainHash: hashTerrain(map.terrain),
});

/**
 * Serialize the current owner array (`Uint16Array`) to base64. We write
 * little-endian explicitly so the client decoder doesn't depend on the host's
 * native byte order (browsers can disagree with the server's V8).
 */
export const encodeOwners = (owner: ArrayLike<number>): string => {
  const bytes = new Uint8Array(owner.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < owner.length; i += 1) {
    view.setUint16(i * 2, owner[i], true /* little-endian */);
  }
  return bytesToBase64(bytes);
};

/**
 * Diff `curr` against the `prev` baseline and encode the changed tiles as a
 * packed delta (6 bytes per change: LE Uint32 index + LE Uint16 owner). The
 * `prev` array is updated in place to match `curr`, so the caller's baseline is
 * advanced as a side effect. Returns the base64 payload plus the change count
 * (so the caller can fall back to a full resend when churn is high).
 */
export const encodeOwnerDelta = (
  prev: Uint16Array,
  curr: ArrayLike<number>,
): { deltaBase64: string; changed: number } => {
  // Single pass over the raster: collect the changed indices, then size and fill
  // the buffer from that list. The previous two-pass form scanned the whole
  // (up-to-1.6M-tile) array twice per tick just to learn the change count first.
  const indices: number[] = [];
  for (let i = 0; i < curr.length; i += 1) if (prev[i] !== curr[i]) indices.push(i);

  const changed = indices.length;
  const bytes = new Uint8Array(changed * 6);
  const view = new DataView(bytes.buffer);
  for (let k = 0; k < changed; k += 1) {
    const i = indices[k];
    view.setUint32(k * 6, i, true);
    view.setUint16(k * 6 + 4, curr[i], true);
    prev[i] = curr[i];
  }
  return { deltaBase64: bytesToBase64(bytes), changed };
};

/**
 * Serialize a list of tile indices (e.g. active fallout tiles) to base64 as a
 * packed little-endian `Uint32Array`, so the client can decode them independent
 * of host byte order — same convention as {@link encodeOwners}.
 */
export const encodeTileList = (refs: readonly number[]): string => {
  const bytes = new Uint8Array(refs.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < refs.length; i += 1) view.setUint32(i * 4, refs[i], true);
  return bytesToBase64(bytes);
};

/** Per-player metadata needed to build a `RasterPlayerInfo`. */
export interface PlayerMeta {
  name: string;
  color: string;
}

/**
 * Build a `RasterSnapshot` from the engine state plus optional inclusion of
 * the static terrain. The terrain bytes are large and never change, so the
 * caller drops them on every snapshot except the first one for a new client.
 */
export interface BuildSnapshotInput {
  tick: number;
  mapName: string;
  /** Current match phase (`spawn` start phase vs live `playing` game). */
  phase: RasterMatchPhase;
  /** Whole seconds left in the start phase; 0 once playing. */
  spawnRemainingSeconds: number;
  map: GameMap;
  grid: TerritoryGrid;
  playerMeta: Map<number, PlayerMeta>;
  includeTerrain: boolean;
  terrainHash: string;
  terrainBase64: string;
  winnerPlayerId: number | null;
  recentEvents: string[];
  /** Transport-ship landings resolved this tick (for the client landing flash). */
  crossings: RasterCrossing[];
  /** Transport ships in flight this snapshot (for client ship animation). */
  ships: RasterShip[];
  /** Live mobile warships this snapshot (for client warship animation + health bars). */
  warships?: RasterWarship[];
  /** Warheads in flight this snapshot (for client nuke animation). */
  nukes: RasterNuke[];
  /** Warhead detonations resolved this tick (for the explosion flash). */
  nukeDetonations: RasterNukeDetonation[];
  /** Warheads shot down by a SAM Launcher this tick (for the interception flash). */
  nukeInterceptions?: RasterNukeInterception[];
  /** Tile indices currently under fallout (for the lingering radioactive tint). */
  falloutTiles?: number[];
  /** Active land-attack fronts this tick (for the on-map troop-count labels). */
  fronts: RasterAttackFront[];
  /** Auto-routed railroads this snapshot (for the client to draw track). */
  rails?: RasterRail[];
  /** Trains riding the rail network this snapshot (for the client to draw dots). */
  trains?: RasterTrain[];
  /** Trade ships sailing between ports this snapshot (for the client to draw dots). */
  tradeShips?: RasterTrade[];
  /**
   * When set, the snapshot carries this incremental ownership update instead of
   * the full owner raster. When omitted, the full raster is encoded and sent.
   */
  ownerDeltaBase64?: string;
  /**
   * Skip the ownership raster entirely (neither full nor delta). Used for
   * headless subscribers such as server-side bots, which read engine state
   * directly and never decode the wire ownership — encoding it for them is pure
   * waste and, multiplied across a dozen bots, the dominant per-tick cost.
   */
  omitOwner?: boolean;
  /** Players who have been wiped off the map (no tiles left). */
  eliminated?: Set<number>;
  /** Active alliances with remaining lifetime + renewal votes. */
  alliances?: RasterAllianceInfo[];
  /** Pending alliance proposals (directed `from` → `to`). */
  allianceRequests?: RasterAllianceRequest[];
  /** Active trade embargoes (directed `[from, to]` pairs). */
  embargoes?: RasterEmbargoPair[];
  /** Standing target requests (directed `from` → ally `to`, against `target`). */
  targetRequests?: RasterTargetRequestInfo[];
  /** Transient floating emoji reactions. */
  emojis?: RasterEmojiReaction[];
  /** Player id who most recently attacked a given player, for `RasterPlayerInfo.lastAttackedBy`. */
  lastAttackerOf?: (playerId: number) => number;
  /** How many alliances a given player has betrayed, for `RasterPlayerInfo.betrayals`. */
  betrayalsOf?: (playerId: number) => number;
}

/**
 * Build every field of a snapshot that does **not** vary between subscribers:
 * the player standings, placed buildings, fronts/ships/rails/trains, scalar
 * match state and diplomacy. The per-subscriber bits — the terrain bytes and the
 * ownership raster (full or delta) — are deliberately omitted here and attached
 * afterwards by {@link attachOwnership}.
 *
 * Splitting the snapshot this way lets the session build this (relatively
 * expensive — it allocates the player array and sorts the building map) body
 * **once per tick** and reuse it for every subscriber, instead of rebuilding it
 * per client. Headless subscribers (bots) can take the returned object verbatim
 * since they never read the ownership raster at all.
 */
export const buildSharedSnapshot = (input: BuildSnapshotInput): RasterSnapshot => {
  const { tick, mapName, phase, spawnRemainingSeconds, map, grid, playerMeta, terrainHash, winnerPlayerId, recentEvents, crossings, ships, warships = [], nukes, nukeDetonations, nukeInterceptions = [], falloutTiles = [], fronts, rails = [], trains = [], tradeShips = [], eliminated, alliances = [], allianceRequests = [], embargoes = [], targetRequests = [], emojis = [], lastAttackerOf, betrayalsOf } = input;

  const players: RasterPlayerInfo[] = [];
  for (const id of grid.players()) {
    const meta = playerMeta.get(id) ?? { name: `Player ${id}`, color: "#888" };
    const tiles = grid.tileCountOf(id);
    // The wire per-type figures are **cost counters** (sum of levels): every
    // build or upgrade advances them, so the client's build-menu price labels
    // match the server's ramp exactly. Identical to instance counts for
    // non-upgradable types.
    const cities = grid.totalLevelsOf(id, "city");
    const ports = grid.totalLevelsOf(id, "port");
    // Only finished city levels lift the population cap (under-construction
    // cities don't yet; upgrades apply instantly).
    const activeCities = grid.activeLevelsOf(id, "city");
    players.push({
      playerId: id,
      name: meta.name,
      color: meta.color,
      troops: Math.floor(grid.troopsOf(id)),
      gold: Math.floor(grid.goldOf(id)),
      goldPerSecond: goldPerSecond(SIMULATION_TICK_RATE),
      cities,
      ports,
      forts: grid.totalLevelsOf(id, "fort"),
      factories: grid.totalLevelsOf(id, "factory"),
      silos: grid.totalLevelsOf(id, "silo"),
      warships: grid.totalLevelsOf(id, "warship"),
      sams: grid.totalLevelsOf(id, "sam"),
      tiles,
      troopsPerSecond: troopsPerSecond(tiles, grid.troopsOf(id), SIMULATION_TICK_RATE, grid.incomeMultiplierOf(id), activeCities, grid.modifiersOf(id).troopCapMultiplier),
      maxTroops: Math.floor(maxTroops(tiles, activeCities) * grid.modifiersOf(id).troopCapMultiplier),
      eliminated: eliminated?.has(id) ?? false,
      lastAttackedBy: lastAttackerOf?.(id) ?? 0,
      betrayals: betrayalsOf?.(id) ?? 0,
    });
  }

  // Every placed structure as a wire record, so the client can mark the map.
  const buildings: RasterBuilding[] = grid.buildingEntries().map(([ref, type]) => ({
    playerId: grid.ownerOf(ref),
    x: map.x(ref),
    y: map.y(ref),
    type,
    underConstruction: grid.isUnderConstruction(ref),
    buildProgress: grid.constructionProgress(ref, tick),
    level: grid.buildingLevelOf(ref),
  }));

  return {
    tick,
    mapName,
    phase,
    spawnRemainingSeconds,
    width: map.width,
    height: map.height,
    terrainHash,
    players,
    capturableCount: grid.capturableCount,
    winnerPlayerId,
    recentEvents,
    crossings,
    ships,
    warships,
    nukes,
    nukeDetonations,
    nukeInterceptions,
    ...(falloutTiles.length > 0 ? { falloutBase64: encodeTileList(falloutTiles) } : { falloutBase64: "" }),
    buildings,
    rails,
    trains,
    tradeShips,
    fronts,
    alliances,
    allianceRequests,
    embargoes,
    targetRequests,
    emojis,
  };
};

/**
 * Attach the per-subscriber terrain bytes and ownership raster to a freshly
 * **copied** shared snapshot body, returning a snapshot ready to send. The
 * shared body is never mutated, so a single body can be fanned out to many
 * subscribers, each getting its own terrain/ownership decision:
 *  - `includeTerrain` — emit the (large, static) terrain bytes (first snapshot).
 *  - `ownerDeltaBase64` — emit an incremental ownership update; otherwise the
 *    full raster is encoded (via `fullOwner`, which the caller can memoise so a
 *    high-churn tick encodes the full raster at most once across subscribers).
 *  - `omitOwner` — ship no ownership at all (headless/bot subscribers).
 */
export const attachOwnership = (
  shared: RasterSnapshot,
  opts: {
    includeTerrain: boolean;
    terrainBase64: string;
    ownerDeltaBase64?: string;
    omitOwner?: boolean;
    fullOwner: () => string;
  },
): RasterSnapshot => {
  const snapshot: RasterSnapshot = { ...shared };
  if (opts.includeTerrain) snapshot.terrainBase64 = opts.terrainBase64;
  if (!opts.omitOwner) {
    if (opts.ownerDeltaBase64 !== undefined) snapshot.ownerDeltaBase64 = opts.ownerDeltaBase64;
    else snapshot.ownerBase64 = opts.fullOwner();
  }
  return snapshot;
};

export const buildRasterSnapshot = (input: BuildSnapshotInput): RasterSnapshot => {
  const shared = buildSharedSnapshot(input);
  return attachOwnership(shared, {
    includeTerrain: input.includeTerrain,
    terrainBase64: input.terrainBase64,
    ownerDeltaBase64: input.ownerDeltaBase64,
    omitOwner: input.omitOwner,
    fullOwner: () => encodeOwners(input.grid.owner),
  });
};
