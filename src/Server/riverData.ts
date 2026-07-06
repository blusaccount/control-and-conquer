import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { River } from "./rivers.js";

/**
 * Loader for the committed real-world river asset.
 *
 * `assets/maps/earth-rivers.json` is generated from Natural Earth river
 * centerlines by `scripts/buildRivers.ts` and committed in the compact form
 * `{ name, points }[]` (points are `[lon, lat]` pairs). The asset is a curated
 * whitelist of strategically relevant river systems (see the build script);
 * `name` is the game-facing system name (e.g. several polylines all named
 * "Mississippi"). The runtime reads it once and caches the decoded `River[]`,
 * which `heightmapMaps` then stamps into the map as water via `carveRivers`.
 * Kept separate from `rivers.ts` so the carving logic stays a pure,
 * filesystem-free unit.
 */
let cache: River[] | null = null;

/** Load (and cache) the committed Natural Earth river polylines. */
export const loadEarthRivers = (): River[] => {
  if (cache) return cache;
  const path = fileURLToPath(new URL("../../assets/maps/earth-rivers.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name: string; points: number[][] }[];
  cache = raw.map((r) => ({ name: r.name, points: r.points as [number, number][] }));
  return cache;
};
