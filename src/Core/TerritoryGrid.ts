import type { GameMap, TileRef } from "./GameMap.js";
import { MAX_SEA_CROSSING_TILES } from "./rasterCombatConfig.js";
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
   * The set of tiles this player currently owns. Single source of truth for both
   * the tile count (`tiles.size`) and the player's frontier: expansion only ever
   * radiates from owned tiles, so iterating this set is far cheaper than scanning
   * the whole ownership raster.
   */
  tiles: Set<TileRef>;
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

  private readonly standings = new Map<PlayerId, PlayerStanding>();

  constructor(map: GameMap) {
    this.map = map;
    this.owner = new Uint16Array(map.size);
    this.seaLinks = SeaLinks.build(map, MAX_SEA_CROSSING_TILES);
    let capturable = 0;
    for (let ref = 0; ref < map.size; ref += 1) {
      if (map.isLand(ref) && !map.isImpassable(ref)) capturable += 1;
    }
    this.capturableCount = capturable;
  }

  /** True when a tile can be owned (passable land). */
  isCapturable(ref: TileRef): boolean {
    return this.map.isLand(ref) && !this.map.isImpassable(ref);
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
    this.standings.set(id, { troops, tiles: new Set() });
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

  /** Number of tiles a player currently owns. */
  tileCountOf(id: PlayerId): number {
    return this.standing(id).tiles.size;
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
    if (previous !== NEUTRAL_PLAYER) {
      this.standing(previous).tiles.delete(ref);
    }
    if (id !== NEUTRAL_PLAYER) {
      this.standing(id).tiles.add(ref);
    }
    this.owner[ref] = id;
  }

  /** True if any 4-connected land neighbour of `ref` is owned by `attacker`. */
  hasLandFrontier(attacker: PlayerId, ref: TileRef): boolean {
    for (const n of this.map.neighbors(ref)) {
      if (this.owner[n] === attacker) return true;
    }
    return false;
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
    const consider = (ref: TileRef): void => {
      if (this.owner[ref] === target && this.isCapturable(ref)) found.add(ref);
    };
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) consider(n);
      for (const n of this.seaLinks.neighborsOf(ref)) consider(n);
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
      for (const n of this.seaLinks.neighborsOf(ref)) consider(n);
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
    const reaches = (ref: TileRef): boolean =>
      this.owner[ref] === target && this.isCapturable(ref);
    for (const ref of this.standing(attacker).tiles) {
      for (const n of this.map.neighbors(ref)) if (reaches(n)) return true;
      for (const n of this.seaLinks.neighborsOf(ref)) if (reaches(n)) return true;
    }
    return false;
  }
}
