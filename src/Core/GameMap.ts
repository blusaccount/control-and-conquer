import {
  isImpassable,
  isLand,
  isOcean,
  isShore,
  isWater,
  magnitude,
} from "./terrainCodec.js";

/**
 * A `TileRef` is the flat index of a tile within a `GameMap`'s terrain array,
 * i.e. `y * width + x`. Using a plain number (instead of an `{x, y}` object)
 * keeps neighbour walks and large-raster algorithms allocation-free, which
 * matters once Phases 2+ run BFS expansion over the whole map every tick.
 */
export type TileRef = number;

/**
 * Static pixel-raster terrain: a `width * height` grid of 1-byte tiles encoded
 * by `terrainCodec`. `GameMap` holds terrain only — ownership and troop pools
 * live in separate parallel arrays added in Phase 2, so the terrain raster can
 * stay immutable and shareable.
 */
export class GameMap {
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;

  /**
   * @param width   Tiles per row (must be a positive integer).
   * @param height  Number of rows (must be a positive integer).
   * @param terrain Optional backing array of length `width * height`. When
   *                omitted a zero-filled array (all water, depth 0) is created.
   */
  constructor(width: number, height: number, terrain?: Uint8Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`GameMap dimensions must be positive integers, got ${width}x${height}.`);
    }
    const size = width * height;
    if (terrain && terrain.length !== size) {
      throw new Error(`Terrain array length ${terrain.length} does not match ${width}x${height}=${size}.`);
    }
    this.width = width;
    this.height = height;
    this.terrain = terrain ?? new Uint8Array(size);
  }

  /** Total number of tiles. */
  get size(): number {
    return this.width * this.height;
  }

  /** True when `(x, y)` lies within the map. */
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Flat tile index for `(x, y)`. Caller is responsible for bounds. */
  ref(x: number, y: number): TileRef {
    return y * this.width + x;
  }

  /** X coordinate (column) of a tile reference. */
  x(ref: TileRef): number {
    return ref % this.width;
  }

  /** Y coordinate (row) of a tile reference. */
  y(ref: TileRef): number {
    return Math.floor(ref / this.width);
  }

  /** Raw terrain byte for a tile reference. */
  tile(ref: TileRef): number {
    return this.terrain[ref];
  }

  /**
   * The 4-connected (von Neumann) neighbours of a tile, clamped to the map
   * edges. Corner tiles yield 2 neighbours, edge tiles 3, interior tiles 4.
   */
  neighbors(ref: TileRef): TileRef[] {
    const x = this.x(ref);
    const y = this.y(ref);
    const result: TileRef[] = [];
    if (x > 0) result.push(ref - 1);
    if (x < this.width - 1) result.push(ref + 1);
    if (y > 0) result.push(ref - this.width);
    if (y < this.height - 1) result.push(ref + this.width);
    return result;
  }

  isLand(ref: TileRef): boolean {
    return isLand(this.terrain[ref]);
  }

  isWater(ref: TileRef): boolean {
    return isWater(this.terrain[ref]);
  }

  isShore(ref: TileRef): boolean {
    return isShore(this.terrain[ref]);
  }

  isOcean(ref: TileRef): boolean {
    return isOcean(this.terrain[ref]);
  }

  isImpassable(ref: TileRef): boolean {
    return isImpassable(this.terrain[ref]);
  }

  /** Magnitude (land elevation / water depth) of a tile. */
  magnitude(ref: TileRef): number {
    return magnitude(this.terrain[ref]);
  }
}
