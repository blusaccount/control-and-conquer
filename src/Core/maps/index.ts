import type { MapDefinition } from "../types.js";
import { CONQUEROR_BASIN } from "./conquerorBasin.js";

/**
 * Maps compiled into the engine. The filesystem map repository (server side)
 * prefers `maps/<id>.json` files and falls back to these built-ins, so the
 * engine always has a valid default with zero filesystem dependencies.
 */
export const BUILTIN_MAPS: Record<string, MapDefinition> = {
  "conqueror-basin": CONQUEROR_BASIN,
};

export const DEFAULT_MAP_ID = "conqueror-basin";

export { CONQUEROR_BASIN };
