/**
 * Player-selectable map catalogue.
 *
 * The map a run is played on is no longer fixed at server start — every client
 * picks one from this catalogue in the main menu, and the server resolves the
 * choice into {@link RasterGameSession} options. Keeping the catalogue in Core
 * (pure, dependency-free) lets the menu render the exact same list the server
 * validates against, so the two can never drift.
 *
 * A choice carries only the *partial session options* it implies — a map id +
 * size for the real-world maps, or grid dimensions for procedural terrain. It
 * never imports the map builders themselves (those live server-side and touch
 * the filesystem), so this module stays safe to bundle into the browser client.
 */

/** The subset of RasterGameSession options a map choice fills in. */
export interface MapChoiceOptions {
  /** Heightmap or ASCII map id (e.g. "earth", "world"). Omitted for procedural. */
  readonly realMapId?: string;
  /** Target width in tiles for heightmap maps (height follows the geography). */
  readonly mapSize?: number;
  /** Procedural grid width (ignored when `realMapId` is set). */
  readonly width?: number;
  /** Procedural grid height (ignored when `realMapId` is set). */
  readonly height?: number;
  /** Procedural terrain seed. */
  readonly seed?: number;
}

export interface MapChoice {
  /** Stable id sent in the join payload and used to select the map. */
  readonly id: string;
  /** Human-readable name shown on the menu card. */
  readonly name: string;
  /** One-line description shown under the name. */
  readonly description: string;
  /** Session options this choice applies. */
  readonly options: MapChoiceOptions;
}

/**
 * The maps a player can pick. Earth (downsampled from the committed topology
 * raster) is the headline option at three sizes so players can trade detail for
 * a lighter match; World is the small stylised classic, and Procedural rolls a
 * fresh random continent. Menu order = display order.
 */
export const MAP_CHOICES: readonly MapChoice[] = [
  {
    id: "earth-standard",
    name: "Earth — Standard",
    description: "A lighter Earth for quicker runs. ~100k tiles.",
    options: { realMapId: "earth", mapSize: 512 },
  },
  {
    id: "earth-large",
    name: "Earth — Large",
    description: "Real-world continents and coastlines. ~400k tiles.",
    options: { realMapId: "earth", mapSize: 1024 },
  },
  {
    id: "earth-huge",
    name: "Earth — Huge",
    description: "The whole planet at high detail. ~1.6M tiles.",
    options: { realMapId: "earth", mapSize: 2048 },
  },
  {
    id: "world",
    name: "World — Classic",
    description: "A stylised six-continent sketch. Small and fast.",
    options: { realMapId: "world" },
  },
  {
    id: "procedural",
    name: "Procedural",
    description: "A freshly generated random continent.",
    options: { width: 256, height: 160, seed: 1 },
  },
];

/** Default map used when a client sends no choice (or an unknown one). */
export const DEFAULT_MAP_CHOICE_ID = "earth-large";

const MAP_CHOICE_BY_ID: ReadonlyMap<string, MapChoice> = new Map(
  MAP_CHOICES.map((choice) => [choice.id, choice]),
);

/** Look up a map choice by id, or `undefined` if unknown. */
export const getMapChoice = (id: string): MapChoice | undefined => MAP_CHOICE_BY_ID.get(id);

/** Runtime guard: is `value` a known map-choice id? */
export const isMapChoiceId = (value: unknown): value is string =>
  typeof value === "string" && MAP_CHOICE_BY_ID.has(value);

/** The default choice. Guaranteed to exist (asserted by the catalogue tests). */
export const DEFAULT_MAP_CHOICE: MapChoice = getMapChoice(DEFAULT_MAP_CHOICE_ID) as MapChoice;
