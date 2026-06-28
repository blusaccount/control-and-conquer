import type { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import { DEFAULT_PLAYER_PALETTE, tileColor, type Rgba } from "./rasterPalette.js";

/** Allocate an RGBA pixel buffer (one pixel per tile) for a map. */
export const createPixelBuffer = (map: GameMap): Uint8ClampedArray =>
  new Uint8ClampedArray(map.size * 4);

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
    const color = tileColor(map.tile(ref), owner[ref], palette);
    const offset = ref * 4;
    pixels[offset] = color.r;
    pixels[offset + 1] = color.g;
    pixels[offset + 2] = color.b;
    pixels[offset + 3] = color.a;
  }
};
