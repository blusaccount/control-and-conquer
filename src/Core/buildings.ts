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
export type BuildingType = "city" | "port" | "fort" | "factory";

/** All building types, in menu order. */
export const BUILDING_TYPES: readonly BuildingType[] = ["city", "port", "fort", "factory"];

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
 * Troops each city adds to a player's **maximum** population (OpenFront's
 * `cityTroopIncrease`). A city is a military engine by *raising the ceiling*, not
 * by paying a per-tick dividend: it lifts `maxTroops` so the empire's bell-curve
 * growth has more headroom to climb into. Sized to OpenFront's value so it stays
 * consistent with the territory term (`2·(tiles^0.6·1000 + 50 000)`).
 */
export const CITY_MAX_TROOP_INCREASE = 250_000;

/**
 * Extra gold per tick each port adds — a coastal trade dividend (OpenFront's
 * ports drive the maritime economy). Set a touch above a city's so claiming and
 * developing coastline is worthwhile now that transports cross water freely.
 */
export const PORT_GOLD_PER_TICK = 0.08;

/** A fort's defense-post aura — strength multiplier and radius (in tiles). */
export const FORT_DEFENSE_STRENGTH = 2;
export const FORT_DEFENSE_RADIUS = 4;

// --- Railroads + trains ----------------------------------------------------
//
// OpenFront ties a rail economy to a **Factory**: place a factory near a city
// or port and railroads auto-spawn linking them; trains then run the network
// and pay out gold at each city/port they reach (see the Railroad/Train/Factory
// wiki). We mirror that here — a factory is the catalyst that wires a player's
// stations (factory/city/port) into a mesh, and only city/port stops earn gold.
// Rails are routed automatically (the player never draws them), cardinal-only,
// over land, with the same distance/length/fan-out caps OpenFront uses (scaled
// to our smaller grids). Everything is deterministic: spawn cadence is a fixed
// tick interval, never `Math.random`, so replays stay identical.

/** Station building types that a railroad can link together. */
export const RAIL_STATION_TYPES: readonly BuildingType[] = ["factory", "city", "port"];

/** Station types a train pays gold at when it arrives (factories don't earn). */
export const RAIL_PAYOUT_TYPES: readonly BuildingType[] = ["city", "port"];

/**
 * Greatest straight-line distance (tiles) between two stations that may be wired
 * by a single railroad. OpenFront uses 80 on its larger maps; scaled down a
 * touch for our grids so a rail links a regional cluster, not the whole map.
 */
export const RAIL_CONNECT_DISTANCE = 55;

/**
 * Longest a single railroad connection may run (tiles of track). Cardinal-only
 * L-paths are longer than the straight-line distance, so this is a touch above
 * {@link RAIL_CONNECT_DISTANCE}; a candidate whose routed path exceeds it (e.g.
 * a long detour around water) is dropped.
 */
export const RAIL_MAX_LENGTH = 90;

/** Most railroads any one station may anchor — caps fan-out into a mesh. */
export const RAIL_MAX_CONNECTIONS = 4;

/** Gold a train pays its owner each time it reaches a city or port station. */
export const TRAIN_GOLD_PER_STATION = 10;

/** Tiles of track a train advances per tick. */
export const TRAIN_TILES_PER_TICK = 3;

/** A new train is considered for spawning every this-many ticks. */
export const TRAIN_SPAWN_INTERVAL_TICKS = 30;

/** Stations a train visits before it retires (despawns) and frees its slot. */
export const TRAIN_MAX_VISITS = 8;

/** Hard ceiling on simultaneously live trains per player. */
export const TRAIN_MAX_PER_PLAYER = 8;

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
    description: "A coastal trade hub: steady gold income.",
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
  factory: {
    type: "factory",
    name: "Factory",
    description: "Lays railroads to nearby cities and ports; trains earn gold.",
    icon: "\u{1F3ED}", // 🏭
    baseCost: 150,
    costGrowth: 1.6,
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
 * Gold generated per second by a player at the current territory, city and port
 * count — the figure the HUD/leaderboard shows as "(+N/s)". Derived from the
 * same per-tick income the engine applies so the displayed rate matches reality.
 */
export const goldPerSecond = (
  tiles: number,
  cities: number,
  ports: number,
  ticksPerSecond: number,
): number =>
  (tiles * GOLD_PER_TILE_PER_TICK + cities * CITY_GOLD_PER_TICK + ports * PORT_GOLD_PER_TICK) *
  ticksPerSecond;
