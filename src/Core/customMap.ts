import { GameMap } from "./GameMap.js";
import { buildTerrainFromMask } from "./terrainBuilder.js";
import { IMPASSABLE_MAGNITUDE } from "./terrainCodec.js";

/**
 * The downloadable custom-map format (`.ccmap`) painted in the browser editor.
 *
 * OpenFront lets mapmakers paint terrain into a PNG and run it through an
 * offline generator; our in-browser editor is the same idea without the
 * round-trip: the player paints cells, downloads the result as a small JSON
 * file, and can re-import that file any time to play the map again. Custom
 * maps are deliberately **not stored on the server** — the file the player
 * downloads *is* the map, and it is carried inside the join payload (or built
 * directly in the solo Web Worker) for exactly one match at a time.
 *
 * One cell is one byte:
 *   - `0`                      → water
 *   - `1..30`                  → land elevation (plains → mountains)
 *   - `31` (IMPASSABLE_MAGNITUDE) → impassable rock
 *
 * The finishing pass (`buildTerrainFromMask`) then classifies shorelines,
 * ocean-vs-lake and water depth exactly like every other map source, so a
 * custom map is byte-compatible with catalogue maps. Rivers need no special
 * representation — as everywhere else in the engine, a river is simply a thin
 * painted water channel.
 *
 * This module is pure and environment-agnostic (no DOM, no Node built-ins):
 * the browser editor, the solo Web Worker and the server validator all share
 * these definitions, so the format cannot drift between them.
 */

/** Format tag; bump when the file layout changes incompatibly. */
export const CUSTOM_MAP_FORMAT = "ccmap-1";

/** Smallest playable edge — below this, spawns and the AI field can't fit. */
export const CUSTOM_MAP_MIN_EDGE = 48;
/** Largest edge the editor/validator accept. */
export const CUSTOM_MAP_MAX_EDGE = 1024;
/** Total-tile ceiling (~the catalogue's Earth-Large) to bound build cost. */
export const CUSTOM_MAP_MAX_TILES = 640_000;
/** A map needs at least this much land to seat a player plus a small field. */
export const CUSTOM_MAP_MIN_LAND_TILES = 400;
/** Display-name length cap. */
export const CUSTOM_MAP_MAX_NAME = 40;
/**
 * Upper bound for the serialized file on the wire (join payload). Base64 is
 * 4/3 of the raw cells plus JSON framing; this cap rejects oversized payloads
 * cheaply before any decoding happens.
 */
export const CUSTOM_MAP_MAX_FILE_CHARS = Math.ceil((CUSTOM_MAP_MAX_TILES * 4) / 3) + 4096;

/** A decoded, validated custom map ready to build or re-encode. */
export interface CustomMapData {
  name: string;
  width: number;
  height: number;
  /** Length `width*height`; see the cell semantics above. */
  cells: Uint8Array;
}

const NAME_PATTERN = /^[\p{L}\p{N} _.'-]{1,40}$/u;

// --- base64 (environment-agnostic) -----------------------------------------
// Node has Buffer, browsers and workers have btoa/atob; feature-detect instead
// of importing either, so this module stays loadable everywhere (the solo
// worker's import graph is verified Node-free by soloWorkerImports.test.ts).

interface BufferLike {
  from(data: Uint8Array | string, encoding?: string): { toString(encoding: string): string } & Uint8Array;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  const B = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let binary = "";
  const CHUNK = 0x8000; // keep String.fromCharCode's argument list bounded
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (encoded: string): Uint8Array => {
  const B = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (B) return new Uint8Array(B.from(encoded, "base64"));
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// --- encode / decode --------------------------------------------------------

/** Serialize a custom map to the downloadable `.ccmap` JSON text. */
export const encodeCustomMapFile = (data: CustomMapData): string =>
  JSON.stringify({
    format: CUSTOM_MAP_FORMAT,
    name: data.name,
    width: data.width,
    height: data.height,
    cells: bytesToBase64(data.cells),
  });

/**
 * Parse and fully validate a `.ccmap` file. Throws a descriptive `Error` on
 * any violation — the server surfaces the message as a join rejection, the
 * client as an import error. Never trusts the input: dimensions, cell count,
 * every cell value and the minimum-land rule are all checked.
 */
export const decodeCustomMapFile = (text: string): CustomMapData => {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Custom map file must be a non-empty string.");
  }
  if (text.length > CUSTOM_MAP_MAX_FILE_CHARS) {
    throw new Error(`Custom map file too large (max ${CUSTOM_MAP_MAX_FILE_CHARS} chars).`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Custom map file is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Custom map file must be a JSON object.");
  }
  const { format, name, width, height, cells } = raw as Record<string, unknown>;
  if (format !== CUSTOM_MAP_FORMAT) {
    throw new Error(`Unknown custom map format (expected "${CUSTOM_MAP_FORMAT}").`);
  }
  if (typeof name !== "string" || !NAME_PATTERN.test(name.trim())) {
    throw new Error(`Custom map name must be 1–${CUSTOM_MAP_MAX_NAME} letters, digits, spaces or _.'-`);
  }
  for (const [label, value] of [["width", width], ["height", height]] as const) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`Custom map ${label} must be an integer.`);
    }
    if (value < CUSTOM_MAP_MIN_EDGE || value > CUSTOM_MAP_MAX_EDGE) {
      throw new Error(`Custom map ${label} must be ${CUSTOM_MAP_MIN_EDGE}–${CUSTOM_MAP_MAX_EDGE} tiles.`);
    }
  }
  const w = width as number;
  const h = height as number;
  if (w * h > CUSTOM_MAP_MAX_TILES) {
    throw new Error(`Custom map too large: ${w}x${h} exceeds ${CUSTOM_MAP_MAX_TILES} tiles.`);
  }
  if (typeof cells !== "string") {
    throw new Error("Custom map cells must be a base64 string.");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(cells);
  } catch {
    throw new Error("Custom map cells are not valid base64.");
  }
  if (bytes.length !== w * h) {
    throw new Error(`Custom map cells length ${bytes.length} does not match ${w}x${h}=${w * h}.`);
  }
  let landTiles = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const cell = bytes[i];
    if (cell > IMPASSABLE_MAGNITUDE) {
      throw new Error(`Custom map cell ${i} has invalid value ${cell} (max ${IMPASSABLE_MAGNITUDE}).`);
    }
    if (cell > 0 && cell < IMPASSABLE_MAGNITUDE) landTiles += 1;
  }
  // Impassable rock is land for the mask but nobody can hold it, so only
  // capturable tiles count toward the playability floor.
  if (landTiles < CUSTOM_MAP_MIN_LAND_TILES) {
    throw new Error(
      `Custom map needs at least ${CUSTOM_MAP_MIN_LAND_TILES} capturable land tiles (has ${landTiles}).`,
    );
  }
  return { name: name.trim(), width: w, height: h, cells: bytes };
};

/**
 * Build a fully-classified {@link GameMap} from validated custom-map data via
 * the shared finishing pass. No speckle cleanup runs here — unlike a noisy
 * topography scan, every cell of a custom map is deliberate: if the player
 * painted a one-tile island, they get a one-tile island.
 */
export const buildCustomGameMap = (data: CustomMapData): GameMap => {
  const size = data.width * data.height;
  const land = new Uint8Array(size);
  const elevation = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const cell = data.cells[i];
    if (cell > 0) {
      land[i] = 1;
      elevation[i] = cell;
    }
  }
  return buildTerrainFromMask({ width: data.width, height: data.height, land, elevation });
};
