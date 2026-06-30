import { GameMap } from "./GameMap.js";
import { encodeTile, MAX_MAGNITUDE } from "./terrainCodec.js";

/**
 * Shared terrain-finishing pipeline.
 *
 * Both the procedural noise generator (`terrainGenerator`) and the real-world
 * map loader (`realMaps`) decide *where* the land is and *how high* it is, but
 * the downstream work — marking coastlines, separating open ocean from inland
 * lakes, computing per-water shoreline distance and packing everything into the
 * 1-byte tile codec — is identical for both. That logic lives here so the two
 * front-ends stay in sync and produce byte-compatible `GameMap`s.
 *
 * The whole pass is deterministic: same inputs → byte-for-byte identical
 * terrain, which is what keeps the server simulation reproducible.
 */
export interface TerrainMask {
  width: number;
  height: number;
  /** Length `width*height`; 1 = land, 0 = water. */
  land: Uint8Array;
  /**
   * Length `width*height`; land magnitude (elevation `0..30`, or `31` for an
   * impassable rock tile). Ignored for water tiles, whose magnitude is the
   * generated shoreline distance.
   */
  elevation: Uint8Array;
}

/**
 * Flood-fill the connected component containing `start` over `mask` (matching
 * tiles share `mask[i] === target`), writing `componentId` into `labels` for
 * every visited tile. Returns the component's tile count. 4-connected.
 */
const fillComponent = (
  width: number,
  height: number,
  mask: Uint8Array,
  labels: Int32Array,
  start: number,
  target: number,
  componentId: number,
): number => {
  const stack = [start];
  labels[start] = componentId;
  let count = 0;
  while (stack.length > 0) {
    const ref = stack.pop() as number;
    count += 1;
    const x = ref % width;
    const y = (ref - x) / width;
    if (x > 0 && mask[ref - 1] === target && labels[ref - 1] < 0) {
      labels[ref - 1] = componentId;
      stack.push(ref - 1);
    }
    if (x < width - 1 && mask[ref + 1] === target && labels[ref + 1] < 0) {
      labels[ref + 1] = componentId;
      stack.push(ref + 1);
    }
    if (y > 0 && mask[ref - width] === target && labels[ref - width] < 0) {
      labels[ref - width] = componentId;
      stack.push(ref - width);
    }
    if (y < height - 1 && mask[ref + width] === target && labels[ref + width] < 0) {
      labels[ref + width] = componentId;
      stack.push(ref + width);
    }
  }
  return count;
};

/**
 * Remove speckle from a land/water mask: land islands smaller than
 * `minIslandTiles` become water and fully-enclosed lakes smaller than
 * `minLakeTiles` become land. Border-touching water is treated as ocean and
 * never filled. Mutates `mask` in place (1 = land, 0 = water).
 *
 * Shared by the procedural generator and the real-world heightmap loader: a raw
 * topography source is full of single-pixel islets and pinprick lakes that, left
 * in, render as bright sandy specks ringed by shallow-water glow scattered over
 * the ocean (OpenFront's map generator strips the same noise before shipping a
 * map). Run this on the mask *before* the finishing pass so coast/ocean/depth
 * are classified against the cleaned shapes.
 */
export const cleanupMask = (
  width: number,
  height: number,
  mask: Uint8Array,
  minIslandTiles: number,
  minLakeTiles: number,
): void => {
  const size = width * height;
  const labels = new Int32Array(size).fill(-1);
  let nextId = 0;

  // Sink tiny land islands.
  for (let i = 0; i < size; i += 1) {
    if (mask[i] === 1 && labels[i] < 0) {
      const id = nextId;
      nextId += 1;
      const start = i;
      const count = fillComponent(width, height, mask, labels, start, 1, id);
      if (count < minIslandTiles) {
        for (let j = start; j < size; j += 1) {
          if (labels[j] === id) mask[j] = 0;
        }
      }
    }
  }

  // Fill tiny enclosed lakes. A water component is a lake only if it never
  // touches the map border (border water is open ocean).
  labels.fill(-1);
  nextId = 0;
  for (let i = 0; i < size; i += 1) {
    if (mask[i] === 0 && labels[i] < 0) {
      const id = nextId;
      nextId += 1;
      const start = i;
      const count = fillComponent(width, height, mask, labels, start, 0, id);
      let touchesBorder = false;
      for (let j = start; j < size && !touchesBorder; j += 1) {
        if (labels[j] !== id) continue;
        const x = j % width;
        const y = (j - x) / width;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          touchesBorder = true;
        }
      }
      if (!touchesBorder && count < minLakeTiles) {
        for (let j = start; j < size; j += 1) {
          if (labels[j] === id) mask[j] = 1;
        }
      }
    }
  }
};

/**
 * Finish a land/water mask into a fully-classified {@link GameMap}: coastlines,
 * ocean-vs-lake classification and water depth, packed into the tile codec.
 */
export const buildTerrainFromMask = (mask: TerrainMask): GameMap => {
  const { width, height, land, elevation } = mask;
  const size = width * height;
  if (land.length !== size || elevation.length !== size) {
    throw new Error(`Mask arrays must be length ${size} for ${width}x${height}.`);
  }

  // 1. Coastlines: a tile is shoreline when any 4-neighbour is the other
  //    element (land next to water, or water next to land).
  const shore = new Uint8Array(size);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const here = land[i];
      const differs =
        (x > 0 && land[i - 1] !== here) ||
        (x < width - 1 && land[i + 1] !== here) ||
        (y > 0 && land[i - width] !== here) ||
        (y < height - 1 && land[i + width] !== here);
      if (differs) shore[i] = 1;
    }
  }

  // 2. Ocean vs lake: flood-fill water inward from every border water tile.
  //    Reachable water is open ocean; the rest are inland lakes.
  const ocean = new Uint8Array(size);
  const oceanQueue: number[] = [];
  const enqueueOcean = (i: number): void => {
    if (land[i] === 0 && ocean[i] === 0) {
      ocean[i] = 1;
      oceanQueue.push(i);
    }
  };
  for (let x = 0; x < width; x += 1) {
    enqueueOcean(x);
    enqueueOcean((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueueOcean(y * width);
    enqueueOcean(y * width + (width - 1));
  }
  for (let head = 0; head < oceanQueue.length; head += 1) {
    const i = oceanQueue[head];
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) enqueueOcean(i - 1);
    if (x < width - 1) enqueueOcean(i + 1);
    if (y > 0) enqueueOcean(i - width);
    if (y < height - 1) enqueueOcean(i + width);
  }

  // 3. Water depth: multi-source BFS outward from shoreline water tiles.
  //    Shore water is depth 1, each step away adds 1, capped at the field max.
  const depth = new Uint8Array(size);
  const depthQueue: number[] = [];
  for (let i = 0; i < size; i += 1) {
    if (land[i] === 0 && shore[i] === 1) {
      depth[i] = 1;
      depthQueue.push(i);
    }
  }
  for (let head = 0; head < depthQueue.length; head += 1) {
    const i = depthQueue[head];
    const next = Math.min(depth[i] + 1, MAX_MAGNITUDE);
    const x = i % width;
    const y = (i - x) / width;
    const relax = (j: number): void => {
      if (land[j] === 0 && depth[j] === 0) {
        depth[j] = next;
        depthQueue.push(j);
      }
    };
    if (x > 0) relax(i - 1);
    if (x < width - 1) relax(i + 1);
    if (y > 0) relax(i - width);
    if (y < height - 1) relax(i + width);
  }

  // 4. Pack everything into the 1-byte-per-tile terrain array.
  const terrain = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const isLandHere = land[i] === 1;
    terrain[i] = encodeTile({
      land: isLandHere,
      shoreline: shore[i] === 1,
      ocean: !isLandHere && ocean[i] === 1,
      magnitude: isLandHere ? elevation[i] : depth[i],
    });
  }

  return new GameMap(width, height, terrain);
};
