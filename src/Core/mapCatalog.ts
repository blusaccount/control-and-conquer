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
 * raster) is offered at three sizes so players can trade detail for a lighter
 * match. Menu order = display order.
 *
 * Each tier's edge is 1.25× the previous design (≈1.56× the area, so "about 50%
 * bigger") — large enough to seat an OpenFront-style crowded field of nations
 * (see `scaleFieldCount`). The old stylised "World — Classic" sketch was
 * dropped: it was too small to host a readable multi-nation FFA.
 *
 * Procedural generation still exists server-side as a fallback (see
 * {@link RasterGameSessionOptions}), but it is intentionally not offered here —
 * only fixed, hand-curated maps are selectable for now.
 */
export const MAP_CHOICES: readonly MapChoice[] = [
  {
    id: "earth-standard",
    name: "Earth — Standard",
    description: "A compact globe for quicker runs against a handful of rival nations.",
    options: { realMapId: "earth", mapSize: 640 },
  },
  {
    id: "earth-large",
    name: "Earth — Large",
    description: "Real-world continents and coastlines with a few dozen rivals.",
    options: { realMapId: "earth", mapSize: 1280 },
  },
  {
    id: "earth-huge",
    name: "Earth — Huge",
    description: "The whole planet in detail — a sprawling field of nations.",
    options: { realMapId: "earth", mapSize: 2560 },
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
