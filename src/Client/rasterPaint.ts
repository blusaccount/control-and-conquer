import type { GameMap } from "../Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId } from "../Core/TerritoryGrid.js";
import {
  borderColor,
  DEFAULT_PLAYER_PALETTE,
  ownBorderColor,
  terrainColor,
  tileColor,
  type Rgba,
} from "./rasterPalette.js";

/** Sentinel meaning "no own-nation highlight" for the paint functions. */
const NO_HIGHLIGHT = -1;

/** Allocate an RGBA pixel buffer (one pixel per tile) for a map. */
export const createPixelBuffer = (map: GameMap): Uint8ClampedArray =>
  new Uint8ClampedArray(map.size * 4);

/**
 * True when `ref` is an owned tile sitting on its owner's territory edge — at
 * least one 4-neighbour belongs to someone else (another player, neutral land,
 * or water). Border tiles are drawn as a bright outline so each nation reads as
 * a clean shape over the terrain. Neutral/water tiles are never borders.
 *
 * The neighbour probes are inlined (no `map.neighbors()` array) because this
 * runs once per tile on a full repaint — millions of calls on the huge Earth.
 */
export const isBorderTile = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  ref: number,
): boolean => {
  const id = owner[ref];
  if (id === NEUTRAL_PLAYER) return false;
  const width = map.width;
  const size = map.size;
  const x = ref % width;
  return (
    (x > 0 && owner[ref - 1] !== id) ||
    (x + 1 < width && owner[ref + 1] !== id) ||
    (ref >= width && owner[ref - width] !== id) ||
    (ref + width < size && owner[ref + width] !== id)
  );
};

// ---------------------------------------------------------------------------
// Packed-colour lookup tables.
//
// The palette functions build a fresh Rgba object per call; fine in isolation,
// ruinous when a full repaint of a 2.5M-tile map calls them once (or more) per
// tile. Every colour the paint path can produce is a pure function of
// (terrain byte, owner id, palette, highlight), so we precompute them into
// flat tables of RGBA pixels packed as one u32 in *platform byte order* and
// blit whole pixels with single writes. Tables are keyed by palette identity —
// the client swaps in a brand-new palette array when nation colours change, so
// identity comparison is exact.
// ---------------------------------------------------------------------------

/** Pack an Rgba into a u32 whose byte layout matches Uint8ClampedArray order. */
const packScratch = new Uint8ClampedArray(4);
const packScratch32 = new Uint32Array(packScratch.buffer);
const packColor = (c: Rgba): number => {
  packScratch[0] = c.r;
  packScratch[1] = c.g;
  packScratch[2] = c.b;
  packScratch[3] = c.a;
  return packScratch32[0];
};

interface PaletteLut {
  /** terrain byte → packed natural (unowned) colour. */
  terrain: Uint32Array;
  /** owner id → (terrain byte → packed owned-tile colour); built lazily. */
  owned: Map<number, Uint32Array>;
  /** owner id → packed rival border colour; built lazily. */
  border: Map<number, number>;
  /** owner id → packed own-nation border colour; built lazily. */
  ownBorder: Map<number, number>;
}

const lutCache = new WeakMap<readonly Rgba[], PaletteLut>();

const lutFor = (palette: readonly Rgba[]): PaletteLut => {
  let lut = lutCache.get(palette);
  if (!lut) {
    const terrain = new Uint32Array(256);
    for (let byte = 0; byte < 256; byte += 1) terrain[byte] = packColor(terrainColor(byte));
    lut = { terrain, owned: new Map(), border: new Map(), ownBorder: new Map() };
    lutCache.set(palette, lut);
  }
  return lut;
};

const ownedLut = (lut: PaletteLut, palette: readonly Rgba[], id: number): Uint32Array => {
  let table = lut.owned.get(id);
  if (!table) {
    table = new Uint32Array(256);
    for (let byte = 0; byte < 256; byte += 1) table[byte] = packColor(tileColor(byte, id, palette));
    lut.owned.set(id, table);
  }
  return table;
};

const borderPacked = (lut: PaletteLut, palette: readonly Rgba[], id: number): number => {
  let packed = lut.border.get(id);
  if (packed === undefined) {
    packed = packColor(borderColor(id, palette));
    lut.border.set(id, packed);
  }
  return packed;
};

const ownBorderPacked = (lut: PaletteLut, palette: readonly Rgba[], id: number): number => {
  let packed = lut.ownBorder.get(id);
  if (packed === undefined) {
    packed = packColor(ownBorderColor(id, palette));
    lut.ownBorder.set(id, packed);
  }
  return packed;
};

/** Packed colour for one tile (border-aware), via the palette's LUTs. */
const packedColorForTile = (
  map: GameMap,
  owner: ArrayLike<PlayerId>,
  ref: number,
  lut: PaletteLut,
  palette: readonly Rgba[],
  highlightId: number,
): number => {
  const id = owner[ref];
  if (id === NEUTRAL_PLAYER) return lut.terrain[map.terrain[ref]];
  if (!isBorderTile(map, owner, ref)) return ownedLut(lut, palette, id)[map.terrain[ref]];
  return id === highlightId
    ? ownBorderPacked(lut, palette, id)
    : borderPacked(lut, palette, id);
};

/**
 * A u32 view over an RGBA pixel buffer, so whole pixels are written with one
 * store. `ImageData.data` and `createPixelBuffer` results always start at
 * byte offset 0; the alignment check keeps an exotic caller-supplied subarray
 * working via a copy-free fallback path.
 */
const u32View = (pixels: Uint8ClampedArray): Uint32Array | null =>
  pixels.byteOffset % 4 === 0
    ? new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2)
    : null;

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
  highlightId: number = NO_HIGHLIGHT,
): void => {
  const lut = lutFor(palette);
  const packed = packedColorForTile(map, owner, ref, lut, palette, highlightId);
  const u32 = u32View(pixels);
  if (u32) {
    u32[ref] = packed;
    return;
  }
  packScratch32[0] = packed;
  const offset = ref * 4;
  pixels[offset] = packScratch[0];
  pixels[offset + 1] = packScratch[1];
  pixels[offset + 2] = packScratch[2];
  pixels[offset + 3] = packScratch[3];
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
  highlightId: number = NO_HIGHLIGHT,
): void => {
  const expected = map.size * 4;
  if (pixels.length !== expected) {
    throw new Error(`Pixel buffer length ${pixels.length} does not match ${expected} (map.size * 4).`);
  }
  if (owner.length !== map.size) {
    throw new Error(`Owner array length ${owner.length} does not match map.size ${map.size}.`);
  }
  const lut = lutFor(palette);
  const u32 = u32View(pixels);
  if (u32) {
    for (let ref = 0; ref < map.size; ref += 1) {
      u32[ref] = packedColorForTile(map, owner, ref, lut, palette, highlightId);
    }
    return;
  }
  for (let ref = 0; ref < map.size; ref += 1) {
    packScratch32[0] = packedColorForTile(map, owner, ref, lut, palette, highlightId);
    const offset = ref * 4;
    pixels[offset] = packScratch[0];
    pixels[offset + 1] = packScratch[1];
    pixels[offset + 2] = packScratch[2];
    pixels[offset + 3] = packScratch[3];
  }
};
