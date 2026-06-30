import type { GameMap } from "../Core/GameMap.js";
import { buildHeightmapGameMap, getHeightmapMap } from "./heightmapMaps.js";

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
