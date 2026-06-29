/**
 * River asset build tool: turn Natural Earth river centerlines into the compact
 * polyline asset the server stamps into real-world maps as water.
 *
 * OpenFront paints rivers as water directly into its hand-authored map images.
 * Our source (`earth-topo.png`) is raw topography with no hydrography, so we
 * carry rivers as their own data layer instead (see `src/Server/rivers.ts`).
 * This script converts the public-domain Natural Earth "rivers + lake
 * centerlines" GeoJSON into a small, quantised list of `[lon, lat]` polylines
 * that `carveRivers` rasterises at runtime — the river equivalent of how
 * `buildMap.ts` turns a source heightmap into `earth-topo.png`.
 *
 * Source data (public domain, Natural Earth via nvkelso/natural-earth-vector):
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson
 *
 * Usage:
 *   tsx scripts/buildRivers.ts --in <rivers.geojson> [--out earth-rivers.json] [--epsilon 0.04]
 *
 * The output is written under assets/maps/. Only the processed asset is
 * committed; the multi-megabyte source GeoJSON is not (regenerate with this
 * script). The format is `number[][][]`: rivers → points → `[lon, lat]`, with
 * coordinates rounded to 2 decimals (~1 km) and near-collinear points dropped.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface GeoFeature {
  geometry: { type: string; coordinates: number[][] | number[][][] };
}
interface GeoJson {
  features: GeoFeature[];
}

/** Round to 2 decimals (~1 km at the equator), as a plain number. */
const q = (n: number): number => Math.round(n * 100) / 100;

/**
 * Radial-distance simplification: keep the first and last point and drop any
 * intermediate point closer than `epsilon` degrees to the last kept one. Coarse
 * but plenty for game-grid scale, and it shrinks the asset substantially.
 */
const simplify = (pts: number[][], epsilon: number): number[][] => {
  if (pts.length <= 2) return pts;
  const out: number[][] = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= epsilon) {
      out.push(p);
      last = p;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};

const parseArgs = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in) {
    console.error("Usage: tsx scripts/buildRivers.ts --in <rivers.geojson> [--out earth-rivers.json] [--epsilon 0.04]");
    process.exit(1);
  }
  const outName = args.out || "earth-rivers.json";
  const epsilon = Number(args.epsilon ?? 0.04) || 0.04;

  const geo = JSON.parse(readFileSync(args.in, "utf8")) as GeoJson;
  const rivers: number[][][] = [];
  let rawPoints = 0;
  let keptPoints = 0;

  for (const f of geo.features) {
    const g = f.geometry;
    // Both LineString (one line) and MultiLineString (many) appear in the data.
    const lines: number[][][] =
      g.type === "LineString"
        ? [g.coordinates as number[][]]
        : g.type === "MultiLineString"
          ? (g.coordinates as number[][][])
          : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      rawPoints += line.length;
      const simplified = simplify(line, epsilon).map(([lon, lat]) => [q(lon), q(lat)]);
      if (simplified.length >= 2) {
        rivers.push(simplified);
        keptPoints += simplified.length;
      }
    }
  }

  const assetsDir = fileURLToPath(new URL("../assets/maps/", import.meta.url));
  mkdirSync(assetsDir, { recursive: true });
  const outPath = fileURLToPath(new URL(`../assets/maps/${outName}`, import.meta.url));
  // Compact one-line JSON: no need for human formatting, the source is the data.
  writeFileSync(outPath, JSON.stringify(rivers));

  const bytes = readFileSync(outPath).length;
  console.log(
    `Wrote ${outName}: ${rivers.length} polylines, ${keptPoints} points ` +
      `(from ${rawPoints} raw), ${(bytes / 1024).toFixed(0)} KB.`,
  );
};

main();
