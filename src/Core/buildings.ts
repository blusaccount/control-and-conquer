/**
 * Buildings + gold economy definitions for the raster engine.
 *
 * OpenFront layers a second resource — **gold** — and a **building layer**
 * (cities, ports, …) on top of raw territory: gold accrues from the land you
 * hold, and you spend it on structures that compound your economy, extend your
 * navy or fortify your borders. This module is the single, framework-free source
 * of truth for that layer, shared by the Core simulation, the server validation
 * and the client build menu so none of them can drift on costs or effects.
 *
 * Everything here is pure data + pure functions: no `Math.random`, no
 * `Date.now`, so a building placed from a given gold pool is fully
 * deterministic and replay-stable, matching the rest of the engine.
 */

/** The kinds of structure a player can build on a tile they own. */
export type BuildingType = "city" | "port" | "fort";

/** All building types, in menu order. */
export const BUILDING_TYPES: readonly BuildingType[] = ["city", "port", "fort"];

/** Runtime guard: is `value` a known building type id? */
export const isBuildingType = (value: unknown): value is BuildingType =>
  typeof value === "string" && (BUILDING_TYPES as readonly string[]).includes(value);

/** Static description of one building type for menus and cost maths. */
export interface BuildingDef {
  readonly type: BuildingType;
  /** Human-readable label for the build menu. */
  readonly name: string;
  /** A short blurb describing the structure's effect. */
  readonly description: string;
  /** Emoji used as the map marker + menu icon (a lightweight stand-in for art). */
  readonly icon: string;
  /** Gold cost of this player's *first* building of the type. */
  readonly baseCost: number;
  /**
   * Multiplier applied per building of the type the player already owns, so each
   * additional structure of a kind costs more (`baseCost * growth^owned`). Keeps
   * a runaway empire from blanketing the map in free cities.
   */
  readonly costGrowth: number;
}

// --- Economy constants -----------------------------------------------------

/**
 * Fractional gold generated per owned tile per tick — the territory dividend.
 * Accumulated per player and flushed into the integer gold pool, mirroring the
 * troop income model. 0.01 at 20 TPS ≈ 0.2 gold/tile/second.
 */
export const GOLD_PER_TILE_PER_TICK = 0.01;

/** Every player starts a run with this much gold. */
export const STARTING_GOLD = 0;

/** Extra gold per tick each city adds on top of the territory dividend. */
export const CITY_GOLD_PER_TICK = 0.05;

/**
 * Extra troop income per tick each city adds (before the logistic soft cap is
 * applied), so a city is also a military engine — not merely a gold mine. Still
 * multiplied by the empire's {@link growthFactor}, so cities never push the pool
 * past its territory-scaled ceiling.
 */
export const CITY_TROOP_INCOME_PER_TICK = 0.1;

/**
 * Sea-range bonus (as a fraction added to the base crossing reach) each port
 * grants its owner, letting a maritime nation project transport ships across
 * wider water. Folded into {@link TerritoryGrid.seaRangeOf} and bounded there.
 */
export const PORT_SEA_RANGE_PER = 0.34;

/** A fort's defense-post aura — strength multiplier and radius (in tiles). */
export const FORT_DEFENSE_STRENGTH = 2;
export const FORT_DEFENSE_RADIUS = 4;

/** Static data for every building type, keyed by type id. */
export const BUILDING_DEFS: Readonly<Record<BuildingType, BuildingDef>> = {
  city: {
    type: "city",
    name: "City",
    description: "Boosts gold income and troop growth.",
    icon: "\u{1F3DB}\u{FE0F}", // 🏛️
    baseCost: 100,
    costGrowth: 1.6,
  },
  port: {
    type: "port",
    name: "Port",
    description: "Extends how far your transport ships can cross.",
    icon: "\u{2693}", // ⚓
    baseCost: 80,
    costGrowth: 1.5,
  },
  fort: {
    type: "fort",
    name: "Fort",
    description: "Fortifies the surrounding tiles against capture.",
    icon: "\u{1F6E1}\u{FE0F}", // 🛡️
    baseCost: 120,
    costGrowth: 1.7,
  },
};

/**
 * Gold cost for a player's next building of `type`, given how many of that type
 * they already own. Rounded to a whole number (rounding, not ceil, so float
 * noise like `100 * 1.6 = 160.000…3` doesn't tick the cost up by one). Grows
 * geometrically with `owned` (see {@link BuildingDef.costGrowth}).
 */
export const buildingCost = (type: BuildingType, owned: number): number => {
  const def = BUILDING_DEFS[type];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, Math.max(0, owned)));
};

/**
 * Gold generated per second by a player at the current territory + city count —
 * the figure the HUD/leaderboard shows as "(+N/s)". Derived from the same
 * per-tick income the engine applies so the displayed rate matches reality.
 */
export const goldPerSecond = (
  tiles: number,
  cities: number,
  ticksPerSecond: number,
): number => (tiles * GOLD_PER_TILE_PER_TICK + cities * CITY_GOLD_PER_TICK) * ticksPerSecond;
