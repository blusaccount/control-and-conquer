import { isImpassable, isLand, isShore, magnitude } from "../Core/terrainCodec.js";
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
//
// A faithful port of OpenFront's terrain colouring (`encodeTerrainTile` in
// OpenFrontIO's ColorUtils). The look hinges on two things our old palette got
// wrong, which is what made rivers and coasts read as bloated, glowing features:
//
//   1. Water is a near-flat, light medium-blue. There is *no* long shallow→deep
//      gradient — the ocean only darkens by up to 10 per channel with shore
//      distance, so coastlines have a crisp edge instead of a wide fuzzy halo.
//   2. The whole palette is light and pastel (light-green plains, tan sand,
//      grey peaks). A single-tile river is just shoreline water — a light
//      coastal blue — which sits naturally on light-green land instead of
//      glaring like bright cyan on dark navy.
//
// Lakes and ocean are coloured identically (water colour ignores the ocean/lake
// bit, exactly as OpenFront does); the bit is gameplay-only.

/** Open-ocean base — OpenFront's `oceanColor`, #4785b5. */
const OCEAN: Rgba = { r: 71, g: 133, b: 181, a: 255 };
/** Coastal land (any land tile on the shoreline). */
const SAND: Rgba = { r: 204, g: 203, b: 158, a: 255 };
/** Low-elevation plains. Green fades down as elevation rises. */
const PLAINS: Rgba = { r: 190, g: 220, b: 138, a: 255 };
/** Mid-elevation highland; all channels brighten with elevation. */
const HIGHLAND: Rgba = { r: 200, g: 183, b: 138, a: 255 };
/** High-elevation mountain; brightens toward white at the peaks. */
const MOUNTAIN: Rgba = { r: 230, g: 230, b: 230, a: 255 };
/** Impassable peak (rock). */
const PEAK: Rgba = { r: 60, g: 60, b: 60, a: 255 };

/** Map a single encoded terrain byte to its natural (unowned) colour. */
export const terrainColor = (byte: number): Rgba => {
  if (!isLand(byte)) {
    // Shoreline water: 70% ocean + 30% white — OpenFront's dynamic coastline,
    // a light band one tile wide. A 1-tile river is entirely shoreline water,
    // so this is the colour rivers read as.
    if (isShore(byte)) {
      return {
        r: Math.round(0.7 * OCEAN.r + 76.5),
        g: Math.round(0.7 * OCEAN.g + 76.5),
        b: Math.round(0.7 * OCEAN.b + 76.5),
        a: 255,
      };
    }
    // Open water: darken the ocean base by up to 10 with distance from shore.
    const m = Math.min(magnitude(byte), 10);
    return { r: OCEAN.r - m, g: OCEAN.g - m, b: OCEAN.b - m, a: 255 };
  }
  if (isImpassable(byte)) {
    return { ...PEAK };
  }
  // Land shoreline is sand, regardless of elevation.
  if (isShore(byte)) {
    return { ...SAND };
  }
  const m = magnitude(byte);
  if (m < 10) {
    // Plains: green dims as the ground rises.
    return { r: PLAINS.r, g: clamp255(PLAINS.g - 2 * m), b: PLAINS.b, a: 255 };
  }
  if (m < 20) {
    // Highland: all channels brighten toward tan.
    const d = 2 * (m - 10);
    return {
      r: clamp255(HIGHLAND.r + d),
      g: clamp255(HIGHLAND.g + d),
      b: clamp255(HIGHLAND.b + d),
      a: 255,
    };
  }
  // Mountain: brighten toward white at the peaks.
  const d = Math.floor(m / 2);
  return {
    r: clamp255(MOUNTAIN.r + d),
    g: clamp255(MOUNTAIN.g + d),
    b: clamp255(MOUNTAIN.b + d),
    a: 255,
  };
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

/**
 * Per-nation crest emojis, indexed by `(playerId - 1)`, wrapping for large ids.
 * A lightweight stand-in for OpenFront's national flags: a recognisable symbol
 * that disambiguates nations even when palette colours repeat at high counts.
 */
const PLAYER_EMOJIS: readonly string[] = [
  "🦁", "🐺", "🦅", "🐉", "🐻", "🦈", "🐗", "🦊",
  "🦂", "🐲", "🦉", "🐅", "🦏", "🐊", "🦇", "🐍",
  "🦌", "🐃", "🦬", "🦣", "🐆", "🦓", "🦃", "🦅",
];

/** Crest emoji for a player id (wraps for ids beyond the set). */
export const playerEmoji = (id: PlayerId): string =>
  PLAYER_EMOJIS[(id - 1) % PLAYER_EMOJIS.length];

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

/**
 * Border colour for the local player's *own* nation: a near-pure-white outline
 * so "me" reads at a glance on a crowded map (OpenFront highlights the player's
 * own territory the same way). Still tinted a hair toward the owner hue so the
 * nation colour is recognisable on the edge.
 */
export const ownBorderColor = (
  id: PlayerId,
  palette: readonly Rgba[] = DEFAULT_PLAYER_PALETTE,
): Rgba => lerpColor(playerColor(id, palette), WHITE, 0.85);

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
