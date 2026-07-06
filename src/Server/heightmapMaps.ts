import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTerrainFromMask, cleanupMask } from "../Core/terrainBuilder.js";
import { IMPASSABLE_MAGNITUDE } from "../Core/terrainCodec.js";
import type { GameMap } from "../Core/GameMap.js";
import { decodePngToGray, type DecodedGray } from "./pngDecode.js";
import { carveRivers, riverHalfWidthFor } from "./rivers.js";
import { loadEarthRivers } from "./riverData.js";
import { EARTH_STRAITS } from "./straits.js";

/**
 * Large, real-world maps derived from a grayscale heightmap.
 *
 * Hand-authored ASCII (`realMaps.ts`) does not scale past a few thousand tiles —
 * an OpenFront-scale world (1-2 million tiles) is impossible to draw by hand.
 * Instead we ship a committed equirectangular topology PNG (ocean = 0, land =
 * elevation) and downsample it, at server start, to whatever grid size is
 * configured. The same `buildTerrainFromMask` finishing pass the ASCII and
 * procedural front-ends use then classifies coast / ocean / lake / depth, so a
 * heightmap map is byte-compatible with every other map and stays deterministic
 * (pure integer resampling — no platform image library, no RNG).
 *
 * Regenerate or swap the source PNG with `scripts/buildMap.ts`.
 */
export interface HeightmapMapDef {
  /** Stable id used to select the map (e.g. via `RASTER_MAP`). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Source PNG filename under `assets/maps/`. */
  source: string;
  /** Default target width in tiles (overridable via `RASTER_MAP_SIZE`). */
  defaultWidth: number;
  /**
   * Latitude band of the equirectangular source to keep, in degrees. Cropping
   * out the poles removes the worst projection stretch (and most of the empty
   * Antarctic/Arctic ice) so the playable area reads like a real map.
   */
  latMax: number;
  latMin: number;
  /** Average land elevation (0..255) at/above which a tile is impassable rock. */
  mountainGray: number;
  /**
   * Carve real-world rivers (Natural Earth centerlines) into this map as water.
   * The source topography PNG has no hydrography, so rivers are overlaid as their
   * own committed data layer (see `riverData.ts` / `rivers.ts`). @default false
   */
  rivers?: boolean;
  /**
   * Carve the strategic straits and canals (`straits.ts`) into this map as
   * water. Narrow real-world chokepoints (Gibraltar, Bosporus, Suez, …) are
   * squeezed shut by downsampling, which would turn the Mediterranean, Black
   * Sea, Baltic and Persian Gulf into landlocked lakes. @default false
   */
  straits?: boolean;
}

/** Catalogue of available heightmap maps, keyed by id. */
const EARTH: HeightmapMapDef = {
  id: "earth",
  name: "Earth",
  source: "earth-topo.png",
  defaultWidth: 1024,
  latMax: 78,
  latMin: -58,
  mountainGray: 200,
  rivers: true,
  straits: true,
};

const HEIGHTMAP_MAPS: ReadonlyMap<string, HeightmapMapDef> = new Map([[EARTH.id, EARTH]]);

/** Look up a heightmap map definition by id, or `undefined` if unknown. */
export const getHeightmapMap = (id: string): HeightmapMapDef | undefined => HEIGHTMAP_MAPS.get(id);

/** All registered heightmap map ids (for help text / validation). */
export const HEIGHTMAP_MAP_IDS: readonly string[] = [...HEIGHTMAP_MAPS.keys()];

// Decoded source planes and finished maps are cached: the source never changes
// mid-process and a finished `GameMap` is immutable, so every session on the
// same (map, size) shares one build instead of decoding the PNG per connection.
const sourceCache = new Map<string, DecodedGray>();
const mapCache = new Map<string, GameMap>();

const loadSource = (file: string): DecodedGray => {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const path = fileURLToPath(new URL(`../../assets/maps/${file}`, import.meta.url));
  const decoded = decodePngToGray(new Uint8Array(readFileSync(path)));
  sourceCache.set(file, decoded);
  return decoded;
};

/**
 * Resolve the target grid size for a heightmap map. Height is derived from the
 * cropped latitude span so tiles keep a roughly geographic aspect ratio. Width
 * is taken from `RASTER_MAP_SIZE` when valid, else the map's default, and both
 * are clamped to a sane range and rounded to even numbers.
 */
export const resolveHeightmapSize = (
  def: HeightmapMapDef,
  requestedWidth?: number,
): { width: number; height: number } => {
  const raw = requestedWidth && Number.isFinite(requestedWidth) ? requestedWidth : def.defaultWidth;
  const width = Math.max(64, Math.min(4096, Math.round(raw / 2) * 2));
  const latSpan = def.latMax - def.latMin;
  const height = Math.max(32, Math.round((width * (latSpan / 360)) / 2) * 2);
  return { width, height };
};

/**
 * Minimum island / lake sizes (in tiles) for the speckle cleanup, scaled to the
 * grid so the result reads the same whatever `RASTER_MAP_SIZE` resolves to. A
 * landmass below `minIslandTiles` is sunk to ocean (so a lone topography pixel
 * does not become a glowing dot); an enclosed water body below `minLakeTiles` is
 * filled to land. Thresholds are a fixed fraction of the grid area with small
 * floors, so the default 1024-wide Earth (~0.4 M tiles) clears 1–10-tile noise
 * while real islands (Iceland, Cuba, …) and named lakes stay put.
 */
const speckleThresholds = (
  width: number,
  height: number,
): { minIslandTiles: number; minLakeTiles: number } => {
  const size = width * height;
  return {
    minIslandTiles: Math.max(6, Math.round(size / 40000)),
    minLakeTiles: Math.max(6, Math.round(size / 40000)),
  };
};

/**
 * Build (or fetch from cache) a fully-classified {@link GameMap} for a heightmap
 * map at the given target size.
 */
export const buildHeightmapGameMap = (def: HeightmapMapDef, requestedWidth?: number): GameMap => {
  const { width, height } = resolveHeightmapSize(def, requestedWidth);
  const cacheKey = `${def.id}@${width}x${height}`;
  const cached = mapCache.get(cacheKey);
  if (cached) return cached;

  const src = loadSource(def.source);
  const size = width * height;
  const land = new Uint8Array(size);
  const elevation = new Uint8Array(size);

  // Source rows spanning the cropped latitude band (full longitude span).
  const srcTop = ((90 - def.latMax) / 180) * src.height;
  const srcBottom = ((90 - def.latMin) / 180) * src.height;

  for (let ty = 0; ty < height; ty += 1) {
    // Source-pixel box for this target row.
    const sy0 = Math.floor(srcTop + (ty / height) * (srcBottom - srcTop));
    const sy1 = Math.max(sy0 + 1, Math.floor(srcTop + ((ty + 1) / height) * (srcBottom - srcTop)));
    for (let tx = 0; tx < width; tx += 1) {
      const sx0 = Math.floor((tx / width) * src.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) / width) * src.width));

      // Classify the cell by the *fraction* of land pixels (robust to the wide
      // elevation range), and take elevation as the mean over land pixels only
      // so low-lying coasts are not washed out by neighbouring ocean.
      let total = 0;
      let landPixels = 0;
      let graySum = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const rowBase = Math.min(sy, src.height - 1) * src.width;
        for (let sx = sx0; sx < sx1; sx += 1) {
          const g = src.gray[rowBase + Math.min(sx, src.width - 1)];
          total += 1;
          if (g > 0) {
            landPixels += 1;
            graySum += g;
          }
        }
      }

      const i = ty * width + tx;
      if (landPixels * 2 >= total) {
        land[i] = 1;
        const avg = graySum / landPixels;
        elevation[i] =
          avg >= def.mountainGray
            ? IMPASSABLE_MAGNITUDE
            : Math.max(1, Math.min(30, 1 + Math.round((avg / def.mountainGray) * 24)));
      }
    }
  }

  // Strip speckle the raw topography is full of: single-pixel islets and
  // pinprick lakes that survive the land-fraction vote and would otherwise
  // render as bright sandy dots ringed by shallow-water glow scattered across
  // the ocean. OpenFront's map generator removes the same noise (islands < 30
  // tiles, lakes < 200) before shipping a map; we scale the thresholds with the
  // grid so the cleanup is consistent at every `RASTER_MAP_SIZE`. Done *before*
  // carving rivers so the thin river channels are never mistaken for a lake and
  // filled back in.
  const { minIslandTiles, minLakeTiles } = speckleThresholds(width, height);
  cleanupMask(width, height, land, minIslandTiles, minLakeTiles);

  // Overlay rivers and strait/canal channels as water before the finishing
  // pass. The topography source carries no hydrography (and downsampling
  // squeezes narrow real straits shut), so this is the only step that puts
  // them on the map; it is a hard override of the land/water classification
  // above. Both layers share one carve pass — they are the same operation on
  // different curated data.
  if (def.rivers || def.straits) {
    carveRivers({
      width,
      height,
      land,
      elevation,
      latMax: def.latMax,
      latMin: def.latMin,
      rivers: [...(def.rivers ? loadEarthRivers() : []), ...(def.straits ? EARTH_STRAITS : [])],
      halfWidth: riverHalfWidthFor(width),
    });

    // Carving a channel can slice a thin cape off the mainland, leaving a fresh
    // one- or two-tile islet the first pass never saw. Re-sink those — islands
    // only (minLakeTiles 0 disables lake filling) so the rivers we just carved
    // are never refilled.
    cleanupMask(width, height, land, minIslandTiles, 0);
  }

  const map = buildTerrainFromMask({ width, height, land, elevation });
  mapCache.set(cacheKey, map);
  return map;
};
