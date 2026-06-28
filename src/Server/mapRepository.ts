import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMap, type LoadedMap } from "../Core/mapLoader.js";
import { BUILTIN_MAPS } from "../Core/maps/index.js";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const mapsDir = join(rootDir, "maps");

/**
 * Resolve a map id to a validated `LoadedMap`. A JSON file at
 * `maps/<id>.json` wins so new content can be dropped in without code changes;
 * otherwise an engine built-in is used. Throws if neither exists or the data
 * fails validation.
 */
export const loadMapById = (id: string): LoadedMap => {
  const filePath = join(mapsDir, `${id}.json`);
  if (existsSync(filePath)) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return loadMap(raw);
  }

  const builtin = BUILTIN_MAPS[id];
  if (builtin) {
    return loadMap(builtin);
  }

  throw new Error(`Unknown map id "${id}" (no maps/${id}.json file and no built-in match).`);
};
