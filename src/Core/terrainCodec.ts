/**
 * Compact 1-byte-per-tile terrain encoding for the pixel-raster engine.
 *
 * Every tile of a `GameMap` is stored as a single `Uint8`. Packing the terrain
 * into one byte keeps a full raster cheap to hold in memory and trivial to ship
 * over the wire later (Phase 4). This is our own format, designed for this
 * engine; the layout below is the canonical specification.
 *
 * Bit layout (MSB first):
 *   bit 7 (0x80) LAND      1 = land, 0 = water
 *   bit 6 (0x40) SHORELINE 1 = coastal tile (land touching water or vice versa)
 *   bit 5 (0x20) OCEAN     1 = open ocean, 0 = inland lake (water tiles only)
 *   bits 0-4 (0x1F) MAGNITUDE  0-31, meaning depends on LAND:
 *     - LAND:  elevation 0-30. The reserved value 31 marks an IMPASSABLE tile
 *              (solid rock): not ownable and not attackable.
 *     - WATER: "depth" = distance (in tiles) to the nearest shoreline, filled
 *              by the generator. 0 means the depth has not been computed yet.
 *
 * The OCEAN bit is only meaningful for water tiles; it is ignored (and kept 0
 * by `encodeTile`) for land.
 */

/** Bit 7: set when the tile is land, clear when it is water. */
export const LAND_BIT = 0x80;
/** Bit 6: set when the tile borders the opposite element (coast). */
export const SHORELINE_BIT = 0x40;
/** Bit 5: set for open ocean, clear for an inland lake. Water tiles only. */
export const OCEAN_BIT = 0x20;
/** Bits 0-4: the 5-bit magnitude field. */
export const MAGNITUDE_MASK = 0x1f;

/** Reserved land magnitude marking an impassable, non-ownable rock tile. */
export const IMPASSABLE_MAGNITUDE = 31;
/** Highest elevation a passable land tile may carry (0-30). */
export const MAX_LAND_ELEVATION = 30;
/** Largest value the 5-bit magnitude field can hold. */
export const MAX_MAGNITUDE = MAGNITUDE_MASK;

/** Decoded view of a single tile byte. */
export interface TileProps {
  /** True for land, false for water. */
  land: boolean;
  /** Coastal tile flag. */
  shoreline: boolean;
  /** Open-ocean flag. Only meaningful when `land` is false. */
  ocean: boolean;
  /**
   * 0-31. For land this is elevation (31 = impassable); for water it is the
   * distance to the nearest shoreline.
   */
  magnitude: number;
}

const clampMagnitude = (magnitude: number): number => {
  if (!Number.isInteger(magnitude)) {
    throw new Error(`Tile magnitude must be an integer, got ${magnitude}.`);
  }
  if (magnitude < 0 || magnitude > MAX_MAGNITUDE) {
    throw new Error(`Tile magnitude ${magnitude} is out of range 0-${MAX_MAGNITUDE}.`);
  }
  return magnitude;
};

/**
 * Pack tile properties into a single byte. The OCEAN bit is forced clear for
 * land so the encoding of a tile is canonical regardless of caller input.
 */
export const encodeTile = (props: TileProps): number => {
  const magnitude = clampMagnitude(props.magnitude);
  let byte = magnitude;
  if (props.land) {
    byte |= LAND_BIT;
  } else if (props.ocean) {
    byte |= OCEAN_BIT;
  }
  if (props.shoreline) {
    byte |= SHORELINE_BIT;
  }
  return byte & 0xff;
};

/** Unpack a tile byte into its properties. */
export const decodeTile = (byte: number): TileProps => {
  const land = (byte & LAND_BIT) !== 0;
  return {
    land,
    shoreline: (byte & SHORELINE_BIT) !== 0,
    // The ocean bit is only meaningful for water; report it as false for land.
    ocean: !land && (byte & OCEAN_BIT) !== 0,
    magnitude: byte & MAGNITUDE_MASK,
  };
};

/** True when the tile is land. */
export const isLand = (byte: number): boolean => (byte & LAND_BIT) !== 0;

/** True when the tile is water. */
export const isWater = (byte: number): boolean => (byte & LAND_BIT) === 0;

/** True when the tile is a coastline (land or water bordering the other). */
export const isShore = (byte: number): boolean => (byte & SHORELINE_BIT) !== 0;

/** True when the tile is open ocean (water tiles only). */
export const isOcean = (byte: number): boolean =>
  (byte & LAND_BIT) === 0 && (byte & OCEAN_BIT) !== 0;

/** True when the tile is impassable solid rock (land with magnitude 31). */
export const isImpassable = (byte: number): boolean =>
  (byte & LAND_BIT) !== 0 && (byte & MAGNITUDE_MASK) === IMPASSABLE_MAGNITUDE;

/**
 * Raw 5-bit magnitude of the tile: elevation for land (31 = impassable),
 * shoreline distance for water.
 */
export const magnitude = (byte: number): number => byte & MAGNITUDE_MASK;
