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
 * for whatever target grid a heightmap map resolves to. Each river is traced
 * from its headwaters down to a river mouth a little offshore, so the carved
 * water overlaps real ocean tiles and the finishing flood-fill marks the whole
 * channel as open ocean — navigable, and a natural amphibious border. The carve
 * is a hard override (it ignores the land-fraction vote that would otherwise
 * round a sub-cell river back to land) and is fully deterministic.
 */

/** A river as an ordered list of `[lon, lat]` waypoints in degrees. */
export interface River {
  name: string;
  points: ReadonlyArray<readonly [number, number]>;
}

/**
 * A curated set of major world rivers, each traced source → mouth (the final
 * point sits a touch offshore so the channel connects to open ocean). Coarse by
 * design: a handful of waypoints is enough once rasterised to game-grid scale.
 */
export const WORLD_RIVERS: readonly River[] = [
  {
    name: "Amazon",
    points: [
      [-73, -11],
      [-70, -12],
      [-65, -9],
      [-60, -5],
      [-55, -2],
      [-50, -0.5],
      [-48, 0],
    ],
  },
  {
    name: "Nile",
    points: [
      [31.5, 2],
      [32, 5],
      [32.5, 15],
      [32.5, 24],
      [31.2, 30],
      [31, 31.5],
      [31, 33],
    ],
  },
  {
    name: "Mississippi",
    points: [
      [-95, 47.5],
      [-91, 43],
      [-90, 38],
      [-91, 32],
      [-89.2, 29.1],
      [-89, 28],
    ],
  },
  {
    name: "Yangtze",
    points: [
      [91, 33],
      [100, 30],
      [107, 30],
      [114, 30],
      [121.8, 31.4],
      [123, 31.5],
    ],
  },
  {
    name: "Danube",
    points: [
      [8.2, 48],
      [16, 48],
      [19, 47],
      [24, 44],
      [29.6, 45.2],
      [31, 45.2],
    ],
  },
  {
    name: "Congo",
    points: [
      [27, -11],
      [23, -6],
      [19, -3],
      [15, -4],
      [12.4, -6],
      [11, -6],
    ],
  },
];

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
  const latSpan = latMax - latMin || 1;

  const lonToTx = (lon: number): number => ((lon + 180) / 360) * width;
  const latToTy = (lat: number): number => ((latMax - lat) / latSpan) * height;

  // Snapshot which tiles were already water (sea/lake from the heightmap) before
  // we carve anything, so the mouth-extension below can detect when it has
  // reached the pre-existing coastline.
  const wasWater = land.slice();

  const stamp = (cx: number, cy: number): void => {
    const cxi = Math.round(cx);
    const cyi = Math.round(cy);
    const r = halfWidth;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cxi + dx;
        const y = cyi + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        land[i] = 0;
        elevation[i] = 0;
      }
    }
  };

  // Cap how far a mouth may be pushed offshore so a mis-traced river can never
  // bulldoze a channel across a whole continent.
  const maxExtend = Math.max(8, Math.ceil(width / 20));

  for (const river of rivers) {
    const pts = river.points;
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
    if (pts.length >= 2) {
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
          xi >= 0 && yi >= 0 && xi < width && yi < height && wasWater[yi * width + xi] === 0;
        stamp(cx, cy);
        if (reachedSea) break;
      }
    }
  }
};

/**
 * Brush half-width to use for a given grid width: wider grids get fatter rivers
 * so they stay visible, while small grids keep single-tile channels that don't
 * swallow the land they cut through.
 */
export const riverHalfWidthFor = (width: number): number =>
  width >= 1500 ? 2 : width >= 600 ? 1 : 0;
