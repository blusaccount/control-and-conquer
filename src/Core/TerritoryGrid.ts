import type { GameMap, TileRef } from "./GameMap.js";
import {
  CLICK_SNAP_RADIUS,
  DEFENSE_POST_RADIUS,
  DEFENSE_POST_STRENGTH,
  MAX_SEA_CROSSING_TILES,
  MAX_SEA_RANGE_MULTIPLIER,
} from "./rasterCombatConfig.js";
import { IDENTITY_MODIFIERS, type PlayerModifiers } from "./playerModifiers.js";
import {
  type BuildingType,
  FORT_DEFENSE_RADIUS,
  FORT_DEFENSE_STRENGTH,
  PORT_SEA_RANGE_PER,
  STARTING_GOLD,
} from "./buildings.js";
import { SeaLinks } from "./seaLinks.js";

/**
 * A player identifier. 0 is reserved for {@link NEUTRAL_PLAYER} (unclaimed
 * land); real players use ids >= 1. Kept as a plain number so ownership can be
 * stored in a dense `Uint16Array` parallel to the terrain raster.
 */
export type PlayerId = number;

/** Owner id for unclaimed (neutral) tiles. Real players are >= 1. */
export const NEUTRAL_PLAYER: PlayerId = 0;

/** Per-player bookkeeping kept alongside the ownership array. */
interface PlayerStanding {
  /** Current troop pool (may be fractional internally; reported rounded). */
  troops: number;
  /**
   * Current gold pool (may be fractional internally; reported rounded). The
   * second resource: it accrues from territory + cities and is spent on
   * {@link buildings}.
   */
  gold: number;
  /**
   * The set of tiles this player currently owns. Single source of truth for both
   * the tile count (`tiles.size`) and the player's frontier: expansion only ever
   * radiates from owned tiles, so iterating this set is far cheaper than scanning
   * the whole ownership raster.
   */
  tiles: Set<TileRef>;
  /** Per-player gameplay modifiers; defaults to no effect. */
  modifiers: PlayerModifiers;
  /** How many of each building type this player currently owns (for cost maths). */
  buildingCounts: Map<BuildingType, number>;
}

/**
 * Mutable ownership + troop layer over a static {@link GameMap}.
 *
 * Terrain stays immutable in the `GameMap`; this grid owns the things that
 * change during a match: which player holds each tile (`owner`) and each
 * player's troop pool. It is deliberately a thin, framework-free data structure
 * — the tick logic lives in `RasterConflict`.
 *
 * **Ownership rule:** only *capturable* tiles (passable land) can be owned.
 * Water and impassable rock can never be owned, so attempts to claim them throw.
 * Open water is still a barrier to *land* fronts, but narrow seas can be crossed
 * by amphibious landings — see {@link seaLinks}.
 */
export class TerritoryGrid {
  readonly map: GameMap;
  /** Owner id per tile; index is a `TileRef`. 0 = neutral. */
  readonly owner: Uint16Array;
  /** Total number of capturable (ownable) tiles on the map. */
  readonly capturableCount: number;
  /** Precomputed amphibious-crossing adjacency between coastal tiles. */
  readonly seaLinks: SeaLinks;
  /**
   * Connected-land-component label per tile: capturable tiles in the same
   * 4-connected landmass share an id; water and impassable rock are -1. Terrain
   * is immutable so this is computed once. It answers "can a land front ever
   * reach this tile from there?" — the basis for routing a click to a contiguous
   * land attack versus a transport ship across open water.
   */
  private readonly landComponent: Int32Array;
  /**
   * Per-player tile counts bucketed by land component, so "does this player hold
   * any ground on `dest`'s landmass?" is an O(1) lookup. Maintained in
   * {@link claim}; only real players are tracked (neutral land is irrelevant to
   * routing).
   */
  private readonly componentCounts = new Map<PlayerId, Map<number, number>>();

  private readonly standings = new Map<PlayerId, PlayerStanding>();

  /**
   * Fortified locations (a tile → its aura radius and peak strength). A defense
   * post raises the troop cost to capture ground around it; see
   * {@link defenseFactorAt}. Sparse — only a handful exist (e.g. one per
   * capital) — so queries scan the whole map cheaply.
   */
  private readonly defensePosts = new Map<TileRef, { radius: number; strength: number }>();

  /**
   * Structures placed on owned tiles (a tile → its building type). Sparse — only
   * a handful exist per player — and a building lives and dies with the tile
   * beneath it: capturing or neutralising a tile destroys whatever stood on it
   * (see {@link claim}). A fort additionally registers a {@link defensePosts}
   * aura; a port widens its owner's {@link seaRangeOf}; a city feeds the economy
   * (handled by the conflict engine, which reads {@link buildingCountOf}).
   */
  private readonly buildings = new Map<TileRef, BuildingType>();

  // Lazily-allocated, generation-stamped scratch buffers reused by every
  // {@link findSeaPath} call so per-launch pathfinding stays allocation-free.
  private seaPathParent?: Int32Array;
  private seaPathDepth?: Int32Array;
  private seaPathStamp?: Int32Array;
  private seaPathGeneration?: number;

  // Separate generation-stamped scratch for {@link resolveSeaLanding}'s
  // multi-source water flood, so it never clobbers a {@link findSeaPath} call.
  private seaLandStamp?: Int32Array;
  private seaLandGeneration?: number;

  constructor(map: GameMap) {
    this.map = map;
    this.owner = new Uint16Array(map.size);
    // The reachability graph only spans the narrow-strait base range — it drives
    // cheap per-tick frontier discovery (and the bot's target enumeration), not
    // explicit boat launches, which are unbounded via {@link findSeaPath} /
    // {@link resolveSeaLanding} (OpenFront-style: any navigable water, any width).
    this.seaLinks = SeaLinks.build(map, MAX_SEA_CROSSING_TILES);
    let capturable = 0;
    for (let ref = 0; ref < map.size; ref += 1) {
      if (map.isLand(ref) && !map.isImpassable(ref)) capturable += 1;
    }
    this.capturableCount = capturable;
    this.landComponent = this.labelLandComponents();
  }

  /**
   * Flood-fill the capturable land into 4-connected components, returning a
   * per-tile label array (-1 for water/rock). One linear pass over the raster;
   * run once at construction since terrain never changes.
   */
  private labelLandComponents(): Int32Array {
    const label = new Int32Array(this.map.size).fill(-1);
    const stack: TileRef[] = [];
    let next = 0;
    for (let seed = 0; seed < this.map.size; seed += 1) {
      if (!this.isCapturable(seed) || label[seed] !== -1) continue;
      const id = next++;
      label[seed] = id;
      stack.length = 0;
      stack.push(seed);
      while (stack.length > 0) {
        const tile = stack.pop()!;
        for (const n of this.map.neighbors(tile)) {
          if (this.isCapturable(n) && label[n] === -1) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    return label;
  }

  /**
   * Connected-land-component id of `ref`: two capturable tiles share an id iff
   * they belong to the same 4-connected landmass. Water and impassable rock
   * return -1. Stable for the life of the grid (terrain is immutable).
   */
  landComponentId(ref: TileRef): number {
    return this.landComponent[ref];
  }

  /**
   * True if `player` owns at least one tile on the same landmass as `ref` — i.e.
   * a land front could in principle march from that ground to `ref` without
   * crossing water. False for water/rock or a landmass the player has no foothold
   * on, which is exactly when reaching `ref` demands a transport ship.
   */
  ownsLandComponentOf(player: PlayerId, ref: TileRef): boolean {
    const comp = this.landComponent[ref];
    if (comp < 0) return false;
    return (this.componentCounts.get(player)?.get(comp) ?? 0) > 0;
  }

  /** Adjust `player`'s owned-tile tally for one land component by `delta`. */
  private bumpComponent(player: PlayerId, comp: number, delta: number): void {
    let counts = this.componentCounts.get(player);
    if (!counts) {
      counts = new Map();
      this.componentCounts.set(player, counts);
    }
    counts.set(comp, (counts.get(comp) ?? 0) + delta);
  }

  /** True when a tile can be owned (passable land). */
  isCapturable(ref: TileRef): boolean {
    return this.map.isLand(ref) && !this.map.isImpassable(ref);
  }

  /**
   * The capturable land tile nearest `ref`, searched within `maxRadius` tiles
   * (Chebyshev), or `null` if the neighbourhood is all water/rock. `ref` itself
   * is returned when it is already capturable.
   *
   * This lets a click target a *territory* instead of an exact pixel: a tap that
   * lands just off a coastline, or on an impassable mountain pixel inside a
   * player's land, snaps to the land the player obviously meant before the
   * attack is routed. Nearest is by Euclidean distance (ties broken by shortest
   * crossing, then `TileRef`), and the search is a bounded box scan — `maxRadius`
   * is small, so this stays cheap and fully deterministic.
   */
  nearestCapturable(ref: TileRef, maxRadius: number = CLICK_SNAP_RADIUS): TileRef | null {
    if (this.isCapturable(ref)) return ref;
    const cx = this.map.x(ref);
    const cy = this.map.y(ref);
    let best: TileRef | null = null;
    let bestScore = Infinity;
    for (let dy = -maxRadius; dy <= maxRadius; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= this.map.height) continue;
      for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
        const x = cx + dx;
        if (x < 0 || x >= this.map.width) continue;
        const candidate = this.map.ref(x, y);
        if (!this.isCapturable(candidate)) continue;
        const score = dx * dx + dy * dy;
        if (score < bestScore || (score === bestScore && (best === null || candidate < best))) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    return best;
  }

  /** Register a player with a starting troop pool. Throws on bad/duplicate id. */
  addPlayer(id: PlayerId, troops = 0): void {
    if (!Number.isInteger(id) || id <= NEUTRAL_PLAYER) {
      throw new Error(`Player id must be an integer >= 1, got ${id}.`);
    }
    if (this.standings.has(id)) {
      throw new Error(`Player ${id} already exists.`);
    }
    if (troops < 0) {
      throw new Error(`Starting troops must be non-negative, got ${troops}.`);
    }
    this.standings.set(id, {
      troops,
      gold: STARTING_GOLD,
      tiles: new Set(),
      modifiers: { ...IDENTITY_MODIFIERS },
      buildingCounts: new Map(),
    });
  }

  /** This player's gameplay modifiers. */
  modifiersOf(id: PlayerId): PlayerModifiers {
    return this.standing(id).modifiers;
  }

  /** Replace this player's modifiers. */
  setModifiers(id: PlayerId, modifiers: PlayerModifiers): void {
    this.standing(id).modifiers = modifiers;
  }

  /** Convenience for the snapshot: this player's income multiplier. */
  incomeMultiplierOf(id: PlayerId): number {
    return this.standing(id).modifiers.income;
  }

  /**
   * The crossing range (in water tiles) this player can currently project,
   * scaling the base reach by their sea-range modifier (Sea God / Admiral). The
   * crossing graph and ship pathfinding both honour this, so a larger range
   * reaches farther coasts.
   */
  seaRangeOf(id: PlayerId): number {
    // Each port the player holds widens the base reach on top of any modifier.
    const portReach = this.buildingCountOf(id, "port") * PORT_SEA_RANGE_PER;
    const scaled = Math.round(MAX_SEA_CROSSING_TILES * (this.standing(id).modifiers.seaRange + portReach));
    // Bound the reach (and thus the per-launch BFS cost) even if perks/ports stack.
    return Math.min(MAX_SEA_CROSSING_TILES * MAX_SEA_RANGE_MULTIPLIER, scaled);
  }

  hasPlayer(id: PlayerId): boolean {
    return this.standings.has(id);
  }

  /** All registered player ids, in ascending order for deterministic iteration. */
  players(): PlayerId[] {
    return [...this.standings.keys()].sort((a, b) => a - b);
  }

  private standing(id: PlayerId): PlayerStanding {
    const standing = this.standings.get(id);
    if (!standing) throw new Error(`Unknown player ${id}.`);
    return standing;
  }

  /** Owner of a tile (0 = neutral). */
  ownerOf(ref: TileRef): PlayerId {
    return this.owner[ref];
  }

  /** Troop pool of a player. */
  troopsOf(id: PlayerId): number {
    return this.standing(id).troops;
  }

  setTroops(id: PlayerId, troops: number): void {
    this.standing(id).troops = Math.max(0, troops);
  }

  addTroops(id: PlayerId, delta: number): void {
    const standing = this.standing(id);
    standing.troops = Math.max(0, standing.troops + delta);
  }

  /** Gold pool of a player. */
  goldOf(id: PlayerId): number {
    return this.standing(id).gold;
  }

  setGold(id: PlayerId, gold: number): void {
    this.standing(id).gold = Math.max(0, gold);
  }

  addGold(id: PlayerId, delta: number): void {
    const standing = this.standing(id);
    standing.gold = Math.max(0, standing.gold + delta);
  }

  /** Number of tiles a player currently owns. */
  tileCountOf(id: PlayerId): number {
    return this.standing(id).tiles.size;
  }

  /**
   * Some tile this player currently owns (set-iteration order; O(1)), or
   * `undefined` when they hold none. Cheap enough to call every tick — used to
   * sample a player's last ground so the conqueror who takes their final tile
   * can be credited when the player is wiped off the map.
   */
  anyTileOf(id: PlayerId): TileRef | undefined {
    for (const ref of this.standing(id).tiles) return ref;
    return undefined;
  }

  /**
   * A snapshot array of every tile a player currently owns. Returns a fresh copy
   * (not the live set), so callers can safely {@link claim} tiles away while
   * iterating — used when an eliminated player's territory is turned neutral.
   * Ascending `TileRef` order for determinism.
   */
  tilesOf(id: PlayerId): TileRef[] {
    return [...this.standing(id).tiles].sort((a, b) => a - b);
  }

  /**
   * Assign a capturable tile to a player (or to {@link NEUTRAL_PLAYER}),
   * keeping per-player tile counts in sync. Throws if the tile is not
   * capturable terrain.
   */
  claim(ref: TileRef, id: PlayerId): void {
    if (!this.isCapturable(ref)) {
      throw new Error(`Tile ${ref} is not capturable terrain.`);
    }
    const previous = this.owner[ref];
    if (previous === id) return;
    const comp = this.landComponent[ref];
    // A building cannot survive its tile changing hands — raze it (and any fort
    // aura) so the conqueror takes bare ground, not the loser's economy.
    if (this.buildings.has(ref)) this.destroyBuilding(ref, previous);
    if (previous !== NEUTRAL_PLAYER) {
      this.standing(previous).tiles.delete(ref);
      this.bumpComponent(previous, comp, -1);
    }
    if (id !== NEUTRAL_PLAYER) {
      this.standing(id).tiles.add(ref);
      this.bumpComponent(id, comp, 1);
    }
    this.owner[ref] = id;
  }

  /**
   * Mark a tile as a defense post — a fortified location that makes capturing
   * ground within `radius` tiles dearer (peaking at `strength`× cost on the post
   * itself). Re-marking the same tile replaces its aura. Throws on non-capturable
   * terrain or an out-of-range strength/radius.
   */
  addDefensePost(
    ref: TileRef,
    radius = DEFENSE_POST_RADIUS,
    strength = DEFENSE_POST_STRENGTH,
  ): void {
    if (!this.isCapturable(ref)) throw new Error(`Tile ${ref} cannot hold a defense post.`);
    if (radius < 0) throw new Error(`Defense-post radius must be >= 0, got ${radius}.`);
    if (strength < 1) throw new Error(`Defense-post strength must be >= 1, got ${strength}.`);
    this.defensePosts.set(ref, { radius, strength });
  }

  /** Remove the defense post on `ref`, if any. Returns whether one was removed. */
  removeDefensePost(ref: TileRef): boolean {
    return this.defensePosts.delete(ref);
  }

  /** True if `ref` currently holds a defense post. */
  hasDefensePost(ref: TileRef): boolean {
    return this.defensePosts.has(ref);
  }

  /** Number of active defense posts (for tests/snapshots). */
  get defensePostCount(): number {
    return this.defensePosts.size;
  }

  /**
   * Capture-cost multiplier (>= 1) at `ref` from any overlapping defense posts.
   * Each post contributes `1 + (strength - 1) * (1 - dist/radius)` for Chebyshev
   * distances within its radius; the strongest covering post wins (auras don't
   * stack, keeping the factor bounded). Returns 1 where no post reaches.
   */
  defenseFactorAt(ref: TileRef): number {
    if (this.defensePosts.size === 0) return 1;
    const x = this.map.x(ref);
    const y = this.map.y(ref);
    let factor = 1;
    for (const [post, { radius, strength }] of this.defensePosts) {
      const dist = Math.max(Math.abs(x - this.map.x(post)), Math.abs(y - this.map.y(post)));
      if (dist > radius) continue;
      const falloff = radius === 0 ? 1 : 1 - dist / radius;
      const contribution = 1 + (strength - 1) * falloff;
      if (contribution > factor) factor = contribution;
    }
    return factor;
  }

  // --- Buildings ------------------------------------------------------------

  /** The building standing on `ref`, or `undefined` if the tile is bare. */
  buildingAt(ref: TileRef): BuildingType | undefined {
    return this.buildings.get(ref);
  }

  /** True if `ref` already carries a building. */
  hasBuilding(ref: TileRef): boolean {
    return this.buildings.has(ref);
  }

  /**
   * How many buildings of `type` `player` owns — used both for the geometric
   * cost ramp and for building effects (city income, port reach). Counting a
   * single type keeps the hot economy path off a full {@link buildings} scan.
   */
  buildingCountOf(player: PlayerId, type: BuildingType): number {
    return this.standing(player).buildingCounts.get(type) ?? 0;
  }

  /** Total active buildings on the map (for tests/snapshots). */
  get buildingCount(): number {
    return this.buildings.size;
  }

  /** Every placed building as `[tile, type]` pairs, in ascending tile order. */
  buildingEntries(): Array<[TileRef, BuildingType]> {
    return [...this.buildings.entries()].sort((a, b) => a[0] - b[0]);
  }

  /**
   * Place a `type` building on `ref`, owned by the tile's current owner. The
   * caller is responsible for having charged the gold cost first. A fort also
   * raises a {@link defensePosts} aura around itself; a port/city take effect
   * through the counts maintained here. Throws if the tile isn't owned by a real
   * player or already holds a building (one structure per tile).
   */
  placeBuilding(ref: TileRef, type: BuildingType): void {
    const owner = this.owner[ref];
    if (owner === NEUTRAL_PLAYER || !this.isCapturable(ref)) {
      throw new Error(`Tile ${ref} must be owned land to hold a building.`);
    }
    if (this.buildings.has(ref)) {
      throw new Error(`Tile ${ref} already has a building.`);
    }
    this.buildings.set(ref, type);
    const counts = this.standing(owner).buildingCounts;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === "fort") this.addDefensePost(ref, FORT_DEFENSE_RADIUS, FORT_DEFENSE_STRENGTH);
  }

  /**
   * Tear down the building on `ref`, if any, decrementing its owner's count and
   * (for a fort) dropping its defense aura. Called from {@link claim} whenever a
   * tile changes hands, since a structure cannot survive losing the ground under
   * it. `previousOwner` is the player who held the tile (and thus the building)
   * before the change. Returns whether a building was removed.
   */
  private destroyBuilding(ref: TileRef, previousOwner: PlayerId): boolean {
    const type = this.buildings.get(ref);
    if (type === undefined) return false;
    this.buildings.delete(ref);
    if (previousOwner !== NEUTRAL_PLAYER) {
      const counts = this.standing(previousOwner).buildingCounts;
      const next = (counts.get(type) ?? 0) - 1;
      if (next > 0) counts.set(type, next);
      else counts.delete(type);
    }
    if (type === "fort") this.removeDefensePost(ref);
    return true;
  }

  /** True if any 4-connected land neighbour of `ref` is owned by `attacker`. */
  hasLandFrontier(attacker: PlayerId, ref: TileRef): boolean {
    for (const n of this.map.neighbors(ref)) {
      if (this.owner[n] === attacker) return true;
    }
    return false;
  }

  /**
   * Capturable `target` tiles `attacker` could expand into across a **land
   * border only** (no sea crossings). This is what the conflict engine advances
   * each tick: water travel is handled separately by transport ships, so a land
   * attack never leaps a strait. Returned in ascending `TileRef` order.
   */
  landFrontierOf(attacker: PlayerId, target: PlayerId): TileRef[] {
    const found = new Set<TileRef>();
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) {
        if (this.owner[n] === target && this.isCapturable(n)) found.add(n);
      }
    }
    return [...found].sort((a, b) => a - b);
  }

  /**
   * True if `attacker` owns a tile sharing a land border with a `target` tile —
   * i.e. the two are contiguous on land. Gates land attacks (which never cross
   * water); reachability across water is decided by {@link findSeaPath} instead.
   */
  hasLandBorderWith(attacker: PlayerId, target: PlayerId): boolean {
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) {
        if (this.owner[n] === target && this.isCapturable(n)) return true;
      }
    }
    return false;
  }

  /**
   * Shortest water route a transport ship would take from `attacker`'s coast to
   * land on `dest`, or `null` if `dest` is not a capturable tile the attacker can
   * reach across open water at all (no navigable water connects the two coasts).
   *
   * Mirroring OpenFront's transport ships, there is **no maximum crossing width**:
   * a boat will sail across an ocean of any size so long as a continuous water
   * route exists — the cost of a long crossing is paid in travel time and the
   * boat-count cap, not a hard reachability wall. `maxCrossing` defaults to
   * unbounded; callers may still pass a finite cap (e.g. the precomputed
   * narrow-strait frontier heuristic) to bound the search.
   *
   * The returned path is land→water…water→land: it starts on the attacker's
   * embarkation tile (an owned coastal tile), runs through the open-water tiles
   * the ship sails, and ends on `dest`. A single BFS is run *outward from the
   * destination's bordering water*, so the first attacker-owned coast it reaches
   * is necessarily the nearest one — giving both the launch point and the
   * shortest crossing in one pass. Deterministic: the map's fixed neighbour order
   * makes the search reproducible, ties broken by that order.
   */
  findSeaPath(attacker: PlayerId, dest: TileRef, maxCrossing: number = Number.POSITIVE_INFINITY): TileRef[] | null {
    if (!this.isCapturable(dest) || this.owner[dest] === attacker) return null;

    // Per-water-tile BFS scratch, generation-stamped so we never clear the whole
    // map between calls: `parent` reconstructs the route, `depth` bounds it.
    const size = this.map.size;
    const parent = (this.seaPathParent ??= new Int32Array(size));
    const depth = (this.seaPathDepth ??= new Int32Array(size));
    const stamp = (this.seaPathStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.seaPathGeneration = (this.seaPathGeneration ?? 0) + 1);
    const queue: TileRef[] = [];

    // Seed with the open-water tiles directly bordering the destination coast.
    for (const n of this.map.neighbors(dest)) {
      if (this.map.isWater(n) && stamp[n] !== generation) {
        stamp[n] = generation;
        parent[n] = dest;
        depth[n] = 1;
        queue.push(n);
      }
    }

    for (let head = 0; head < queue.length; head += 1) {
      const water = queue[head];
      for (const n of this.map.neighbors(water)) {
        if (this.owner[n] === attacker && this.isCapturable(n)) {
          // Reached the near coast. Parent pointers run water→dest, so walking
          // from `water` already yields embarkation→…→dest order: [coast, water,
          // …, seed-water, dest]. No reversal needed.
          const path: TileRef[] = [n];
          for (let t = water; t !== dest; t = parent[t]) path.push(t);
          path.push(dest);
          return path;
        }
        if (this.map.isWater(n) && stamp[n] !== generation && depth[water] < maxCrossing) {
          stamp[n] = generation;
          parent[n] = water;
          depth[n] = depth[water] + 1;
          queue.push(n);
        }
      }
    }
    return null;
  }

  /**
   * Pick the best amphibious landing for a click that fell anywhere on a
   * landmass the attacker can't march to: the capturable coastal tile, reachable
   * by sea from any of the attacker's coasts, that lies nearest the clicked tile.
   *
   * The player should be able to click a target area — even its interior — and
   * have a boat sail to the area's nearest reachable shore, rather than having to
   * pixel-hunt for a tile that is both coastal and in range. Like OpenFront's
   * `closestShoreByWater`, this floods the open water outward from *every* tile
   * the attacker holds (a single multi-source BFS) and, of all the enemy/neutral
   * shores that flood reaches, keeps the one closest to the click (Euclidean;
   * ties broken by `TileRef`). The flood is **unbounded** — a shore across a wide
   * ocean is just as reachable as one across a one-tile strait, only farther to
   * sail — so the only way to get `null` is a coast that no continuous water
   * route connects to the attacker (e.g. a landlocked player, or a target on an
   * unconnected body of water).
   *
   * Returns the landing tile (a valid {@link findSeaPath} destination), or
   * `null` if no shore is reachable across water.
   */
  resolveSeaLanding(attacker: PlayerId, clickRef: TileRef): TileRef | null {
    const cx = this.map.x(clickRef);
    const cy = this.map.y(clickRef);

    // Generation-stamped scratch so we never clear the whole map between calls.
    const stamp = (this.seaLandStamp ??= new Int32Array(this.map.size).fill(-1));
    const generation = (this.seaLandGeneration = (this.seaLandGeneration ?? 0) + 1);
    const queue: TileRef[] = [];

    // Seed the flood with every open-water tile bordering one of the attacker's
    // own tiles — the waters a ship could embark onto.
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) {
        if (this.map.isWater(n) && stamp[n] !== generation) {
          stamp[n] = generation;
          queue.push(n);
        }
      }
    }

    let best: TileRef | null = null;
    let bestScore = Infinity;
    for (let head = 0; head < queue.length; head += 1) {
      const water = queue[head];
      for (const n of this.map.neighbors(water)) {
        if (this.map.isWater(n)) {
          if (stamp[n] !== generation) {
            stamp[n] = generation;
            queue.push(n);
          }
        } else if (this.owner[n] !== attacker && this.isCapturable(n)) {
          // A capturable far-bank shore the flood can reach — a landing candidate.
          const dx = this.map.x(n) - cx;
          const dy = this.map.y(n) - cy;
          const score = dx * dx + dy * dy;
          if (score < bestScore || (score === bestScore && (best === null || n < best))) {
            bestScore = score;
            best = n;
          }
        }
      }
    }
    return best;
  }

  /**
   * Capturable tiles owned by `target` that `attacker` could expand into this
   * tick — adjacent across a land border, or reachable by an amphibious landing
   * across a narrow sea. Returned in ascending `TileRef` order for determinism.
   *
   * `target` may be {@link NEUTRAL_PLAYER} to expand into unclaimed land.
   *
   * Expansion can only ever radiate outward from tiles the attacker already
   * holds, so we walk the attacker's owned set and collect the qualifying
   * neighbours rather than scanning the whole raster.
   */
  frontierOf(attacker: PlayerId, target: PlayerId): TileRef[] {
    const found = new Set<TileRef>();
    const seaRange = this.seaRangeOf(attacker);
    const consider = (ref: TileRef): void => {
      if (this.owner[ref] === target && this.isCapturable(ref)) found.add(ref);
    };
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) consider(n);
      for (const n of this.seaLinks.neighborsWithin(ref, seaRange)) consider(n);
    }
    return [...found].sort((a, b) => a - b);
  }

  /**
   * Every owner whose tiles `attacker` could expand into this tick — neutral
   * land and bordering opponents alike — with the number of distinct frontier
   * tiles touching each and a deterministic sample tile (lowest `TileRef`) to
   * aim an intent at.
   *
   * Counts both land borders and amphibious (sea-link) crossings, mirroring
   * {@link frontierOf}, so it naturally surfaces enemies reachable only across a
   * narrow strait. Each frontier tile is counted once even when several owned
   * tiles touch it. Returned in ascending target-id order ({@link NEUTRAL_PLAYER}
   * first when present).
   *
   * This is a single pass over the attacker's owned set, so it is far cheaper
   * than calling {@link frontierOf} once per candidate target — the shape a bot
   * needs to weigh "grab neutral land vs. attack which neighbour" every decision.
   */
  frontierTargets(attacker: PlayerId): Array<{ target: PlayerId; tiles: number; sample: TileRef }> {
    const acc = new Map<PlayerId, { tiles: number; sample: TileRef }>();
    const seen = new Set<TileRef>();
    const seaRange = this.seaRangeOf(attacker);
    const consider = (ref: TileRef): void => {
      const owner = this.owner[ref];
      if (owner === attacker || !this.isCapturable(ref) || seen.has(ref)) return;
      seen.add(ref);
      const entry = acc.get(owner);
      if (!entry) {
        acc.set(owner, { tiles: 1, sample: ref });
      } else {
        entry.tiles += 1;
        if (ref < entry.sample) entry.sample = ref;
      }
    };
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) consider(n);
      for (const n of this.seaLinks.neighborsWithin(ref, seaRange)) consider(n);
    }
    return [...acc.entries()]
      .map(([target, value]) => ({ target, tiles: value.tiles, sample: value.sample }))
      .sort((a, b) => a.target - b.target);
  }

  /**
   * True if `attacker` owns at least one tile bordering a tile of `target`,
   * counting amphibious crossings as borders.
   */
  hasFrontier(attacker: PlayerId, target: PlayerId): boolean {
    const seaRange = this.seaRangeOf(attacker);
    const reaches = (ref: TileRef): boolean =>
      this.owner[ref] === target && this.isCapturable(ref);
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) if (reaches(n)) return true;
      for (const n of this.seaLinks.neighborsWithin(ref, seaRange)) if (reaches(n)) return true;
    }
    return false;
  }
}
