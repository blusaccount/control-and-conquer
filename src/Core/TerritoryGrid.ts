import type { GameMap, TileRef } from "./GameMap.js";
import {
  CLICK_SNAP_RADIUS,
  DEFENSE_POST_RADIUS,
  DEFENSE_POST_STRENGTH,
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
   * Buildings still under construction: tile → its build window `{start, ready}`
   * in engine ticks. A building counts toward its owner's cost ramp the moment it
   * is placed, but its *effects* (city population cap, rail/trade station, fort
   * aura, warship interception) only switch on once it leaves this map at
   * {@link activateDue}. Empty = nothing building.
   */
  private readonly construction = new Map<TileRef, { start: number; ready: number }>();

  // Lazily-allocated, generation-stamped scratch buffers reused by every
  // {@link findSeaPath} call so per-launch pathfinding stays allocation-free.
  private seaPathParent?: Int32Array;
  private seaPathStamp?: Int32Array;
  private seaPathGeneration?: number;
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
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) {
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

    for (let head = 0; head < queue.length; head += 1) {
      const tile = queue[head];
      const d = depth[head];
      for (const n of this.map.neighbors(tile)) {
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
  placeBuilding(ref: TileRef, type: BuildingType, startTick = 0, readyTick = 0): void {
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
    if (readyTick > startTick) {
      // Under construction: effects switch on later, at activateDue.
      this.construction.set(ref, { start: startTick, ready: readyTick });
    } else if (type === "fort") {
      // Instantly active (the default, used by tests/direct placement).
      this.addDefensePost(ref, FORT_DEFENSE_RADIUS, FORT_DEFENSE_STRENGTH);
    }
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

  /** Every *active* (finished) building as `[tile, type]`, ascending — for stations/effects. */
  activeBuildingEntries(): Array<[TileRef, BuildingType]> {
    return this.buildingEntries().filter(([ref]) => !this.construction.has(ref));
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
    this.construction.delete(ref);
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
    const reachableLanding = (ref: TileRef): boolean => {
      if (this.owner[ref] === attacker || !this.isCapturable(ref)) return false;
      for (const n of this.map.neighbors(ref)) {
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
    for (let head = 0; head < queue.length; head += 1) {
      const tile = queue[head];
      // BFS visits in non-decreasing depth; once we are past the depth of a found
      // landing, no closer one remains, so stop.
      if (depth[tile] > bestDepth) break;
      if (reachableLanding(tile)) {
        if (best === null || tile < best) best = tile;
        bestDepth = depth[tile];
        continue; // its neighbours are no nearer to the click than it is
      }
      for (const n of this.map.neighbors(tile)) {
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
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) {
        if (this.map.isWater(n) && launch.has(this.waterComponent[n]) && stamp[n] !== generation) {
          stamp[n] = generation;
          queue.push(n);
        }
      }
    }
    const targets = new Set<TileRef>();
    let explored = 0;
    for (let head = 0; head < queue.length && explored < SEA_TARGET_SCAN_BUDGET; head += 1) {
      const water = queue[head];
      explored += 1;
      for (const n of this.map.neighbors(water)) {
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
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) consider(n);
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
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) consider(n);
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
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) if (reaches(n)) return true;
    }
    for (const ref of this.seaTargetTiles(attacker)) if (reaches(ref)) return true;
    return false;
  }
}
