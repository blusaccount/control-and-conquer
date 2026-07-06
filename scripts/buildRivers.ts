/**
 * River asset build tool: turn Natural Earth river centerlines into the compact
 * polyline asset the server stamps into real-world maps as water.
 *
 * OpenFront paints rivers as water directly into its hand-authored map images.
 * Our source (`earth-topo.png`) is raw topography with no hydrography, so we
 * carry rivers as their own data layer instead (see `src/Server/rivers.ts`).
 * This script converts the public-domain Natural Earth "rivers + lake
 * centerlines" GeoJSON into a small, quantised list of named `[lon, lat]`
 * polylines that `carveRivers` rasterises at runtime — the river equivalent of
 * how `buildMap.ts` turns a source heightmap into `earth-topo.png`.
 *
 * Rivers are gameplay: they are contested movement corridors and defensive
 * lines, and controlling them should matter. Natural Earth ships ~900 named
 * centerline segments, which at game-grid scale reads as noise — every valley
 * a blue thread, none of them important. So the default build keeps only the
 * CURATED whitelist below: the world-historically strategic rivers (interior
 * corridors like the Mississippi or Yangtze, border barriers like the Rio
 * Grande or Amur). Pass `--all` to skip the whitelist and keep everything.
 *
 * Natural Earth 50m centerlines also stop short of the sea at several big
 * deltas (the Nile ends at Cairo, the Rhine at the delta head, the Yangtze
 * ~150 km inland), which would leave the carved channel as an inland lake
 * instead of a navigable corridor. MOUTH_CHANNELS below are short hand-authored
 * connector polylines that bridge each known gap to open water; they are merged
 * into the output under the same system name.
 *
 * Source data (public domain, Natural Earth via nvkelso/natural-earth-vector):
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson
 *
 * Usage:
 *   tsx scripts/buildRivers.ts --in <rivers.geojson> [--out earth-rivers.json] [--epsilon 0.04] [--all]
 *
 * The output is written under assets/maps/. Only the processed asset is
 * committed; the multi-megabyte source GeoJSON is not (regenerate with this
 * script). The format is `{ name, points }[]` (points are `[lon, lat]` pairs),
 * with coordinates rounded to 2 decimals (~1 km) and near-collinear points
 * dropped.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface GeoFeature {
  properties: { name?: string | null; name_en?: string | null };
  geometry: { type: string; coordinates: number[][] | number[][][] };
}
interface GeoJson {
  features: GeoFeature[];
}

/**
 * The strategic-river whitelist: game system name → Natural Earth feature
 * names (`name_en`/`name`) that make up that river system. A system groups the
 * main stem with the tributaries/distributaries needed for the channel to run
 * continuously from deep inland to the sea (Missouri feeds the Mississippi at
 * St. Louis; Tigris and Euphrates merge into the Shatt al-Arab; the Huang He's
 * lower reach is the separately-named "Yellow").
 *
 * Curation rule: a river earns a slot only if it is a navigable corridor into
 * a continent's interior or a defensible border between regions. Famous-but-
 * small rivers (Seine, Thames, Elbe, Po, Colorado, …) are deliberately absent —
 * at game-grid scale they are a few tiles long and dilute the ones that matter.
 */
const CURATED: ReadonlyMap<string, readonly string[]> = new Map([
  // Africa
  ["Nile", ["Nile", "White Nile", "Blue Nile"]],
  ["Congo", ["Congo"]],
  ["Niger", ["Niger"]],
  ["Zambezi", ["Zambezi"]],
  // Europe
  ["Rhine", ["Rhine", "Rhein"]],
  ["Danube", ["Danube"]],
  ["Volga", ["Volga"]],
  ["Dnieper", ["Dnieper"]],
  // Middle East / South Asia
  ["Tigris-Euphrates", ["Tigris", "Euphrates", "Shatt al Arab"]],
  ["Indus", ["Indus"]],
  ["Ganges", ["Ganges", "Brahmaputra"]],
  // East / Southeast Asia
  ["Yangtze", ["Yangtze"]],
  ["Yellow River", ["Huang", "Yellow"]],
  ["Mekong", ["Mekong"]],
  ["Amur", ["Amur"]],
  // Siberia
  ["Ob", ["Ob"]],
  // Americas
  ["Mississippi", ["Mississippi", "Missouri"]],
  ["St. Lawrence", ["St. Lawrence"]],
  ["Rio Grande", ["Rio Grande"]],
  ["Amazon", ["Amazonas"]],
  ["Paraná", ["Paraná"]],
]);

/**
 * Hand-authored connector channels, `[lon, lat]` in degrees.
 *
 * Most entries are mouth connectors: Natural Earth 50m centerlines end where a
 * delta starts braiding, so without these the carved channel never touches
 * pre-existing sea and the finishing pass classifies the whole river as an
 * isolated lake. Each starts at (or near) the dataset's downstream endpoint
 * and ends a comfortable margin into open water.
 *
 * The Great Lakes entries are different: the topography source has no lakes
 * above sea level (only the below-sea-level Caspian survives), so the lakes
 * are represented the way everything hydrographic is here — as a carved
 * channel chain, Duluth → Superior → Huron → Erie → Ontario, joining the
 * St. Lawrence out to the Atlantic. Strategically that is what the Great
 * Lakes are: a navigable corridor into the North American interior.
 */
const MOUTH_CHANNELS: readonly { name: string; points: number[][] }[] = [
  { name: "Nile", points: [[31.2, 30.1], [30.9, 31.0], [30.4, 31.7]] }, // Cairo → Rosetta mouth → Med
  { name: "Rhine", points: [[5.0, 51.8], [4.4, 51.9], [3.6, 52.0]] }, // delta head → North Sea
  { name: "Danube", points: [[28.8, 45.2], [29.9, 45.2]] }, // delta → Black Sea
  { name: "Dnieper", points: [[32.6, 46.6], [31.9, 46.3]] }, // Kherson → Dnieper liman
  { name: "Volga", points: [[48.7, 46.1], [49.4, 45.5]] }, // Astrakhan delta → Caspian
  { name: "Tigris-Euphrates", points: [[48.5, 30.0], [48.9, 29.5]] }, // Shatt al-Arab → Persian Gulf
  { name: "Yangtze", points: [[120.1, 32.0], [121.2, 31.6], [122.4, 31.2]] }, // → East China Sea
  { name: "Mekong", points: [[105.8, 10.0], [106.7, 9.6]] }, // delta → South China Sea
  { name: "Amur", points: [[140.8, 53.1], [141.5, 53.3]] }, // → Amur liman / Sea of Okhotsk
  // Natural Earth leaves a gap at the Brahmaputra's great bend, stranding the
  // Tibetan reach as an isolated channel; bridge it.
  { name: "Ganges", points: [[94.4, 29.3], [95.4, 28.0]] },
  { name: "Amazon", points: [[-52.7, -1.6], [-51.4, -0.8], [-50.0, 0.2]] }, // → Atlantic
  { name: "Paraná", points: [[-58.4, -34.0], [-57.2, -34.7], [-55.8, -35.3]] }, // → Río de la Plata
  { name: "Congo", points: [[13.1, -5.9], [12.1, -6.0]] }, // → Atlantic
  // Natural Earth has only a 7-point stub of the St. Lawrence near Cornwall;
  // author the rest of the corridor: Montreal → Québec → down the estuary to
  // the open Gulf of St. Lawrence, so the Great Lakes gain their Atlantic
  // gateway.
  {
    name: "St. Lawrence",
    points: [[-74.7, 45.0], [-73.5, 45.7], [-72.2, 46.4], [-71.0, 46.9], [-69.8, 47.7], [-68.8, 48.4], [-66.8, 48.9], [-64.2, 49.2]],
  },
  // Great Lakes chain: Superior (Duluth → Whitefish Bay) → St. Marys → Huron →
  // St. Clair/Detroit → Erie → Niagara → Ontario → Kingston, joining the
  // Natural Earth St. Lawrence stub at [-75.8, 44.5].
  {
    name: "Great Lakes",
    points: [
      [-92.1, 46.7], [-90.0, 47.0], [-87.5, 47.4], [-85.5, 46.9], [-84.3, 46.5], [-83.9, 45.9],
      [-82.7, 44.9], [-82.4, 43.1], [-83.0, 42.4], [-83.0, 42.0], [-81.5, 41.9], [-79.8, 42.3],
      [-78.9, 42.9], [-78.9, 43.3], [-77.5, 43.6], [-76.5, 44.2], [-75.8, 44.5],
    ],
  },
  // Lake Michigan spur, branching off the chain waypoint at northern Lake
  // Huron through the Straits of Mackinac, down to the Chicago end of the
  // lake. The first point must stay on the main chain so the spur is not an
  // isolated channel.
  { name: "Great Lakes", points: [[-83.9, 45.9], [-84.9, 45.75], [-86.4, 44.2], [-87.4, 42.6]] },
];

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
    console.error(
      "Usage: tsx scripts/buildRivers.ts --in <rivers.geojson> [--out earth-rivers.json] [--epsilon 0.04] [--all]",
    );
    process.exit(1);
  }
  const outName = args.out || "earth-rivers.json";
  const epsilon = Number(args.epsilon ?? 0.04) || 0.04;
  const keepAll = "all" in args;

  // Invert the whitelist: Natural Earth feature name → game system name.
  const systemByNeName = new Map<string, string>();
  for (const [system, neNames] of CURATED) {
    for (const ne of neNames) systemByNeName.set(ne, system);
  }

  const geo = JSON.parse(readFileSync(args.in, "utf8")) as GeoJson;
  const rivers: { name: string; points: number[][] }[] = [];
  const perSystem = new Map<string, number>();
  let rawPoints = 0;
  let keptPoints = 0;
  let skippedFeatures = 0;

  for (const f of geo.features) {
    const neName = f.properties.name_en || f.properties.name || "";
    const system = keepAll ? neName || "(unnamed)" : systemByNeName.get(neName);
    if (!system) {
      skippedFeatures += 1;
      continue;
    }
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
        rivers.push({ name: system, points: simplified });
        keptPoints += simplified.length;
        perSystem.set(system, (perSystem.get(system) ?? 0) + 1);
      }
    }
  }

  if (!keepAll) {
    // Every whitelisted system must be found in the source, otherwise the
    // dataset changed names under us — fail loudly instead of shipping a map
    // that quietly lost the Nile.
    const missing = [...CURATED.keys()].filter((s) => !perSystem.has(s));
    if (missing.length > 0) {
      console.error(`No Natural Earth features matched: ${missing.join(", ")}`);
      process.exit(1);
    }
    for (const mouth of MOUTH_CHANNELS) {
      rivers.push({ name: mouth.name, points: mouth.points.map(([lon, lat]) => [q(lon), q(lat)]) });
      keptPoints += mouth.points.length;
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
      `(from ${rawPoints} raw, ${skippedFeatures} features skipped), ${(bytes / 1024).toFixed(0)} KB.`,
  );
  if (!keepAll) {
    const systems = [...perSystem.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`Systems (${systems.length}): ${systems.map(([n, c]) => `${n}×${c}`).join(", ")}`);
  }
};

main();
