import { GameMap } from "./GameMap.js";
import { buildTerrainFromMask } from "./terrainBuilder.js";
import { MAX_LAND_ELEVATION } from "./terrainCodec.js";

/**
 * Procedural pixel-raster terrain generator.
 *
 * Given a seed and dimensions it produces a fully-populated {@link GameMap}:
 * continents and islands shaped by fractal value noise, land elevations, marked
 * coastlines, ocean-vs-lake classification and per-water shoreline distance.
 *
 * The whole pipeline is deterministic — the same options always yield byte-for-
 * byte identical terrain. That property is what lets the server stay
 * deterministic later and lets tests pin exact output. We use our own tiny
 * seeded noise rather than a library so there are no external dependencies and
 * no reliance on `Math.random`.
 */

export interface TerrainGeneratorOptions {
  /** Tiles per row. */
  width: number;
  /** Number of rows. */
  height: number;
  /** Integer seed; identical seeds (and options) produce identical terrain. */
  seed: number;
  /**
   * Fraction of the height field that becomes water (0-1). Higher = more sea.
   * @default 0.5
   */
  seaLevel?: number;
  /** Number of fractal noise octaves summed together. @default 5 */
  octaves?: number;
  /** Base noise frequency in lattice-cells per tile. @default 0.045 */
  frequency?: number;
  /** Frequency multiplier between octaves. @default 2 */
  lacunarity?: number;
  /** Amplitude multiplier between octaves. @default 0.5 */
  gain?: number;
  /**
   * When true, the height field is pulled down toward water near the map edges
   * so land forms islands/continents rather than running off the border.
   * @default true
   */
  edgeFalloff?: boolean;
  /** Strength of the edge falloff (0 = none). @default 0.45 */
  edgeFalloffStrength?: number;
  /**
   * Land connected-components with fewer tiles than this are sunk to water,
   * removing speckle islands.
   * @default 12
   */
  minIslandTiles?: number;
  /**
   * Enclosed water bodies (lakes) with fewer tiles than this are filled to
   * land, removing pinprick lakes.
   * @default 6
   */
  minLakeTiles?: number;
}

const DEFAULTS = {
  seaLevel: 0.5,
  octaves: 5,
  frequency: 0.045,
  lacunarity: 2,
  gain: 0.5,
  edgeFalloff: true,
  edgeFalloffStrength: 0.45,
  minIslandTiles: 12,
  minLakeTiles: 6,
} as const;

/**
 * Hash two integer lattice coordinates plus a seed into a value in [0, 1).
 * A cheap integer avalanche (`Math.imul`-based) is enough for terrain noise and
 * is fully deterministic across platforms.
 */
const hash2 = (x: number, y: number, seed: number): number => {
  let h = (seed ^ Math.imul(x, 0x1f1f1f1f) ^ Math.imul(y, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0x100000000;
};

const smoothstep = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smoothly-interpolated 2-D value noise sampled at `(x, y)` in lattice space. */
const valueNoise = (x: number, y: number, seed: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const sx = smoothstep(x - x0);
  const sy = smoothstep(y - y0);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
};

/** Fractal (summed-octave) value noise normalised to [0, 1]. */
const fractalNoise = (
  x: number,
  y: number,
  seed: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  gain: number,
): number => {
  let amplitude = 1;
  let freq = frequency;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    // Offset the seed per octave so the layers are decorrelated.
    sum += amplitude * valueNoise(x * freq, y * freq, seed + octave * 1013);
    norm += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
};

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
 */
const cleanupMask = (
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

/** Generate fully-populated raster terrain from a seed. */
export const generateTerrain = (options: TerrainGeneratorOptions): GameMap => {
  const { width, height, seed } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Terrain dimensions must be positive integers, got ${width}x${height}.`);
  }
  const seaLevel = options.seaLevel ?? DEFAULTS.seaLevel;
  const octaves = options.octaves ?? DEFAULTS.octaves;
  const frequency = options.frequency ?? DEFAULTS.frequency;
  const lacunarity = options.lacunarity ?? DEFAULTS.lacunarity;
  const gain = options.gain ?? DEFAULTS.gain;
  const edgeFalloff = options.edgeFalloff ?? DEFAULTS.edgeFalloff;
  const edgeStrength = options.edgeFalloffStrength ?? DEFAULTS.edgeFalloffStrength;
  const minIslandTiles = options.minIslandTiles ?? DEFAULTS.minIslandTiles;
  const minLakeTiles = options.minLakeTiles ?? DEFAULTS.minLakeTiles;

  const size = width * height;

  // 1. Height field via fractal noise, optionally pulled down at the edges.
  const heightField = new Float64Array(size);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let h = fractalNoise(x, y, seed, octaves, frequency, lacunarity, gain);
      if (edgeFalloff) {
        // Normalised distance from centre, 0 at the middle and 1 at a corner.
        const nx = width > 1 ? (x / (width - 1)) * 2 - 1 : 0;
        const ny = height > 1 ? (y / (height - 1)) * 2 - 1 : 0;
        const d = Math.min(1, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2);
        h -= edgeStrength * (d * d);
      }
      heightField[y * width + x] = h;
    }
  }

  // 2. Threshold into a land/water mask, then 3. clean speckle so every
  // downstream pass (coast/ocean/depth) sees a consistent shape.
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    mask[i] = heightField[i] >= seaLevel ? 1 : 0;
  }
  cleanupMask(width, height, mask, minIslandTiles, minLakeTiles);

  // 4. Elevation 0-30 for land tiles (water magnitude is filled in step 7).
  const land = mask;
  const isLandTile = (i: number): boolean => land[i] === 1;
  const elevation = new Uint8Array(size);
  const span = 1 - seaLevel || 1;
  for (let i = 0; i < size; i += 1) {
    if (isLandTile(i)) {
      const t = Math.min(1, Math.max(0, (heightField[i] - seaLevel) / span));
      elevation[i] = Math.round(t * MAX_LAND_ELEVATION);
    }
  }

  // 5. Hand the land mask + elevations to the shared finishing pipeline, which
  //    marks coastlines, separates ocean from lakes, computes water depth and
  //    packs the result into the 1-byte tile codec.
  return buildTerrainFromMask({ width, height, land, elevation });
};
