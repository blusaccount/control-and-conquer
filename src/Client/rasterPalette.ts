import {
  isImpassable,
  isLand,
  isShore,
  magnitude,
  MAX_LAND_ELEVATION,
} from "../Core/terrainCodec.js";
import { NEUTRAL_PLAYER, type PlayerId } from "../Core/TerritoryGrid.js";

/**
 * Colour mapping for the raster renderer. Pure (no DOM), so the terrain →
 * pixel logic is unit-testable independently of any canvas. Channels are 0-255;
 * alpha is always opaque (255) since terrain fully covers the map.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));

const lerpChannel = (a: number, b: number, t: number): number => a + (b - a) * t;

const lerpColor = (a: Rgba, b: Rgba, t: number): Rgba => ({
  r: lerpChannel(a.r, b.r, t),
  g: lerpChannel(a.g, b.g, t),
  b: lerpChannel(a.b, b.b, t),
  a: 255,
});

// --- Terrain palette -------------------------------------------------------

/** Shallow water (just off the coast). */
const WATER_SHALLOW: Rgba = { r: 90, g: 155, b: 210, a: 255 };
/** Deep open water. */
const WATER_DEEP: Rgba = { r: 12, g: 40, b: 80, a: 255 };
/** Slight teal shift applied to inland lakes to set them apart from ocean. */
const LAKE_SHIFT: Rgba = { r: 40, g: 110, b: 120, a: 255 };
/** Low-elevation land. */
const LAND_LOW: Rgba = { r: 74, g: 120, b: 64, a: 255 };
/** High-elevation land. */
const LAND_HIGH: Rgba = { r: 120, g: 100, b: 72, a: 255 };
/** Impassable rock. */
const ROCK: Rgba = { r: 92, g: 92, b: 98, a: 255 };
/** Sandy tint blended into coastal land tiles. */
const SHORE_SAND: Rgba = { r: 196, g: 180, b: 132, a: 255 };
const SHORE_SAND_MIX = 0.35;

/** Water depth (in tiles) at which the deep-water colour is reached. */
const MAX_WATER_DEPTH_SHADE = 12;

/** Map a single encoded terrain byte to its natural (unowned) colour. */
export const terrainColor = (byte: number): Rgba => {
  if (!isLand(byte)) {
    const depth = magnitude(byte);
    const t = Math.min(1, depth / MAX_WATER_DEPTH_SHADE);
    const base = lerpColor(WATER_SHALLOW, WATER_DEEP, t);
    // Lakes (water tiles that are not ocean) get a gentle teal shift.
    const ocean = (byte & 0x20) !== 0;
    return ocean ? base : lerpColor(base, LAKE_SHIFT, 0.3);
  }
  if (isImpassable(byte)) {
    return { ...ROCK };
  }
  const elevation = magnitude(byte);
  const t = MAX_LAND_ELEVATION > 0 ? elevation / MAX_LAND_ELEVATION : 0;
  const land = lerpColor(LAND_LOW, LAND_HIGH, t);
  return isShore(byte) ? lerpColor(land, SHORE_SAND, SHORE_SAND_MIX) : land;
};

// --- Player palette --------------------------------------------------------

/**
 * Distinct owner colours, indexed by `(playerId - 1)`. The first two match the
 * polygon engine's blue/red teams; the rest extend the set for future
 * multi-player matches. Wraps around if more players than entries exist.
 */
export const DEFAULT_PLAYER_PALETTE: readonly Rgba[] = [
  { r: 59, g: 130, b: 246, a: 255 }, // blue
  { r: 239, g: 68, b: 68, a: 255 }, // red
  { r: 34, g: 197, b: 94, a: 255 }, // green
  { r: 234, g: 179, b: 8, a: 255 }, // amber
  { r: 168, g: 85, b: 247, a: 255 }, // purple
  { r: 20, g: 184, b: 166, a: 255 }, // teal
];

/** Colour for a given player id, wrapping the palette for large ids. */
export const playerColor = (
  id: PlayerId,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): Rgba => {
  const index = (id - 1) % palette.length;
  return { ...palette[index] };
};

/** Pure white, the target a border colour is lightened toward. */
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** How far a border tile's colour is pushed toward white from the owner hue. */
const BORDER_LIGHTEN = 0.62;

/**
 * Bright outline colour for a player's territory edge. A crisp, lightened
 * version of the owner colour at full saturation (no terrain blend), so nation
 * borders read as clean lines over the relief — OpenFront's territory outline.
 */
export const borderColor = (
  id: PlayerId,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): Rgba => lerpColor(playerColor(id, palette), WHITE, BORDER_LIGHTEN);

/** How strongly an owner's colour washes over the underlying terrain relief. */
const OWNERSHIP_MIX = 0.55;

/**
 * Final on-screen colour for a tile: natural terrain for water and neutral
 * land, or the owner's colour blended over the terrain relief for owned land so
 * elevation stays readable beneath the ownership wash.
 */
export const tileColor = (
  byte: number,
  ownerId: PlayerId,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): Rgba => {
  const terrain = terrainColor(byte);
  // Only passable land carries ownership; water and rock always show terrain.
  if (ownerId === NEUTRAL_PLAYER || !isLand(byte) || isImpassable(byte)) {
    return terrain;
  }
  const owner = playerColor(ownerId, palette);
  return {
    r: clamp255(lerpChannel(terrain.r, owner.r, OWNERSHIP_MIX)),
    g: clamp255(lerpChannel(terrain.g, owner.g, OWNERSHIP_MIX)),
    b: clamp255(lerpChannel(terrain.b, owner.b, OWNERSHIP_MIX)),
    a: 255,
  };
};
