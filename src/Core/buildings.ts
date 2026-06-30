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
export type BuildingType = "city" | "port" | "fort" | "factory" | "warship";

/** All building types, in menu order. */
export const BUILDING_TYPES: readonly BuildingType[] = ["city", "port", "fort", "factory", "warship"];

/** Building types that must sit on a coastal (shore) tile. */
export const COASTAL_BUILDING_TYPES: readonly BuildingType[] = ["port", "warship"];

/**
 * How far (Chebyshev tiles) a warship's guns reach: an enemy transport ship
 * passing within this range of a warship is sunk. A coast-defence rendition of
 * OpenFront's warship, which patrols and engages hostile shipping — here it holds
 * its harbour and interdicts amphibious assaults rather than roaming (mobile
 * patrol + trade-raiding is a documented follow-up).
 */
export const WARSHIP_INTERCEPT_RANGE = 12;

/** Runtime guard: is `value` a known building type id? */
export const isBuildingType = (value: unknown): value is BuildingType =>
  typeof value === "string" && (BUILDING_TYPES as readonly string[]).includes(value);

/**
 * Groups of building types that **share a cost counter**: each building in the
 * group raises the next cost of every type in the group, mirroring OpenFront,
 * where Ports and Factories share one counter (building a factory makes your next
 * port dearer and vice versa). Types not listed here count only themselves.
 */
export const SHARED_COST_GROUPS: readonly (readonly BuildingType[])[] = [["port", "factory"]];

/** The building types whose owned counts combine into `type`'s cost ramp (itself if it shares with none). */
export const costCounterTypes = (type: BuildingType): readonly BuildingType[] => {
  for (const group of SHARED_COST_GROUPS) if (group.includes(type)) return group;
  return [type];
};

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
   * a runaway empire from blanketing the map in free cities. Ignored when
   * {@link costLinear} is set.
   */
  readonly costGrowth: number;
  /**
   * Hard cap on the cost of one building, mirroring OpenFront's per-structure
   * ceilings (`min(1_000_000, …)` for cities/ports/factories, `min(250_000, …)`
   * for defense posts), so the geometric/linear ramp plateaus instead of running
   * away.
   */
  readonly costCap: number;
  /**
   * When set, the cost grows **linearly** — `baseCost * (owned + 1)` — instead of
   * geometrically, mirroring OpenFront's defense-post pricing `(n + 1) * 50_000`.
   */
  readonly costLinear?: boolean;
}

// --- Economy constants -----------------------------------------------------

/**
 * Flat gold every player earns each tick, **exactly like OpenFront**: its
 * `goldAdditionRate` pays a fixed amount per tick that does **not** depend on
 * territory, cities or ports. Passive gold is just this steady trickle; the
 * economy is grown through **trade ships** (port↔port) and **trains**, plus a
 * one-time **conquer bounty**. At 10 ticks/s this is 1000 gold/s for a nation —
 * a first City (125 000) is ~125 s away on passive income alone, as in OpenFront.
 *
 * (OpenFront pays bots only 50/tick; our AI opponents behave like OpenFront's
 * *nations*, which earn the full 100/tick, so a single flat base is faithful.)
 */
export const GOLD_BASE_PER_TICK = 100;

/** Every player starts a run with this much gold. */
export const STARTING_GOLD = 0;

/**
 * Troops each city adds to a player's **maximum** population (OpenFront's
 * `cityTroopIncrease`). In OpenFront a city pays **no gold** — it is purely a
 * military engine that *raises the ceiling*: it lifts `maxTroops` so the empire's
 * bell-curve growth has more headroom to climb into. Sized to OpenFront's value
 * so it stays consistent with the territory term (`2·(tiles^0.6·1000 + 50 000)`).
 */
export const CITY_MAX_TROOP_INCREASE = 250_000;

/**
 * Fraction of a fallen nation's gold the conqueror inherits — OpenFront's
 * `conquerGoldAmount`: the full pool from a beaten AI/bot, half from a human. A
 * one-time bounty paid when a player is eliminated (no per-tile capture bounty).
 */
export const CONQUER_GOLD_FRACTION_AI = 1;
export const CONQUER_GOLD_FRACTION_HUMAN = 0.5;

/**
 * A fort's defense-post aura — strength multiplier and radius (in tiles),
 * mirroring OpenFront's defense post (`defensePostDefenseBonus` 5,
 * `defensePostRange` 30). Capture cost peaks at `strength`× on the post and
 * tapers over the radius (a smoothed rendition of OpenFront's in-range bonus).
 */
export const FORT_DEFENSE_STRENGTH = 5;
export const FORT_DEFENSE_RADIUS = 30;

/**
 * Minimum Euclidean distance (tiles) required between two of a player's
 * structures, mirroring OpenFront's `structureMinDist` (15). Keeps a player from
 * stacking buildings on adjacent tiles; placement snaps/validates against it.
 */
export const STRUCTURE_MIN_DIST = 15;

/**
 * Ticks a structure spends **under construction** before its effects switch on,
 * mirroring OpenFront's `constructionDuration` (2/5/10·10-tick windows at 10
 * ticks/s). Until it finishes a building counts toward its cost ramp but pays no
 * city population cap, runs no station and raises no fort/warship effect.
 */
export const BUILDING_CONSTRUCTION_TICKS: Readonly<Record<BuildingType, number>> = {
  city: 20,
  factory: 20,
  port: 50,
  fort: 50,
  warship: 30,
};

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

/**
 * Gold a train pays its owner each time it reaches a city or port station,
 * scaled to OpenFront's train economy (its `trainGold` pays ~10 000+ per stop).
 */
export const TRAIN_GOLD_PER_STATION = 10_000;

/** Tiles of track a train advances per tick. */
export const TRAIN_TILES_PER_TICK = 3;

/** A new train is considered for spawning every this-many ticks. */
export const TRAIN_SPAWN_INTERVAL_TICKS = 30;

/** Stations a train visits before it retires (despawns) and frees its slot. */
export const TRAIN_MAX_VISITS = 8;

/** Hard ceiling on simultaneously live trains per player. */
export const TRAIN_MAX_PER_PLAYER = 8;

// --- Trade ships -----------------------------------------------------------
//
// OpenFront's dominant gold engine: ports auto-dispatch trade ships to other
// ports across a shared body of water, and on arrival BOTH the source and
// destination port owners are paid. The payout follows a sigmoid in the distance
// travelled (short hops are penalised, long hauls approach a ceiling), mirroring
// OpenFront's `tradeShipGold`. Everything here is deterministic — fixed spawn
// cadence, straight-line interpolation, no `Math.random` — so it stays replay
// stable like the rail economy.

/** A new trade ship is considered for dispatch every this-many ticks (per port). */
export const TRADE_SHIP_SPAWN_INTERVAL_TICKS = 40;

/** Tiles a trade ship advances per tick along its (straight) sea lane. */
export const TRADE_SHIP_TILES_PER_TICK = 1;

/** Most trade ships any one player may have at sea simultaneously. */
export const TRADE_MAX_PER_PLAYER = 6;

/**
 * Distance (tiles) below which trade is heavily penalised by the payout sigmoid,
 * mirroring OpenFront's `tradeShipShortRangeDebuff` (300). Long hauls pay far
 * more than short hops, so spreading ports out is rewarded.
 */
export const TRADE_SHIP_SHORT_RANGE_DEBUFF = 300;

/**
 * Gold paid to *each* of the two ports when a trade ship completes a trip of
 * `dist` tiles, mirroring OpenFront's `tradeShipGold`:
 * `75 000 / (1 + e^(−0.03·(dist − 300))) + 50·dist`. The sigmoid punishes short
 * routes and approaches ~75 000 + 50·dist for long ones.
 */
export const tradeShipGold = (dist: number): number =>
  Math.floor(75_000 / (1 + Math.exp(-0.03 * (dist - TRADE_SHIP_SHORT_RANGE_DEBUFF))) + 50 * dist);

/** Static data for every building type, keyed by type id. */
export const BUILDING_DEFS: Readonly<Record<BuildingType, BuildingDef>> = {
  city: {
    type: "city",
    name: "City",
    description: "Raises max population and pays a gold dividend.",
    icon: "\u{1F3DB}\u{FE0F}", // 🏛️
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  port: {
    type: "port",
    name: "Port",
    description: "A coastal trade hub: steady gold income (must sit on a shore).",
    icon: "\u{2693}", // ⚓
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  fort: {
    type: "fort",
    name: "Fort",
    description: "Fortifies the surrounding tiles against capture.",
    icon: "\u{1F6E1}\u{FE0F}", // 🛡️
    baseCost: 50_000,
    costGrowth: 1,
    costCap: 250_000,
    costLinear: true,
  },
  factory: {
    type: "factory",
    name: "Factory",
    description: "Lays railroads to nearby cities and ports; trains earn gold.",
    icon: "\u{1F3ED}", // 🏭
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  warship: {
    type: "warship",
    name: "Warship",
    description: "Guards the coast: sinks enemy transport ships in range (must sit on a shore).",
    icon: "\u{1F6A2}", // 🚢
    baseCost: 250_000,
    costGrowth: 1,
    costCap: 1_000_000,
    costLinear: true,
  },
};

/**
 * Gold cost for a player's next building of `type`, given how many of that type
 * they already own. Grows geometrically (`baseCost * growth^owned`) or linearly
 * (`baseCost * (owned + 1)`, see {@link BuildingDef.costLinear}), then clamps to
 * the type's {@link BuildingDef.costCap} — mirroring OpenFront's capped ramps.
 */
export const buildingCost = (type: BuildingType, owned: number): number => {
  const def = BUILDING_DEFS[type];
  const n = Math.max(0, owned);
  const raw = def.costLinear ? def.baseCost * (n + 1) : def.baseCost * Math.pow(def.costGrowth, n);
  return Math.min(def.costCap, Math.round(raw));
};

/**
 * Passive gold per second — the figure the HUD/leaderboard shows as "(+N/s)".
 * Like OpenFront this is just the flat per-tick base × the tick rate; it is
 * independent of territory, cities and ports. Trade ships, trains and conquest
 * top up the pool in bursts on top of this steady passive rate.
 */
export const goldPerSecond = (ticksPerSecond: number): number =>
  GOLD_BASE_PER_TICK * ticksPerSecond;
