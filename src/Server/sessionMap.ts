import type { GameMap } from "../Core/GameMap.js";
import { buildHeightmapGameMap, getHeightmapMap } from "./heightmapMaps.js";
import { buildRealMap, getRealMap } from "../Core/realMaps.js";
import { generateTerrain } from "../Core/terrainGenerator.js";
import type { MapChoiceOptions } from "../Core/mapCatalog.js";

/** A fully built map plus its display name, ready to hand to a session. */
export interface ResolvedSessionMap {
  map: GameMap;
  name: string;
}

/**
 * Resolve a heightmap map id (e.g. `"earth"`) to a fully built {@link GameMap}.
 *
 * Heightmap maps are the only map kind whose construction touches Node-only APIs
 * (the `fs`/`zlib` PNG decode + downsample in {@link buildHeightmapGameMap}).
 * Keeping that resolution *here* — rather than inside {@link RasterGameSession} —
 * lets the session stay free of those imports, so the exact same simulation class
 * can run in a browser Web Worker (the worker fetches prebuilt terrain instead).
 * ASCII real maps and procedural terrain are pure `Core` code and are still built
 * inside the session.
 *
 * Returns `null` when `realMapId` is not a known heightmap id, so callers can fall
 * through to the session's built-in real/procedural handling.
 */
export const resolveHeightmapSessionMap = (
  realMapId: string | undefined,
  mapSize: number | undefined,
): ResolvedSessionMap | null => {
  const def = realMapId ? getHeightmapMap(realMapId) : undefined;
  if (!def) return null;
  return { map: buildHeightmapGameMap(def, mapSize || undefined), name: def.name };
};

/**
 * Build the {@link GameMap} for any catalogue map choice — heightmap, ASCII real
 * map, or procedural — the same way {@link RasterGameSession} would. This is the
 * single source of truth a solo Web Worker fetches its prebuilt terrain from (via
 * the `/api/solo/map` endpoint), so the worker never has to decode a PNG or run
 * the Node-only map loaders itself. Underlying builders cache by size, so repeat
 * calls for the same choice are cheap.
 */
export const resolveCatalogSessionMap = (
  options: MapChoiceOptions,
  fallbackName = "Procedural Continent",
): ResolvedSessionMap => {
  const heightmap = resolveHeightmapSessionMap(options.realMapId, options.mapSize);
  if (heightmap) return heightmap;
  if (options.realMapId) {
    const real = getRealMap(options.realMapId);
    if (real) return { map: buildRealMap(real), name: real.name };
  }
  const map = generateTerrain({
    width: options.width ?? 64,
    height: options.height ?? 40,
    seed: options.seed ?? 1,
  });
  return { map, name: fallbackName };
};
