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
  /** Number of tiles currently owned by this player. */
  tiles: number;
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
    this.standings.set(id, { troops, tiles: 0 });
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
    if (previous !== NEUTRAL_PLAYER) {
      this.standing(previous).tiles -= 1;
    }
    if (id !== NEUTRAL_PLAYER) {
      this.standing(id).tiles += 1;
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
   * True if `attacker` can reach `ref` either across a shared land border or via
   * an amphibious crossing from one of its coastal tiles.
   */
  private canReach(attacker: PlayerId, ref: TileRef): boolean {
    if (this.hasLandFrontier(attacker, ref)) return true;
    for (const n of this.seaLinks.neighborsOf(ref)) {
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
   */
  frontierOf(attacker: PlayerId, target: PlayerId): TileRef[] {
    const frontier: TileRef[] = [];
    for (let ref = 0; ref < this.owner.length; ref += 1) {
      if (this.owner[ref] !== target || !this.isCapturable(ref)) continue;
      if (this.canReach(attacker, ref)) frontier.push(ref);
    }
    return frontier;
  }

  /**
   * True if `attacker` owns at least one tile bordering a tile of `target`,
   * counting amphibious crossings as borders.
   */
  hasFrontier(attacker: PlayerId, target: PlayerId): boolean {
    for (let ref = 0; ref < this.owner.length; ref += 1) {
      if (this.owner[ref] !== target || !this.isCapturable(ref)) continue;
      if (this.canReach(attacker, ref)) return true;
    }
    return false;
  }
}
