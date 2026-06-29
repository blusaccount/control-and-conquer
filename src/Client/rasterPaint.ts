import type { GameMap } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId } from "../Core/TerritoryGrid.js";
import { borderColor, DEFAULT_PLAYER_PALETTE, tileColor, type Rgba } from "./rasterPalette.js";

/** Allocate an RGBA pixel buffer (one pixel per tile) for a map. */
export const createPixelBuffer = (map: GameMap): Uint8ClampedArray =>
  new Uint8ClampedArray(map.size * 4);

/**
 * True when `ref` is an owned tile sitting on its owner's territory edge — at
 * least one 4-neighbour belongs to someone else (another player, neutral land,
 * or water). Border tiles are drawn as a bright outline so each nation reads as
 * a clean shape over the terrain. Neutral/water tiles are never borders.
 */
export const isBorderTile = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  ref: number,
): boolean => {
  const id = owner[ref];
  if (id === NEUTRAL_PLAYER) return false;
  for (const n of map.neighbors(ref)) {
    if (owner[n] !== id) return true;
  }
  return false;
};

/** On-screen colour for a tile: a bright border outline on owned edges, else the terrain+ownership blend. */
const colorForTile = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  ref: number,
  palette: readonly Rgba[],
): Rgba =>
  isBorderTile(map, owner, ref)
    ? borderColor(owner[ref], palette)
    : tileColor(map.tile(ref), owner[ref], palette);

/**
 * Paint a single tile's terrain + ownership colour into an RGBA buffer. Used
 * for incremental repaints: when an ownership delta touches only a few thousand
 * of a million tiles, repainting just those tiles is far cheaper than redrawing
 * the whole raster.
 */
export const paintTileInto = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  ref: number,
  pixels: Uint8ClampedArray,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): void => {
  const color = colorForTile(map, owner, ref, palette);
  const offset = ref * 4;
  pixels[offset] = color.r;
  pixels[offset + 1] = color.g;
  pixels[offset + 2] = color.b;
  pixels[offset + 3] = color.a;
};

/**
 * Paint a map's terrain + ownership into an RGBA buffer at one pixel per tile,
 * in row-major order (matching `ImageData` layout). Pure — no DOM — so it can
 * be unit-tested; the browser wrapper just hands the result to a canvas.
 *
 * `owner` is the parallel per-tile owner array (e.g. `TerritoryGrid.owner`);
 * `0` marks neutral tiles. The buffer must be `map.size * 4` bytes long.
 */
export const paintRaster = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  pixels: Uint8ClampedArray,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): void => {
  const expected = map.size * 4;
  if (pixels.length !== expected) {
    throw new Error(`Pixel buffer length ${pixels.length} does not match ${expected} (map.size * 4).`);
  }
  if (owner.length !== map.size) {
    throw new Error(`Owner array length ${owner.length} does not match map.size ${map.size}.`);
  }
  for (let ref = 0; ref < map.size; ref += 1) {
    const color = colorForTile(map, owner, ref, palette);
    const offset = ref * 4;
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
    pixels[offset + 3] = color.a;
  }
};
