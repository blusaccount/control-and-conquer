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
export type BuildingType = "city" | "port" | "fort" | "factory" | "warship" | "silo" | "sam";

/** All building types, in menu order. */
export const BUILDING_TYPES: readonly BuildingType[] = ["city", "port", "fort", "factory", "warship", "silo", "sam"];

/** Building types that must sit on a coastal (shore) tile. */
export const COASTAL_BUILDING_TYPES: readonly BuildingType[] = ["port", "warship"];

/**
 * A Warship is built like any other structure (cost/coastal/construction as
 * usual, see {@link BUILDING_DEFS.warship}), but once construction finishes it
 * launches as a **mobile unit** — this is OpenFront's own model (Warship is a
 * `UnitType`, not a static defense post). Losing the home tile (captured or
 * the unit destroyed) tears down the structure too — one warship in, one
 * warship out.
 *
 * Values are OpenFront's publicly documented warship figures (maxHealth,
 * patrol/target range, shellRate, shell damage, passiveHeal, retreat
 * threshold). Two figures aren't in our source material and are this
 * project's own clean-room approximations, called out below.
 */
export const WARSHIP_MAX_HP = 1000;

/** Tiles (Chebyshev) a warship roams from its home port while it has no target. */
export const WARSHIP_PATROL_RANGE = 100;

/** Tiles (Chebyshev) a warship searches for a hostile target to engage. */
export const WARSHIP_TARGET_RANGE = 130;

/** Ticks between a warship's shots at its current target ("shellRate"). */
export const WARSHIP_SHELL_RATE_TICKS = 20;

/** Damage one shell deals — enough to sink an unarmoured ship in one hit, or take four hits off another warship. */
export const WARSHIP_SHELL_DAMAGE = 250;

/** HP a warship regenerates every tick, whether docked or at sea. */
export const WARSHIP_PASSIVE_HEAL_PER_TICK = 1;

/** HP threshold below which a warship breaks off and heads home instead of pressing an attack. */
export const WARSHIP_RETREAT_HP = 750;

/**
 * HP a retreating warship must heal back up to before it re-engages — our own
 * hysteresis band (not sourced) so a ship sitting exactly at the retreat
 * threshold doesn't flicker between fighting and fleeing tick to tick.
 */
export const WARSHIP_RETREAT_RECOVER_HP = 900;

/**
 * Tiles (Chebyshev) a warship must close to before it opens fire. Not a
 * sourced figure — `targetRange`(130) reads as a search/pursuit radius, not a
 * weapon range, so this project uses its own closer approximation (matching
 * the coast-defence radius this replaces).
 */
export const WARSHIP_ENGAGE_RANGE = 12;

/** Tiles a warship advances per tick while moving — not a sourced figure; matches every other ship's cruising speed. */
export const WARSHIP_TILES_PER_TICK = 1;

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

/**
 * The types a player can **upgrade** by building on their own existing
 * structure of the same type (OpenFront's v24 structure upgrades). Each level
 * costs the next step of the ramp and re-applies the effect: a level-2 city
 * lifts the population cap twice, a level-2 port/factory dispatches trade
 * ships/trains at twice the cadence. Deliberately v1-restricted to the three
 * economy structures — fort/silo/SAM/warship level effects aren't publicly
 * documented for OpenFront, so we don't guess at them.
 */
export const UPGRADABLE_BUILDING_TYPES: readonly BuildingType[] = ["city", "port", "factory"];

/** Static description of one building type for menus and cost maths. */
export interface BuildingDef {
  readonly type: BuildingType;
  /** Human-readable label for the build menu. */
  readonly name: string;
  /** A short blurb describing the structure's effect. */
  readonly description: string;
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
 * `defensePostRange` 30): every tile within the radius costs an attacker the
 * full `strength`× (binary in-range, no falloff).
 */
export const FORT_DEFENSE_STRENGTH = 5;
export const FORT_DEFENSE_RADIUS = 30;

/**
 * How much more advance budget a captured tile drains while covered by the
 * defender's fort aura — OpenFront's `defensePostSpeedBonus` (3): a defense post
 * doesn't just make each tile 5× dearer, it slows the front to a third of its
 * pace through the covered ground.
 */
export const FORT_SPEED_BONUS = 3;

/**
 * Minimum Euclidean distance (tiles) required between two of a player's
 * structures, mirroring OpenFront's `structureMinDist` (15). Keeps a player from
 * stacking buildings on adjacent tiles; placement snaps/validates against it.
 */
export const STRUCTURE_MIN_DIST = 15;

/**
 * How far (Chebyshev tiles) a coastal structure (port, warship) snaps to find a
 * shore tile, mirroring OpenFront's `radiusPortSpawn` (20). A coastline is only
 * one tile wide, so demanding a pixel-perfect click on it makes ports almost
 * impossible to place; instead the click resolves to the nearest **owned**
 * shore tile within this radius — clicking your coast "near enough" just works.
 */
export const COASTAL_SNAP_RADIUS = 20;

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
  silo: 100,
  sam: 300,
};

// --- Railroads + trains ----------------------------------------------------
//
// OpenFront ties a rail economy to a **Factory**: place a factory near a city
// or port and railroads auto-spawn linking them; trains then run the network
// and pay out gold at each city/port they reach (see the Railroad/Train/Factory
// wiki). We mirror that here — a factory is the catalyst that wires a player's
// stations (factory/city/port) into a mesh, and only city/port stops earn gold.
// Rails are routed automatically (the player never draws them), cardinal-only,
// over land, with OpenFront's exact station ranges and A* routing (cardinal,
// direction-change + water penalties). Everything is deterministic: spawn cadence
// is a fixed tick interval, never `Math.random`, so replays stay identical.

/** Station building types that a railroad can link together. */
export const RAIL_STATION_TYPES: readonly BuildingType[] = ["factory", "city", "port"];

/** Station types a train pays gold at when it arrives (factories don't earn). */
export const RAIL_PAYOUT_TYPES: readonly BuildingType[] = ["city", "port"];

/**
 * Shortest straight-line distance (tiles) between two stations a railroad links,
 * OpenFront's `trainStationMinRange` (15). Stations closer than this aren't wired
 * directly (they already sit within {@link STRUCTURE_MIN_DIST} of each other).
 */
export const RAIL_STATION_MIN_RANGE = 15;

/**
 * Greatest straight-line distance (tiles) between two linked stations, OpenFront's
 * `trainStationMaxRange` (110). A city/port only becomes a rail station at all
 * when a factory sits within this range of it (the factory is the catalyst).
 */
export const RAIL_STATION_MAX_RANGE = 110;

/**
 * Longest a single railroad's routed track may run, OpenFront's `railroadMaxSize`
 * = `trainStationMaxRange · √2 ≈ 155.56`. A route whose A* path exceeds this
 * (e.g. a long detour around water) is dropped, so no link is laid.
 */
export const RAIL_MAX_TRACK_LENGTH = RAIL_STATION_MAX_RANGE * Math.SQRT2;

/**
 * Extra A* cost for laying track onto a water or shoreline tile, OpenFront's
 * `waterPenalty` (5) — so a rail hugs dry inland ground and only bridges water on
 * the shortest shore-to-shore hop when it must.
 */
export const RAIL_WATER_PENALTY = 5;

/**
 * Extra A* cost each time the track changes cardinal direction, OpenFront's
 * `directionChangePenalty` (3) — so routes prefer long straight runs and bend
 * only when they have to, giving the clean rail look.
 */
export const RAIL_DIRECTION_CHANGE_PENALTY = 3;

/** A* heuristic weight (Manhattan × this), OpenFront's `heuristicWeight` (2). */
export const RAIL_HEURISTIC_WEIGHT = 2;

/**
 * Base gold a train pays when it reaches a city/port on its **own** owner's
 * network — OpenFront's `trainGold` "self" tier (10 000). (OpenFront also pays a
 * higher tier when a train stops at another player's or an ally's station —
 * 25 000 / 35 000 — but our rail network only ever links one owner's own
 * stations, so the self tier is the only reachable one.)
 */
export const TRAIN_GOLD_SELF_BASE = 10_000;
/** Stops a train makes at full pay before the distance penalty starts (OpenFront's `-9`). */
export const TRAIN_GOLD_FREE_STOPS = 9;
/** Gold the payout drops per city/port stop beyond {@link TRAIN_GOLD_FREE_STOPS}. */
export const TRAIN_GOLD_STOP_DECAY = 5_000;
/** Floor the per-stop train payout never drops below (OpenFront's `max(5000, …)`). */
export const TRAIN_GOLD_FLOOR = 5_000;

/**
 * Gold a train pays its owner at a city/port stop, mirroring OpenFront's
 * `trainGold`: the self-tier base, minus 5 000 for every stop this train has made
 * beyond the first ~10, floored at 5 000. `stopsVisited` is how many paying stops
 * the train has already banked, so its payout decays the longer it runs.
 */
export const trainGold = (stopsVisited: number): number => {
  const beyondFree = Math.max(0, Math.max(0, stopsVisited) - TRAIN_GOLD_FREE_STOPS);
  return Math.max(TRAIN_GOLD_FLOOR, TRAIN_GOLD_SELF_BASE - beyondFree * TRAIN_GOLD_STOP_DECAY);
};

/** Tiles of track a train advances per tick (OpenFront's train `speed: 2`). */
export const TRAIN_TILES_PER_TICK = 2;

/**
 * OpenFront's `trainSpawnRate`: the mean number of per-tick spawn *attempts* a
 * factory makes between launching trains, `(numFactories + 10) · 15`. More
 * factories means each launches *less* often (the network shares the spawn
 * budget). In OpenFront a factory rolls `chance(rate)` each tick; here — with no
 * RNG — the rail system fires deterministically once a factory's attempt counter
 * reaches this rate, reproducing the same expected cadence.
 */
export const TRAIN_SPAWN_BASE = 10;
export const TRAIN_SPAWN_RATE_SCALE = 15;
export const trainSpawnRate = (numFactories: number): number =>
  (Math.max(0, numFactories) + TRAIN_SPAWN_BASE) * TRAIN_SPAWN_RATE_SCALE;

/** Fewest ticks between two trains from one factory (OpenFront's spawn cooldown). */
export const TRAIN_SPAWN_MIN_COOLDOWN_TICKS = 10;

/** Stations a train visits before it retires (despawns) and frees its slot. */
export const TRAIN_MAX_VISITS = 8;

/** Hard ceiling on simultaneously live trains per player. */
export const TRAIN_MAX_PER_PLAYER = 8;

// --- Trade ships -----------------------------------------------------------
//
// OpenFront's dominant gold engine: ports auto-dispatch trade ships to other
// ports across a shared body of water, and on arrival BOTH the source and
// destination port owners are paid the FULL amount. The payout follows a sigmoid
// in the distance actually travelled (short hops penalised, long hauls approach a
// ceiling), and the dispatch cadence follows OpenFront's `tradeShipSpawnRate`
// (see below). Everything here is deterministic (no `Math.random`) so it stays
// replay stable, but the value/rate constants are OpenFront's exact ones.

/** Tiles a trade ship advances per tick along its (straight) sea lane. */
export const TRADE_SHIP_TILES_PER_TICK = 1;

/**
 * Ticks between a port's trade-ship spawn *attempts*, mirroring OpenFront (its
 * ports run a spawn check every 10 ticks, per port level). Each attempt either
 * dispatches a ship or bumps the port's rejection counter (see
 * {@link tradeShipSpawnRate}).
 */
export const TRADE_SPAWN_ATTEMPT_INTERVAL_TICKS = 10;

/** Numerator of OpenFront's `tradeShipSpawnRate` (the `100 · 1/(rejections+1)` term). */
export const TRADE_SPAWN_BASE = 100;
/** Sigmoid decay for the trade-fleet soft cap (OpenFront's `Math.LN2 / 50`). */
export const TRADE_SHIP_SOFTCAP_DECAY = Math.LN2 / 50;
/** Sigmoid midpoint (global trade-ship count) of OpenFront's fleet soft cap. */
export const TRADE_SHIP_SOFTCAP_MIDPOINT = 400;

/**
 * OpenFront's `tradeShipSpawnRate`: the mean number of spawn *attempts* a port
 * makes between dispatches, given its own `rejections` count and the *global*
 * number of trade ships already at sea. In OpenFront a port rolls `chance(rate)`
 * (a 1/rate probability) each attempt; here — with no RNG — the trade system
 * fires deterministically once a port's rejection counter reaches this rate, which
 * reproduces the same expected cadence. Two levers, exactly OpenFront's:
 *
 *  - `1/(rejections+1)` — the longer a port has gone without dispatching, the
 *    lower the rate, so a port that keeps failing (e.g. briefly no partner) fires
 *    sooner once it can. Reset to 0 on a successful dispatch.
 *  - `1/(1 − sigmoid(numTradeShips, ln2/50, 400))` — a **soft cap**: as the total
 *    ships at sea approaches ~400 the denominator collapses and the rate diverges,
 *    throttling new spawns. There is no hard fleet cap (OpenFront has none).
 */
export const tradeShipSpawnRate = (rejections: number, numTradeShips: number): number => {
  const rejectionModifier = 1 / (Math.max(0, rejections) + 1);
  const sig = 1 / (1 + Math.exp(-TRADE_SHIP_SOFTCAP_DECAY * (Math.max(0, numTradeShips) - TRADE_SHIP_SOFTCAP_MIDPOINT)));
  const baseSpawnRate = 1 - sig;
  return Math.floor((TRADE_SPAWN_BASE * rejectionModifier) / baseSpawnRate);
};

/**
 * Distance (tiles) below which trade is heavily penalised by the payout sigmoid,
 * mirroring OpenFront's `tradeShipShortRangeDebuff` (300). Long hauls pay far
 * more than short hops, so spreading ports out is rewarded.
 */
export const TRADE_SHIP_SHORT_RANGE_DEBUFF = 300;

/**
 * Gold paid to *each* of the two ports when a trade ship completes a trip of
 * `dist` tiles actually travelled, mirroring OpenFront's `tradeShipGold`:
 * `75 000 / (1 + e^(−0.03·(dist − 300))) + 50·dist`. The sigmoid punishes short
 * routes and approaches ~75 000 + 50·dist for long ones. Priced by the real
 * travelled distance, exactly as OpenFront — no map-size normalisation.
 */
export const tradeShipGold = (dist: number): number =>
  Math.floor(75_000 / (1 + Math.exp(-0.03 * (dist - TRADE_SHIP_SHORT_RANGE_DEBUFF))) + 50 * dist);

/** Static data for every building type, keyed by type id. */
export const BUILDING_DEFS: Readonly<Record<BuildingType, BuildingDef>> = {
  city: {
    type: "city",
    name: "City",
    description: "Raises max population and pays a gold dividend.",
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  port: {
    type: "port",
    name: "Port",
    description: "A coastal trade hub: steady gold income (must sit on a shore).",
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  fort: {
    type: "fort",
    name: "Fort",
    description: "Fortifies the surrounding tiles against capture.",
    baseCost: 50_000,
    costGrowth: 1,
    costCap: 250_000,
    costLinear: true,
  },
  factory: {
    type: "factory",
    name: "Factory",
    description: "Lays railroads to nearby cities and ports; trains earn gold.",
    baseCost: 125_000,
    costGrowth: 2,
    costCap: 1_000_000,
  },
  warship: {
    type: "warship",
    name: "Warship",
    description: "Guards the coast: sinks enemy transport ships in range (must sit on a shore).",
    baseCost: 250_000,
    costGrowth: 1,
    costCap: 1_000_000,
    costLinear: true,
  },
  silo: {
    type: "silo",
    name: "Missile Silo",
    description: "Launches an Atom Bomb, Hydrogen Bomb or MIRV at a target you choose. Reloads after each launch.",
    baseCost: 1_000_000,
    costGrowth: 1,
    costCap: 1_000_000,
  },
  sam: {
    type: "sam",
    name: "SAM Launcher",
    description: "Shoots down enemy missiles that fly within range. Reloads after each intercept attempt.",
    baseCost: 1_500_000,
    costGrowth: 1,
    costCap: 3_000_000,
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
