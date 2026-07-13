import type { GameMap, TileRef } from "./GameMap.js";
import {
  CLICK_SNAP_RADIUS,
  LAND_ATTACK_REACH,
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  SEA_TARGET_SCAN_BUDGET,
} from "./rasterCombatConfig.js";
import { IDENTITY_MODIFIERS, type PlayerModifiers } from "./playerModifiers.js";
import {
  type BuildingType,
  FORT_DEFENSE_RADIUS,
  FORT_DEFENSE_STRENGTH,
  STARTING_GOLD,
} from "./buildings.js";

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
  /**
   * The subset of `tiles` on the player's territory edge: owned tiles with at
   * least one 4-neighbour they don't own (enemy, neutral land, water or rock).
   * Maintained incrementally by {@link TerritoryGrid.claim} — a tile's border
   * status only changes when it or a neighbour changes hands, so the upkeep is
   * O(1) per claim. Every frontier derivation (land fronts, boat targets,
   * launchable water) only ever needs edge tiles, so iterating this set instead
   * of `tiles` turns those scans from O(territory) into O(perimeter) — the
   * difference between a 500k-tile empire and its ~5k-tile edge, every tick.
   */
  border: Set<TileRef>;
  /** Per-player gameplay modifiers; defaults to no effect. */
  modifiers: PlayerModifiers;
  /** How many of each building type this player currently owns (instances). */
  buildingCounts: Map<BuildingType, number>;
  /**
   * Sum of levels across this player's buildings of each type — the **cost
   * counter**: every build *or upgrade* of a type bumps it by one, so the next
   * build/upgrade of that type costs the next step of the ramp (OpenFront's
   * v24 structure upgrades share the build ramp). Equals `buildingCounts` while
   * everything is level 1.
   */
  buildingLevelTotals: Map<BuildingType, number>;
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
 * Open water is a hard barrier to *land* fronts; the only way across it is an
 * explicit transport ship, which can sail anywhere within a connected body of
 * water — see {@link findSeaPath} and {@link resolveSeaLanding}.
 */
export class TerritoryGrid {
  readonly map: GameMap;
  /** Owner id per tile; index is a `TileRef`. 0 = neutral. */
  readonly owner: Uint16Array;
  /** Total number of capturable (ownable) tiles on the map. */
  readonly capturableCount: number;
  /**
   * Connected-land-component label per tile: capturable tiles in the same
   * 4-connected landmass share an id; water and impassable rock are -1. Terrain
   * is immutable so this is computed once. It answers "can a land front ever
   * reach this tile from there?" — the basis for routing a click to a contiguous
   * land attack versus a transport ship across open water.
   */
  private readonly landComponent: Int32Array;
  /**
   * Connected-water-component label per tile: water tiles in the same 4-connected
   * body of water (an ocean, a sea, a lake, or a river joined to one) share an
   * id; land is -1. A transport ship can sail anywhere within a single body, so
   * two coasts are boat-reachable from each other iff they touch the same water
   * component — the basis (like OpenFront) for amphibious reach with no fixed
   * distance cap. Computed once; terrain is immutable.
   */
  private readonly waterComponent: Int32Array;
  /**
   * Per-player tile counts bucketed by land component, so "does this player hold
   * any ground on `dest`'s landmass?" is an O(1) lookup. Maintained in
   * {@link claim}; only real players are tracked (neutral land is irrelevant to
   * routing).
   */
  private readonly componentCounts = new Map<PlayerId, Map<number, number>>();

  private readonly standings = new Map<PlayerId, PlayerStanding>();
  /**
   * Cached ascending list of registered player ids, returned by {@link players}.
   * The standings set only ever grows (via {@link addPlayer}; eliminated players
   * keep their zero-tile standing), so this is invalidated only when a player is
   * added and otherwise reused — keeping the per-tick `players()` calls (income,
   * victory check, snapshot, …) off a fresh allocate-and-sort every time.
   */
  private playerIdsCache: PlayerId[] | null = null;

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
   * aura; a port and a city both feed the economy (handled by the conflict
   * engine, which reads {@link buildingCountOf}).
   */
  private readonly buildings = new Map<TileRef, BuildingType>();
  /**
   * Structure level per tile, only for buildings **above level 1** (absent =
   * level 1, the map stays tiny). Building on your own structure of the same
   * type upgrades it (OpenFront v24): each level re-applies the type's effect
   * (a level-2 city lifts the cap twice, a level-2 port/factory dispatches at
   * twice the cadence).
   */
  private readonly buildingLevels = new Map<TileRef, number>();
  /**
   * Buildings still under construction: tile → its build window `{start, ready}`
   * in engine ticks. A building counts toward its owner's cost ramp the moment it
   * is placed, but its *effects* (city population cap, rail/trade station, fort
   * aura, warship interception) only switch on once it leaves this map at
   * {@link activateDue}. Empty = nothing building.
   */
  private readonly construction = new Map<TileRef, { start: number; ready: number }>();
  /**
   * Radioactive fallout tiles, exactly OpenFront's model: a nuked tile is
   * cleared to neutral and marked here **permanently** — there is no decay
   * timer. Fallout land stays capturable (at a stiff combat penalty, see
   * `falloutCombatModifier` in `rasterCombatConfig`) and the mark is lifted the
   * moment the tile is conquered ({@link claim}), mirroring OpenFront's
   * `conquer(...) → setFallout(tile, false)`. The client tints marked tiles.
   * Empty = nowhere is irradiated (the common case, so lookups stay O(1)-ish).
   */
  private readonly fallout = new Set<TileRef>();

  // Lazily-allocated, generation-stamped scratch buffers reused by every
  // {@link findSeaPath} call so per-launch pathfinding stays allocation-free.
  private seaPathParent?: Int32Array;
  private seaPathStamp?: Int32Array;
  private seaPathGeneration?: number;
  // Reused, generation-stamped scratch for the {@link findWaterRoute} BFS.
  private waterRouteParent?: Int32Array;
  private waterRouteStamp?: Int32Array;
  private waterRouteGeneration?: number;
  // Reused, generation-stamped scratch for the {@link resolveSeaLanding} BFS.
  private landingDepth?: Int32Array;
  private landingStamp?: Int32Array;
  private landingGeneration?: number;
  // Reused, generation-stamped scratch for the {@link seaTargetTiles} BFS.
  private seaScanStamp?: Int32Array;
  private seaScanGeneration?: number;
  // Reused, generation-stamped scratch for the {@link canReachByLand} BFS.
  private landReachStamp?: Int32Array;
  private landReachGeneration?: number;
  // Shared 4-slot scratch for allocation-free neighbour walks (never used
  // across nested walks — each loop iteration consumes it before the next).
  private readonly scratchNeighbors = new Int32Array(4);
  // Memoised shore-to-shore water routes (see {@link findWaterRoute}).
  private readonly waterRouteCache = new Map<string, TileRef[] | null>();
  // Cached sorted fallout list (see {@link falloutTiles}); null = stale.
  private falloutSorted: TileRef[] | null = null;
  /**
   * Notified whenever a building leaves the map (conquest raze, demolition),
   * so engines keeping per-building-tile state (SAM cooldowns, fort gun
   * timers, per-launcher RNG streams) can drop it — otherwise a *new*
   * structure built on the same tile inherits the dead one's timers.
   */
  private buildingDestroyedListener: ((ref: TileRef, type: BuildingType) => void) | null = null;

  /** Register the (single) building-destroyed listener; see its field doc. */
  setBuildingDestroyedListener(listener: (ref: TileRef, type: BuildingType) => void): void {
    this.buildingDestroyedListener = listener;
  }

  // Cached sorted building rosters (see {@link buildingEntries} /
  // {@link activeBuildingEntries}); null = stale. Both are read every tick by
  // several systems (snapshot, rails, trade, fort guns, warships, bots) while
  // the buildings map changes only on place/raze/activate.
  private buildingEntriesCache: Array<[TileRef, BuildingType]> | null = null;
  private activeBuildingEntriesCache: Array<[TileRef, BuildingType]> | null = null;

  constructor(map: GameMap) {
    this.map = map;
    this.owner = new Uint16Array(map.size);
    let capturable = 0;
    for (let ref = 0; ref < map.size; ref += 1) {
      if (map.isLand(ref) && !map.isImpassable(ref)) capturable += 1;
    }
    this.capturableCount = capturable;
    this.landComponent = this.labelLandComponents();
    this.waterComponent = this.labelWaterComponents();
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
   * Flood-fill the water into 4-connected components, returning a per-tile label
   * (-1 for land). Mirror of {@link labelLandComponents} for water: every ocean,
   * sea, lake and ocean-joined river gets its own id, so two coasts on the same
   * body of water share the component their bordering water carries.
   */
  private labelWaterComponents(): Int32Array {
    const label = new Int32Array(this.map.size).fill(-1);
    const stack: TileRef[] = [];
    let next = 0;
    for (let seed = 0; seed < this.map.size; seed += 1) {
      if (!this.map.isWater(seed) || label[seed] !== -1) continue;
      const id = next++;
      label[seed] = id;
      stack.length = 0;
      stack.push(seed);
      while (stack.length > 0) {
        const tile = stack.pop()!;
        for (const n of this.map.neighbors(tile)) {
          if (this.map.isWater(n) && label[n] === -1) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
    return label;
  }

  /**
   * The set of water-component ids `attacker` can launch a transport from: every
   * body of water touching one of their owned coasts. A target is boat-reachable
   * iff its bordering water belongs to one of these — connectivity, not distance,
   * gates amphibious reach. O(attacker's tiles).
   */
  private launchComponentsOf(attacker: PlayerId): Set<number> {
    const comps = new Set<number>();
    const scratch = this.scratchNeighbors;
    // Coastal tiles are border tiles by definition (water is never owned), so
    // the perimeter set suffices.
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.map.isWater(n)) comps.add(this.waterComponent[n]);
      }
    }
    return comps;
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
   * Connected-water-component id of `ref`: two water tiles share an id iff they
   * belong to the same body of water a boat could sail between. Land returns -1.
   * Stable for the life of the grid (terrain is immutable).
   */
  waterComponentId(ref: TileRef): number {
    return this.waterComponent[ref];
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

  /**
   * True if a land attack could march from `player`'s territory to a **neutral**
   * `dest` over a *bounded* corridor of **unowned** land — i.e. `dest` is close
   * enough, over ground nobody else holds, that crossing it on foot is the
   * sensible route. This is OpenFront's neutral-land half of `canAttack`: a
   * 4-connected BFS spreads out of `dest` over neutral land only and succeeds the
   * instant it touches a tile `player` owns, giving up once it has travelled
   * `maxSteps` tiles.
   *
   * Two properties matter, both matching OpenFront. **The corridor is neutral
   * only:** a front can't march *through* a third party's territory to reach the
   * far side, so a chain blocked by someone else's land fails here and falls
   * through to a boat — the fix for an enemy wedged between two coasts. **The
   * reach is bounded:** two coasts of one giant landmass are technically
   * land-connected, so an unbounded "same landmass?" test ({@link
   * ownsLandComponentOf}) would always answer "march" and crawl a front the long
   * way round a bay; the cap makes a far coast fall through to an amphibious
   * order ({@link resolveSeaLanding}) exactly when the land detour is long.
   *
   * Only meaningful for a neutral `dest`: a march onto a *player's* tile is gated
   * purely by a shared border ({@link hasLandBorderWith}), as in OpenFront. Fast-
   * rejects via {@link ownsLandComponentOf} when `dest` is on a landmass the
   * player holds no ground on. Generation-stamped scratch keeps repeated calls
   * allocation-free.
   */
  canReachByLand(player: PlayerId, dest: TileRef, maxSteps: number = LAND_ATTACK_REACH): boolean {
    if (!this.isCapturable(dest)) return false;
    // Different landmass (or none) → no land route exists at any distance.
    if (!this.ownsLandComponentOf(player, dest)) return false;

    const size = this.map.size;
    const stamp = (this.landReachStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.landReachGeneration = (this.landReachGeneration ?? 0) + 1);
    // Parallel depth tracked in the queue so we can stop past `maxSteps`.
    const queue: TileRef[] = [dest];
    const depth: number[] = [0];
    stamp[dest] = generation;

    const scratch = this.scratchNeighbors;
    for (let head = 0; head < queue.length; head += 1) {
      const tile = queue[head];
      const d = depth[head];
      const count = this.map.neighborsInto(tile, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        // Touching the player's own ground means a contiguous front can reach here.
        if (this.owner[n] === player) return true;
        // Only spread through *neutral* land: a march can't pass through a third
        // party's territory (OpenFront). Enemy-held ground blocks the corridor.
        if (d < maxSteps && this.isCapturable(n) && this.owner[n] === NEUTRAL_PLAYER && stamp[n] !== generation) {
          stamp[n] = generation;
          queue.push(n);
          depth.push(d + 1);
        }
      }
    }
    return false;
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

  /** Mark `ref` radioactive (a nuke blast). Permanent until the tile is conquered. */
  setFallout(ref: TileRef): void {
    if (!this.fallout.has(ref)) {
      this.fallout.add(ref);
      this.falloutSorted = null;
    }
  }

  /** Whether `ref` is currently radioactive fallout (dearer and slower to capture). */
  hasFallout(ref: TileRef): boolean {
    return this.fallout.has(ref);
  }

  /**
   * Active fallout tiles, ascending — for the snapshot's fallout overlay.
   * Cached between mutations: this is read every broadcast tick, while the set
   * only changes on a detonation or a conquest of irradiated ground — without
   * the cache a nuke-heavy match pays an O(F log F) sort of a set that only
   * ever grows, 10 times a second, forever. Callers must not mutate the result.
   */
  falloutTiles(): readonly TileRef[] {
    return (this.falloutSorted ??= [...this.fallout].sort((a, b) => a - b));
  }

  /**
   * Number of tiles currently under fallout — the numerator of OpenFront's
   * `falloutRatio` (over the map's land tiles), which scales the fallout
   * combat penalty as the world grows more irradiated.
   */
  get falloutCount(): number {
    return this.fallout.size;
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
      border: new Set(),
      modifiers: { ...IDENTITY_MODIFIERS },
      buildingCounts: new Map(),
      buildingLevelTotals: new Map(),
    });
    this.playerIdsCache = null;
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
   * How many transport ships this player may have at sea simultaneously: the base
   * {@link MAX_TRANSPORT_SHIPS_PER_PLAYER} scaled by their `shipCapacity` modifier
   * and floored at 1. Routes the ship cap through per-player plumbing rather than
   * reading the bare constant, so a future perk can flex it. With the baseline
   * (identity) modifiers this is exactly the base cap.
   */
  maxShipsOf(id: PlayerId): number {
    return Math.max(1, Math.round(MAX_TRANSPORT_SHIPS_PER_PLAYER * this.standing(id).modifiers.shipCapacity));
  }

  hasPlayer(id: PlayerId): boolean {
    return this.standings.has(id);
  }

  /**
   * All registered player ids, in ascending order for deterministic iteration.
   * Returns a cached, shared array (rebuilt only when a player is added) — treat
   * it as read-only; callers that need to mutate should copy it first.
   */
  players(): PlayerId[] {
    if (this.playerIdsCache === null) {
      this.playerIdsCache = [...this.standings.keys()].sort((a, b) => a - b);
    }
    return this.playerIdsCache;
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
   * Live, read-only view of a player's tiles in claim (insertion) order — for
   * bounded sampling passes that don't need the sorted copy {@link tilesOf}
   * makes (copy + sort of a 500k-tile empire is not free). Deterministic for
   * a given command history. Callers must not mutate the set or claim tiles
   * while iterating.
   */
  tilesViewOf(id: PlayerId): ReadonlySet<TileRef> {
    return this.standing(id).tiles;
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
      const standing = this.standing(previous);
      standing.tiles.delete(ref);
      standing.border.delete(ref);
      this.bumpComponent(previous, comp, -1);
    }
    if (id !== NEUTRAL_PLAYER) {
      this.standing(id).tiles.add(ref);
      this.bumpComponent(id, comp, 1);
      // Conquering ground scrubs it clean, mirroring OpenFront's
      // `conquer(...) → setFallout(tile, false)`: fallout lives only on
      // unowned land, and taking the tile is the (one) way to reclaim it.
      if (this.fallout.delete(ref)) this.falloutSorted = null;
    }
    this.owner[ref] = id;
    // Border upkeep: this tile and each owned neighbour may have entered or
    // left their owner's territory edge.
    this.refreshBorderStatus(ref);
    const width = this.map.width;
    const x = ref % width;
    if (x > 0) this.refreshBorderStatus(ref - 1);
    if (x + 1 < width) this.refreshBorderStatus(ref + 1);
    if (ref >= width) this.refreshBorderStatus(ref - width);
    if (ref + width < this.owner.length) this.refreshBorderStatus(ref + width);
  }

  /** Re-derive whether `ref` sits on its owner's territory edge (see {@link PlayerStanding.border}). */
  private refreshBorderStatus(ref: TileRef): void {
    const id = this.owner[ref];
    if (id === NEUTRAL_PLAYER) return;
    const owner = this.owner;
    const width = this.map.width;
    const x = ref % width;
    const isBorder =
      (x > 0 && owner[ref - 1] !== id) ||
      (x + 1 < width && owner[ref + 1] !== id) ||
      (ref >= width && owner[ref - width] !== id) ||
      (ref + width < owner.length && owner[ref + width] !== id);
    const border = this.standing(id).border;
    if (isBorder) border.add(ref);
    else border.delete(ref);
  }

  /**
   * Mark a tile as a defense post — a fortified location that makes capturing
   * ground within `radius` tiles dearer (peaking at `strength`× cost on the post
   * itself). Re-marking the same tile replaces its aura. Throws on non-capturable
   * terrain or an out-of-range strength/radius.
   */
  addDefensePost(ref: TileRef, radius: number, strength: number): void {
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
   * Capture-cost multiplier (>= 1) at `ref` from the **tile owner's** overlapping
   * defense posts. Mirrors OpenFront's defense post exactly: only a post owned by
   * the defender itself protects the tile (OpenFront checks
   * `dp.unit.owner() === defender`, so a fort near a border never taxes its own
   * owner's or a third party's assaults), and the bonus is **binary in-range** —
   * every tile within a post's Chebyshev `radius` costs the full `strength`× (no
   * linear falloff), beyond it nothing. The strongest covering post wins (auras
   * don't stack). Returns 1 where no post of the owner reaches, and always 1 on
   * neutral ground. In OpenFront this is `defensePostDefenseBonus` (5×) inside
   * `defensePostRange` (30); the companion `defensePostSpeedBonus` (3×) is
   * applied by the conflict engine to the tile's advance-budget drain.
   */
  defenseFactorAt(ref: TileRef): number {
    if (this.defensePosts.size === 0) return 1;
    const owner = this.ownerOf(ref);
    if (owner === NEUTRAL_PLAYER) return 1;
    const x = this.map.x(ref);
    const y = this.map.y(ref);
    let factor = 1;
    for (const [post, { radius, strength }] of this.defensePosts) {
      if (this.ownerOf(post) !== owner) continue;
      const dist = Math.max(Math.abs(x - this.map.x(post)), Math.abs(y - this.map.y(post)));
      if (dist > radius) continue;
      if (strength > factor) factor = strength;
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

  /**
   * Every placed building as `[tile, type]` pairs, in ascending tile order.
   * Cached between building mutations — callers must not mutate the result.
   */
  buildingEntries(): Array<[TileRef, BuildingType]> {
    return (this.buildingEntriesCache ??= [...this.buildings.entries()].sort((a, b) => a[0] - b[0]));
  }

  /**
   * Place a `type` building on `ref`, owned by the tile's current owner. The
   * caller is responsible for having charged the gold cost first. A fort also
   * raises a {@link defensePosts} aura around itself; a port/city take effect
   * through the counts maintained here. Throws if the tile isn't owned by a real
   * player or already holds a building (one structure per tile).
   */
  placeBuilding(ref: TileRef, type: BuildingType, startTick = 0, readyTick = 0): void {
    if (type === "warship") {
      // A warship is a mobile unit, never a structure — buy it through the
      // session/conflict (`launchWarship`), which spawns it at a port.
      throw new Error("A warship is a mobile unit, not a structure — use RasterConflict.launchWarship.");
    }
    const owner = this.owner[ref];
    if (owner === NEUTRAL_PLAYER || !this.isCapturable(ref)) {
      throw new Error(`Tile ${ref} must be owned land to hold a building.`);
    }
    if (this.buildings.has(ref)) {
      throw new Error(`Tile ${ref} already has a building.`);
    }
    this.buildings.set(ref, type);
    this.buildingEntriesCache = null;
    this.activeBuildingEntriesCache = null;
    const standing = this.standing(owner);
    standing.buildingCounts.set(type, (standing.buildingCounts.get(type) ?? 0) + 1);
    standing.buildingLevelTotals.set(type, (standing.buildingLevelTotals.get(type) ?? 0) + 1);
    if (readyTick > startTick) {
      // Under construction: effects switch on later, at activateDue.
      this.construction.set(ref, { start: startTick, ready: readyTick });
    } else if (type === "fort") {
      // Instantly active (the default, used by tests/direct placement).
      this.addDefensePost(ref, FORT_DEFENSE_RADIUS, FORT_DEFENSE_STRENGTH);
    }
  }

  /**
   * Raise the level of the building on `ref` by one — the caller has already
   * verified ownership and charged the (next-ramp-step) gold cost. Levels
   * re-apply the type's effect; the owner's {@link PlayerStanding.buildingLevelTotals}
   * cost counter bumps so the following build/upgrade costs the next step.
   * Throws on a bare tile or one still under construction. Returns the new level.
   */
  upgradeBuilding(ref: TileRef): number {
    const type = this.buildings.get(ref);
    if (type === undefined) throw new Error(`Tile ${ref} has no building to upgrade.`);
    if (this.construction.has(ref)) throw new Error(`Tile ${ref} is still under construction.`);
    const owner = this.owner[ref];
    if (owner === NEUTRAL_PLAYER) throw new Error(`Tile ${ref} is not owned.`);
    const next = this.buildingLevelOf(ref) + 1;
    this.buildingLevels.set(ref, next);
    const totals = this.standing(owner).buildingLevelTotals;
    totals.set(type, (totals.get(type) ?? 0) + 1);
    return next;
  }

  /** The level of the building on `ref` (1 for a fresh structure, 0 for bare ground). */
  buildingLevelOf(ref: TileRef): number {
    if (!this.buildings.has(ref)) return 0;
    return this.buildingLevels.get(ref) ?? 1;
  }

  /**
   * Sum of levels across `player`'s buildings of `type` — the **cost counter**
   * for the ramp (each build or upgrade advances it) and the basis for
   * level-scaled effects. Equals {@link buildingCountOf} while nothing has
   * been upgraded.
   */
  totalLevelsOf(player: PlayerId, type: BuildingType): number {
    return this.standing(player).buildingLevelTotals.get(type) ?? 0;
  }

  /**
   * Sum of levels across `player`'s *finished* buildings of `type` — the count
   * that drives level-scaled effects (a level-2 city lifts the cap twice).
   * Under-construction instances (always level 1 — upgrades apply instantly)
   * are excluded, mirroring {@link activeBuildingCountOf}.
   */
  activeLevelsOf(player: PlayerId, type: BuildingType): number {
    let pending = 0;
    for (const ref of this.construction.keys()) {
      if (this.buildings.get(ref) === type && this.owner[ref] === player) pending += 1;
    }
    return Math.max(0, this.totalLevelsOf(player, type) - pending);
  }

  /**
   * Switch on every building whose construction window has elapsed by `tick`,
   * applying its deferred effects (currently the fort's defense aura). Called once
   * per tick by the engine. Cheap: only buildings still constructing are scanned.
   */
  activateDue(tick: number): void {
    if (this.construction.size === 0) return;
    const ready: TileRef[] = [];
    for (const [ref, window] of this.construction) if (tick >= window.ready) ready.push(ref);
    if (ready.length > 0) this.activeBuildingEntriesCache = null;
    for (const ref of ready) {
      this.construction.delete(ref);
      if (this.buildings.get(ref) === "fort") this.addDefensePost(ref, FORT_DEFENSE_RADIUS, FORT_DEFENSE_STRENGTH);
    }
  }

  /** True while `ref`'s building is still being built (effects not yet active). */
  isUnderConstruction(ref: TileRef): boolean {
    return this.construction.has(ref);
  }

  /** Build progress of `ref` at `tick` in [0,1]; 1 if built (or not constructing). */
  constructionProgress(ref: TileRef, tick: number): number {
    const window = this.construction.get(ref);
    if (!window) return 1;
    const span = window.ready - window.start;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (tick - window.start) / span));
  }

  /**
   * How many *active* (finished) buildings of `type` `player` owns — the count
   * that drives effects (city population cap, stations). Differs from
   * {@link buildingCountOf} (which includes still-constructing ones for the cost
   * ramp) only while something of that type is being built.
   */
  activeBuildingCountOf(player: PlayerId, type: BuildingType): number {
    let pending = 0;
    for (const ref of this.construction.keys()) {
      if (this.buildings.get(ref) === type && this.owner[ref] === player) pending += 1;
    }
    return Math.max(0, this.buildingCountOf(player, type) - pending);
  }

  /**
   * Every *active* (finished) building as `[tile, type]`, ascending — for
   * stations/effects. Cached between mutations — callers must not mutate it.
   */
  activeBuildingEntries(): Array<[TileRef, BuildingType]> {
    return (this.activeBuildingEntriesCache ??=
      this.buildingEntries().filter(([ref]) => !this.construction.has(ref)));
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
    const level = this.buildingLevelOf(ref);
    this.buildings.delete(ref);
    this.buildingLevels.delete(ref);
    this.construction.delete(ref);
    this.buildingEntriesCache = null;
    this.activeBuildingEntriesCache = null;
    if (previousOwner !== NEUTRAL_PLAYER) {
      const standing = this.standing(previousOwner);
      const next = (standing.buildingCounts.get(type) ?? 0) - 1;
      if (next > 0) standing.buildingCounts.set(type, next);
      else standing.buildingCounts.delete(type);
      // A razed structure takes its whole upgrade investment with it.
      const totals = (standing.buildingLevelTotals.get(type) ?? 0) - level;
      if (totals > 0) standing.buildingLevelTotals.set(type, totals);
      else standing.buildingLevelTotals.delete(type);
    }
    if (type === "fort") this.removeDefensePost(ref);
    this.buildingDestroyedListener?.(ref, type);
    return true;
  }

  /**
   * Publicly tear down the building on `ref`, if any — for a structure lost to
   * something other than the tile changing hands (e.g. a mobile Warship unit
   * sunk in combat loses its home port structure too). Delegates to
   * {@link destroyBuilding}; the owner charged for the loss is `ref`'s current
   * owner.
   */
  demolishBuilding(ref: TileRef): boolean {
    return this.destroyBuilding(ref, this.owner[ref]);
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
    const scratch = this.scratchNeighbors;
    // Only edge tiles can touch a non-attacker tile — iterate the perimeter,
    // not the whole territory (this runs per active attack per tick).
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        // Fallout ground stays on the frontier — OpenFront keeps it capturable,
        // just at a stiff combat penalty (see falloutCombatModifier).
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
    const scratch = this.scratchNeighbors;
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.owner[n] === target && this.isCapturable(n)) return true;
      }
    }
    return false;
  }

  /**
   * Shortest water route a transport ship would take from `attacker`'s coast to
   * land on `dest`, or `null` if `dest` is not a capturable coastal tile sharing
   * a body of water with one of the attacker's coasts.
   *
   * Reach is by *connectivity, not distance* (OpenFront's model): a ship may sail
   * the full extent of a single connected water body — clear across an ocean, or
   * up a river joined to the sea — so there is no fixed crossing cap. The returned
   * path is land→water…water→land: the attacker's embarkation tile, the water
   * tiles sailed, then `dest`. A single BFS runs *outward from the destination's
   * bordering water*, seeded only on water the attacker can actually launch into,
   * so the first attacker coast it reaches is the nearest one and the search stays
   * within that one water body. Deterministic via the map's fixed neighbour order.
   */
  findSeaPath(attacker: PlayerId, dest: TileRef): TileRef[] | null {
    // Fallout ground stays a valid landing: like a land attack, a boat may
    // storm irradiated shores — the fallout combat penalty is charged by the
    // land assault that follows the beachhead, not by the crossing.
    if (!this.isCapturable(dest) || this.owner[dest] === attacker) return null;
    const launch = this.launchComponentsOf(attacker);
    if (launch.size === 0) return null;

    // Per-water-tile BFS scratch, generation-stamped so we never clear the whole
    // map between calls: `parent` reconstructs the route.
    const size = this.map.size;
    const parent = (this.seaPathParent ??= new Int32Array(size));
    const stamp = (this.seaPathStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.seaPathGeneration = (this.seaPathGeneration ?? 0) + 1);
    const queue: TileRef[] = [];

    // Seed with the water bordering the destination — but only water in a body the
    // attacker can launch from, so we never explore an unreachable ocean and any
    // coast the BFS reaches is guaranteed to be the attacker's.
    for (const n of this.map.neighbors(dest)) {
      if (this.map.isWater(n) && launch.has(this.waterComponent[n]) && stamp[n] !== generation) {
        stamp[n] = generation;
        parent[n] = dest;
        queue.push(n);
      }
    }
    if (queue.length === 0) return null;

    const scratch = this.scratchNeighbors;
    for (let head = 0; head < queue.length; head += 1) {
      const water = queue[head];
      const count = this.map.neighborsInto(water, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.owner[n] === attacker && this.isCapturable(n)) {
          // Reached the near coast. Parent pointers run water→dest, so walking
          // from `water` already yields embarkation→…→dest order: [coast, water,
          // …, seed-water, dest]. No reversal needed.
          const path: TileRef[] = [n];
          for (let t = water; t !== dest; t = parent[t]) path.push(t);
          path.push(dest);
          return path;
        }
        if (this.map.isWater(n) && stamp[n] !== generation) {
          stamp[n] = generation;
          parent[n] = water;
          queue.push(n);
        }
      }
    }
    return null;
  }

  /**
   * Shortest contiguous water route between two coastal tiles `from` and `to`
   * (e.g. two trade ports), or `null` when no body of water joins them. The
   * returned path is `[from, water…water, to]`: the source coast, every water
   * tile sailed, then the destination coast — so a ship hugs the real shoreline
   * instead of cutting straight across land, exactly like OpenFront's water
   * pathfinder routes trade and transport ships shore-to-shore.
   *
   * A single BFS runs *outward from `to`'s bordering water*; the first water tile
   * it reaches that also borders `from` gives the nearest route, and parent
   * pointers (water→`to`) already spell the path in `from`→`to` order, so no
   * reversal is needed. Deterministic via the map's fixed neighbour order. The
   * search is confined to a single connected water body, so it never explores an
   * ocean the two coasts don't share.
   */
  findWaterRoute(from: TileRef, to: TileRef): TileRef[] | null {
    if (from === to) return null;
    // Water routes depend only on the (immutable) terrain, so a pair's route —
    // or its absence — never changes for the life of the grid. Trade dispatch
    // asks for the same port-pair routes over and over (profiled at ~20% of
    // late-game tick time unmemoized, a whole-ocean BFS per dispatch). Shared
    // arrays: callers must not mutate the result.
    const key = `${from}-${to}`;
    const cached = this.waterRouteCache.get(key);
    if (cached !== undefined) return cached;
    const route = this.computeWaterRoute(from, to);
    this.waterRouteCache.set(key, route);
    return route;
  }

  private computeWaterRoute(from: TileRef, to: TileRef): TileRef[] | null {
    const size = this.map.size;
    const parent = (this.waterRouteParent ??= new Int32Array(size));
    const stamp = (this.waterRouteStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.waterRouteGeneration = (this.waterRouteGeneration ?? 0) + 1);
    const queue: TileRef[] = [];

    // Seed with the water bordering the destination coast.
    for (const n of this.map.neighbors(to)) {
      if (this.map.isWater(n) && stamp[n] !== generation) {
        stamp[n] = generation;
        parent[n] = to;
        queue.push(n);
      }
    }
    if (queue.length === 0) return null;

    const scratch = this.scratchNeighbors;
    for (let head = 0; head < queue.length; head += 1) {
      const water = queue[head];
      const count = this.map.neighborsInto(water, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (n === from) {
          // Reached the source coast. Walk parents water→`to`, yielding
          // [from, water, …, seed-water, to] with no reversal.
          const path: TileRef[] = [from];
          for (let t = water; t !== to; t = parent[t]) path.push(t);
          path.push(to);
          return path;
        }
        if (this.map.isWater(n) && stamp[n] !== generation) {
          stamp[n] = generation;
          parent[n] = water;
          queue.push(n);
        }
      }
    }
    return null;
  }

  /**
   * Pick the best amphibious landing for a click that fell anywhere on a
   * landmass the attacker can't march to: the capturable shore tile nearest the
   * click that a transport could actually reach — i.e. whose bordering water
   * shares a body with one of the attacker's coasts.
   *
   * The player should be able to click a target area — even its interior, or open
   * water off it — and have a boat sail to the area's nearest reachable shore,
   * rather than pixel-hunting for a tile that is both coastal and in range. A BFS
   * fans out over the grid from the click and returns the first qualifying shore,
   * so "nearest" means nearest by tile distance (ties broken by `TileRef`). Reach
   * is unbounded within a connected body of water, so a far coast across a wide
   * sea — or up a river — still qualifies.
   *
   * Returns the landing tile (a valid {@link findSeaPath} destination), or `null`
   * if no shore is reachable by water.
   */
  resolveSeaLanding(attacker: PlayerId, clickRef: TileRef): TileRef | null {
    const launch = this.launchComponentsOf(attacker);
    if (launch.size === 0) return null;

    // A tile is a valid landing if it is capturable land the attacker doesn't
    // own, on the shore of a body of water the attacker can launch into.
    const scratch = this.scratchNeighbors;
    const reachableLanding = (ref: TileRef): boolean => {
      if (this.owner[ref] === attacker || !this.isCapturable(ref)) return false;
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.map.isWater(n) && launch.has(this.waterComponent[n])) return true;
      }
      return false;
    };

    const size = this.map.size;
    const depth = (this.landingDepth ??= new Int32Array(size));
    const stamp = (this.landingStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.landingGeneration = (this.landingGeneration ?? 0) + 1);
    const queue: TileRef[] = [clickRef];
    stamp[clickRef] = generation;
    depth[clickRef] = 0;

    let best: TileRef | null = null;
    let bestDepth = Infinity;
    // A click in a region with no reachable landing at all would otherwise
    // flood the whole map (O(2.5M) with matching queue growth on the huge
    // Earth) before giving up — and clicks are user-triggerable at will. Any
    // genuine landing lies within a coastal band near the click; a generous
    // budget can't change a reachable result, only bound the hopeless flood.
    const SEA_LANDING_SCAN_BUDGET = 150_000;
    for (let head = 0; head < queue.length && head < SEA_LANDING_SCAN_BUDGET; head += 1) {
      const tile = queue[head];
      // BFS visits in non-decreasing depth; once we are past the depth of a found
      // landing, no closer one remains, so stop.
      if (depth[tile] > bestDepth) break;
      if (reachableLanding(tile)) {
        if (best === null || tile < best) best = tile;
        bestDepth = depth[tile];
        continue; // its neighbours are no nearer to the click than it is
      }
      const count = this.map.neighborsInto(tile, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (stamp[n] !== generation) {
          stamp[n] = generation;
          depth[n] = depth[tile] + 1;
          queue.push(n);
        }
      }
    }
    return best;
  }

  /**
   * Capturable, non-attacker shore tiles `attacker` could land a transport on —
   * the opposite banks of every body of water it can launch into — found by a
   * multi-source BFS over water from its coasts, sorted ascending for
   * determinism. Reach is by connectivity (no distance cap on an ordered boat),
   * but a bot's autonomous scan is bounded to {@link SEA_TARGET_SCAN_BUDGET}
   * tiles of explored water so target discovery stays cheap; a chosen target is
   * still sailed to with the unbounded {@link findSeaPath}. Used by the bot AI to
   * notice amphibious targets — every water crossing is an explicit boat.
   */
  private seaTargetTiles(attacker: PlayerId): TileRef[] {
    const launch = this.launchComponentsOf(attacker);
    if (launch.size === 0) return [];
    const size = this.map.size;
    const stamp = (this.seaScanStamp ??= new Int32Array(size).fill(-1));
    const generation = (this.seaScanGeneration = (this.seaScanGeneration ?? 0) + 1);
    const queue: TileRef[] = [];
    const scratch = this.scratchNeighbors;
    // Coasts are border tiles by definition — seed from the perimeter only.
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.map.isWater(n) && launch.has(this.waterComponent[n]) && stamp[n] !== generation) {
          stamp[n] = generation;
          queue.push(n);
        }
      }
    }
    // The seed order feeds a budgeted BFS, so make it deterministic regardless
    // of border-set insertion history (replicas replay claims in order, but a
    // sorted seed keeps the scan robust to any future bookkeeping change).
    queue.sort((a, b) => a - b);
    const targets = new Set<TileRef>();
    let explored = 0;
    for (let head = 0; head < queue.length && explored < SEA_TARGET_SCAN_BUDGET; head += 1) {
      const water = queue[head];
      explored += 1;
      const count = this.map.neighborsInto(water, scratch);
      for (let i = 0; i < count; i += 1) {
        const n = scratch[i];
        if (this.map.isWater(n)) {
          if (stamp[n] !== generation) {
            stamp[n] = generation;
            queue.push(n);
          }
        } else if (this.owner[n] !== attacker && this.isCapturable(n)) {
          targets.add(n);
        }
      }
    }
    return [...targets].sort((a, b) => a - b);
  }

  /**
   * Capturable tiles owned by `target` that `attacker` could expand into this
   * tick — adjacent across a land border, or reachable by an amphibious boat
   * landing. Returned in ascending `TileRef` order for determinism.
   *
   * `target` may be {@link NEUTRAL_PLAYER} to expand into unclaimed land. Land
   * expansion never crosses water; the sea tiles here are boat targets the AI
   * may choose to launch a transport at.
   */
  frontierOf(attacker: PlayerId, target: PlayerId): TileRef[] {
    const found = new Set<TileRef>();
    const consider = (ref: TileRef): void => {
      if (this.owner[ref] === target && this.isCapturable(ref)) found.add(ref);
    };
    const scratch = this.scratchNeighbors;
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) consider(scratch[i]);
    }
    for (const ref of this.seaTargetTiles(attacker)) consider(ref);
    return [...found].sort((a, b) => a - b);
  }

  /**
   * Every owner whose tiles `attacker` could expand into this tick — neutral
   * land and bordering opponents alike — with the number of distinct frontier
   * tiles touching each and a deterministic sample tile (lowest `TileRef`) to
   * aim an intent at.
   *
   * Counts both land borders and amphibious boat targets, so it naturally
   * surfaces enemies reachable only by sea. Returned in ascending target-id
   * order ({@link NEUTRAL_PLAYER} first when present). The shape a bot needs to
   * weigh "grab neutral land vs. attack which neighbour vs. boat where" each turn.
   */
  frontierTargets(attacker: PlayerId): Array<{ target: PlayerId; tiles: number; sample: TileRef }> {
    const acc = new Map<PlayerId, { tiles: number; sample: TileRef }>();
    const seen = new Set<TileRef>();
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
    const scratch = this.scratchNeighbors;
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) consider(scratch[i]);
    }
    for (const ref of this.seaTargetTiles(attacker)) consider(ref);
    return [...acc.entries()]
      .map(([target, value]) => ({ target, tiles: value.tiles, sample: value.sample }))
      .sort((a, b) => a.target - b.target);
  }

  /**
   * True if `attacker` owns at least one tile bordering a tile of `target` by
   * land, or could reach one of `target`'s shores by boat.
   */
  hasFrontier(attacker: PlayerId, target: PlayerId): boolean {
    const reaches = (ref: TileRef): boolean =>
      this.owner[ref] === target && this.isCapturable(ref);
    const scratch = this.scratchNeighbors;
    for (const ref of this.standing(attacker).border) {
      const count = this.map.neighborsInto(ref, scratch);
      for (let i = 0; i < count; i += 1) if (reaches(scratch[i])) return true;
    }
    for (const ref of this.seaTargetTiles(attacker)) if (reaches(ref)) return true;
    return false;
  }
}
