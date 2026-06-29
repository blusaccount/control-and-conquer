/**
 * Rivers for the real-world heightmap maps.
 *
 * OpenFront has no separate "river" terrain type — rivers are simply narrow
 * water channels painted into the source map. We do the same, but our source
 * (`earth-topo.png`) is a raw topography heightmap with no hydrography in it: a
 * river runs through a valley that still sits above sea level, so it would be
 * classified as land. We therefore carry rivers as their own data layer and
 * *stamp* them into the land/elevation mask as water before the shared
 * finishing pass classifies coast / ocean / lake / depth.
 *
 * Rivers are stored as ordered [lon, lat] waypoints (degrees) so they are
 * independent of grid size and projection crop; `carveRivers` rasterises them
 * for whatever target grid a heightmap map resolves to. The actual river
 * geometry is real-world data (Natural Earth centerlines) loaded from a
 * committed asset — see `riverData.ts` and `scripts/buildRivers.ts`. The carve
 * is a hard override (it ignores the land-fraction vote that would otherwise
 * round a sub-cell river back to land) and is fully deterministic.
 */

/** A river as an ordered list of `[lon, lat]` waypoints in degrees. */
export interface River {
  name?: string;
  points: ReadonlyArray<readonly [number, number]>;
}

export interface CarveRiversOptions {
  width: number;
  height: number;
  /** Length `width*height`; 1 = land, 0 = water. Mutated in place. */
  land: Uint8Array;
  /** Length `width*height`; land elevation. Carved tiles are reset to 0. */
  elevation: Uint8Array;
  /** Latitude band of the crop (degrees), matching the heightmap map def. */
  latMax: number;
  latMin: number;
  /** Rivers to carve. */
  rivers: readonly River[];
  /**
   * Brush half-width in tiles. `0` carves a single-tile channel; `1` a 3-tile
   * channel, etc. Scaled by the caller so rivers stay visible at every grid
   * size without flooding small maps.
   */
  halfWidth: number;
  /**
   * When true, each polyline's final point is pushed in its flow direction until
   * it overlaps pre-existing sea, guaranteeing the channel connects to open
   * water. Only sensible for source→mouth traces; leave off for real-world
   * centerline data, whose segments are tributary/junction pieces whose
   * endpoints are not river mouths. @default false
   */
  extendMouths?: boolean;
}

/**
 * Stamp `rivers` into the `land`/`elevation` mask as water, in place.
 *
 * Geographic → tile mapping mirrors `heightmapMaps.buildHeightmapGameMap`:
 * longitude `-180..180` spans the full width; the cropped latitude band
 * `[latMin, latMax]` spans the full height. Each river segment is walked at
 * sub-tile steps and a disk of radius `halfWidth` is set to water at every step
 * so the channel stays connected.
 */
export const carveRivers = (opts: CarveRiversOptions): void => {
  const { width, height, land, elevation, latMax, latMin, rivers, halfWidth } = opts;
  const extendMouths = opts.extendMouths ?? false;
  const latSpan = latMax - latMin || 1;

  const lonToTx = (lon: number): number => ((lon + 180) / 360) * width;
  const latToTy = (lat: number): number => ((latMax - lat) / latSpan) * height;

  // Snapshot which tiles were already water (sea/lake from the heightmap) before
  // we carve anything, so the mouth-extension below can detect when it has
  // reached the pre-existing coastline. Only needed when extending mouths.
  const wasWater = extendMouths ? land.slice() : null;

  const setWater = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    land[i] = 0;
    elevation[i] = 0;
  };

  // Previous brush centre along the current trace, so a single-tile channel can
  // stay 4-connected (see below). Reset to NaN at the start of every trace.
  let prevX = NaN;
  let prevY = NaN;

  const stamp = (cx: number, cy: number): void => {
    const cxi = Math.round(cx);
    const cyi = Math.round(cy);
    // At halfWidth 0 the brush is a single tile, so a diagonal step between two
    // samples lands on a tile that is only 8-connected to the previous one. The
    // ocean flood-fill is 4-connected, so such a channel would be cut into
    // isolated lakes. Bridge each diagonal step with one orthogonal connector
    // tile to keep the thin channel 4-connected (no visible widening). Wider
    // brushes already overlap 4-connectedly, so this is a no-op for them.
    if (cxi !== prevX && cyi !== prevY && !Number.isNaN(prevX)) {
      setWater(prevX, cyi);
    }
    prevX = cxi;
    prevY = cyi;
    const r = halfWidth;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        setWater(cxi + dx, cyi + dy);
      }
    }
  };

  // Cap how far a mouth may be pushed offshore so a mis-traced river can never
  // bulldoze a channel across a whole continent.
  const maxExtend = Math.max(8, Math.ceil(width / 20));

  for (const river of rivers) {
    const pts = river.points;
    prevX = NaN;
    prevY = NaN;
    for (let s = 0; s < pts.length - 1; s += 1) {
      const ax = lonToTx(pts[s][0]);
      const ay = latToTy(pts[s][1]);
      const bx = lonToTx(pts[s + 1][0]);
      const by = latToTy(pts[s + 1][1]);
      // Step along the segment at <=0.5-tile intervals so the disk brush leaves
      // no gaps even on long, near-diagonal reaches.
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(dist * 2));
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        stamp(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }

    // Extend the mouth in the direction of the final reach until it overlaps
    // pre-existing water, so the channel always connects to the open sea (and
    // the finishing flood-fill classifies the whole river as ocean). If the
    // mouth already sits on water this stops immediately.
    if (extendMouths && pts.length >= 2) {
      // The mouth extension continues straight from the final reach, so keep the
      // 4-connected trail running (do not reset prevX/prevY here).
      const px = lonToTx(pts[pts.length - 2][0]);
      const py = latToTy(pts[pts.length - 2][1]);
      const mx = lonToTx(pts[pts.length - 1][0]);
      const my = latToTy(pts[pts.length - 1][1]);
      const len = Math.hypot(mx - px, my - py) || 1;
      const dirX = (mx - px) / len;
      const dirY = (my - py) / len;
      for (let step = 0; step <= maxExtend; step += 1) {
        const cx = mx + dirX * step;
        const cy = my + dirY * step;
        const xi = Math.round(cx);
        const yi = Math.round(cy);
        const reachedSea =
          xi >= 0 && yi >= 0 && xi < width && yi < height && wasWater![yi * width + xi] === 0;
        stamp(cx, cy);
        if (reachedSea) break;
      }
    }
  }
};

/**
 * Brush half-width to use for a given grid width. OpenFront paints rivers as
 * thin (≈1-tile) water channels in its source maps and never fattens them by
 * map size, so we keep single-tile channels at every normal grid size: a wider
 * brush makes rivers read as bloated lakes (and the bright shallow-water shading
 * adds a glow halo on each side that exaggerates them further). Only very
 * high-resolution grids, where a single tile would shrink below a pixel, widen
 * to a 3-tile channel so the river stays visible.
 */
export const riverHalfWidthFor = (width: number): number => (width >= 2400 ? 1 : 0);
