/**
 * Tuning constants for the raster (pixel) conflict engine.
 *
 * Like `conflictConfig.ts` for the polygon engine, these are Core simulation
 * constants and intentionally carry no dependency on server scheduling. They
 * describe *our* organic border-expansion combat model:
 *
 *   - Players hold a single troop **pool**; owning more tiles generates more
 *     income each tick.
 *   - Attacks spend committed troops to capture capturable tiles along the
 *     attacker's border, one BFS "ring" at a time, so fronts grow organically.
 *   - Capturing higher ground or enemy-held tiles costs more troops than
 *     claiming flat neutral land.
 */

import { CITY_MAX_TROOP_INCREASE } from "./buildings.js";

// ---------------------------------------------------------------------------
// Population / troops (OpenFront's max-population + bell-curve growth model).
//
// A single troop **pool** per player (OpenFront has no worker/troop split). Its
// ceiling rises sub-linearly with territory and flatly with cities; growth is a
// bell curve that peaks partway to the ceiling and tapers to zero at it. All
// constants and formula shapes mirror OpenFront's `maxTroops`/`troopIncreaseRate`
// (documented behaviour, not ported code).
// ---------------------------------------------------------------------------

/** Flat floor term inside the max-population formula (OpenFront's 50 000). */
export const MAX_POP_FLAT = 50_000;
/** Per-tile scale inside the max-population formula (OpenFront's 1000). */
export const MAX_POP_LAND_SCALE = 1_000;
/** Sub-linear land exponent in the max-population formula (OpenFront's 0.6). */
export const MAX_POP_LAND_EXPONENT = 0.6;

/**
 * Maximum troop pool for an empire of `tiles` tiles holding `cities` cities,
 * mirroring OpenFront's `maxTroops`: a sub-linear land term (so each extra tile
 * lifts the ceiling by ever less) plus a flat floor, doubled, plus a flat
 * per-city increase. Cities are the deliberate way to raise the cap —
 * {@link CITY_MAX_TROOP_INCREASE} each — not a per-tick troop dividend.
 */
export const maxTroops = (tiles: number, cities = 0): number =>
  2 * (Math.pow(Math.max(0, tiles), MAX_POP_LAND_EXPONENT) * MAX_POP_LAND_SCALE + MAX_POP_FLAT) +
  Math.max(0, cities) * CITY_MAX_TROOP_INCREASE;

/**
 * Troops added to a pool in a single tick, mirroring OpenFront's bell-curve
 * growth: a base that itself rises sub-linearly with the current pool, scaled by
 * how far the pool sits below its ceiling `max`. Growth is therefore slow when
 * the pool is tiny, peaks in the mid-range, and tapers to 0 at the cap. Never
 * negative; the caller clamps the running pool to `max`.
 */
export const troopGrowth = (troops: number, max: number): number => {
  if (max <= 0) return 0;
  const t = Math.max(0, troops);
  const base = 10 + Math.pow(t, 0.73) / 4;
  return Math.max(0, base * (1 - t / max));
};

/**
 * Troops generated per second by a player — the figure the leaderboard shows as
 * "(+N/s)". Derived directly from the real per-tick {@link troopGrowth} at the
 * empire's current pool and territory-scaled ceiling, so the displayed rate
 * matches the growth a player actually sees: it tapers toward 0 as the empire
 * fills up. `incomeMultiplier` folds in any per-player income modifier; `cities`
 * lifts the ceiling; `ticksPerSecond` converts the per-tick add to seconds.
 */
export const troopsPerSecond = (
  tiles: number,
  troops: number,
  ticksPerSecond: number,
  incomeMultiplier = 1,
  cities = 0,
  troopCapMultiplier = 1,
): number =>
  troopGrowth(troops, maxTroops(tiles, cities) * troopCapMultiplier) * incomeMultiplier * ticksPerSecond;

/**
 * Maximum wall-clock length of a single roguelite run, in seconds. When the
 * clock runs out the territory leader is declared the winner. Kept in seconds
 * (a pure gameplay rule) so it stays independent of the server tick rate, which
 * the session multiplies in to derive a tick budget.
 */
export const RASTER_MATCH_DURATION_SECONDS = 600;

/**
 * Seconds of **spawn immunity** a freshly-seated nation gets, mirroring
 * OpenFront's post-spawn protection: for this window the player's tiles can't be
 * attacked (by land or sea), so a new spawn isn't instantly steamrolled by a
 * neighbouring snowball before it can establish a border. Kept in seconds (a pure
 * gameplay rule, independent of tick rate); the engine is granted the equivalent
 * tick count when a player is seated.
 */
export const SPAWN_IMMUNITY_SECONDS = 8;

/**
 * Fraction of leftover committed troops lost when an attack against a *player*
 * ends without overrunning them — the front gets blocked, the target slips out
 * of reach, or an amphibious landing is repelled. Mirrors OpenFront's
 * `malusForRetreat`: pulling back from an enemy costs you, so a committed
 * assault is a real gamble. Retreating from neutral land (TerraNullius) is free,
 * so this never applies to neutral targets.
 */
export const RETREAT_MALUS_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Combat model
//
// An independent, clean-room reimplementation of the openfront-style combat
// mechanics, written from the publicly documented behaviour (the OpenFront wiki
// and gameplay guides) — NOT ported from OpenFront's source, which is AGPL-3.0.
// No OpenFront code or assets are used here; only the (uncopyrightable) game
// rules and formula shapes are reproduced, with our own constants. This keeps
// the project freely (re)licensable.
//
// Per captured tile the attacker spends `captureCost` troops; the defender (if a
// player) bleeds `defenderLossPerTile` troops. Both mirror OpenFront's
// attacker/defender troop-loss split:
//
//   attackerLoss = base · terrainFactor · ATTACKER_EFFICIENCY · garrisonFactor · fortifications
//   defenderLoss = defenderTroops / defenderTiles            (density)
//
// and the front's advance rate scales with the attacker's troop advantage.
// ---------------------------------------------------------------------------

/** Base troop cost to claim a flat neutral (wilderness) tile, before factors. */
export const NEUTRAL_CAPTURE_COST = 1;

/**
 * Flat attacker efficiency (OpenFront's ~20% attacker bonus): the attacker loses
 * 0.8× the nominal per-tile magnitude, so committing to an assault is a touch
 * cheaper than the raw terrain/garrison maths imply.
 */
export const ATTACKER_EFFICIENCY = 0.8;

/**
 * Terrain combat profile by elevation band, mirroring OpenFront's
 * plains/highland/mountain `mag`/`speed` pairs. `mag` is the per-tile troop-loss
 * magnitude (higher ground costs the attacker more); `speed` biases how fast the
 * front rolls through. Land elevation runs 0–30 (see `terrainCodec`), bucketed by
 * the two thresholds into three bands; magnitude 31 is impassable (never owned or
 * attacked), matching OpenFront's encoding.
 */
export const TERRAIN_PLAINS_MAX_ELEVATION = 9;
export const TERRAIN_HIGHLAND_MAX_ELEVATION = 19;
export interface TerrainCombat {
  /** Per-tile troop-loss magnitude. */
  readonly mag: number;
  /** Advance-rate bias (higher = the front moves through faster). */
  readonly speed: number;
}
export const TERRAIN_COMBAT_PLAINS: TerrainCombat = { mag: 80, speed: 16.5 };
export const TERRAIN_COMBAT_HIGHLAND: TerrainCombat = { mag: 100, speed: 20 };
export const TERRAIN_COMBAT_MOUNTAIN: TerrainCombat = { mag: 120, speed: 25 };

/** Combat profile (mag/speed) for a tile's terrain, by its land elevation (0–30). */
export const terrainCombat = (elevation: number): TerrainCombat => {
  if (elevation <= TERRAIN_PLAINS_MAX_ELEVATION) return TERRAIN_COMBAT_PLAINS;
  if (elevation <= TERRAIN_HIGHLAND_MAX_ELEVATION) return TERRAIN_COMBAT_HIGHLAND;
  return TERRAIN_COMBAT_MOUNTAIN;
};

/** Divisor for the attacker's per-tile loss when claiming neutral land (mag/5). */
export const NEUTRAL_LOSS_DIVISOR = 5;
/** Weights blending the troop-ratio loss term with the defender-density term. */
export const ATTACK_RATIO_LOSS_WEIGHT = 0.6;
export const ATTACK_DENSITY_LOSS_WEIGHT = 0.4;
/** Multiplier on the density term of the attacker's per-tile loss (OpenFront's 1.3). */
export const ATTACK_DENSITY_FACTOR = 1.3;

/**
 * Garrison-strength clamp bounds for {@link defenderStrengthFactor}. The cost an
 * attacker pays per captured tile scales with the ratio of the *defender's*
 * troops to the attacking force, clamped to a band (OpenFront's clamped troop
 * ratio): a defender holding a large army relative to the assault makes every
 * tile dearer (up to {@link DEFENDER_STRENGTH_MAX}×), grinding an under-committed
 * poke to a halt; an overwhelming assault floors the factor at
 * {@link DEFENDER_STRENGTH_MIN}× and rolls through. This is what gives a
 * stockpiled troop pool real *defensive* value.
 *
 * The {@link DEFENDER_STRENGTH_MAX} cap is **deliberately** tighter than the
 * fort/defense-post ceiling ({@link DEFENSE_POST_STRENGTH}×): this axis scales
 * with a raw *troop advantage*, which the runaway leader has in abundance, so
 * capping it keeps a trailing player able to dislodge a stockpiled empire (an
 * uncapped troop-ratio defence would harden the snowball into an unbeatable
 * turtle). Forts are the *uncapped* defensive axis on purpose — they cost gold
 * and a tile, a deliberate investment rather than a side effect of hoarding.
 */
export const DEFENDER_STRENGTH_MIN = 0.6;
export const DEFENDER_STRENGTH_MAX = 2.0;

/**
 * Capture-cost multiplier from the defender's relative strength: the defender's
 * current troop pool divided by the attacking force, clamped to
 * [{@link DEFENDER_STRENGTH_MIN}, {@link DEFENDER_STRENGTH_MAX}]. At parity it is
 * ~1 (no change); a defender far stronger than the assault drives it toward the
 * max (each tile costs the attacker much more); an attacker far stronger drives
 * it toward the min. A spent-out attacking force (`attackerTroops <= 0`) yields
 * the max — there is nothing left to push with.
 */
export const defenderStrengthFactor = (defenderTroops: number, attackerTroops: number): number => {
  if (attackerTroops <= 0) return DEFENDER_STRENGTH_MAX;
  const ratio = Math.max(0, defenderTroops) / attackerTroops;
  return Math.min(DEFENDER_STRENGTH_MAX, Math.max(DEFENDER_STRENGTH_MIN, ratio));
};

/**
 * Troops the attacker loses to capture one *enemy* tile, mirroring OpenFront's
 * `attackLogic`: a blend of (a) the clamped defender/attacker troop ratio times
 * the terrain magnitude and the flat attacker bonus, and (b) the defender's troop
 * density spread over the magnitude. `mag` is the tile's magnitude *after* any
 * defensive multipliers (defense post, fortress wall). A weak, thinly-spread
 * defender is cheap to roll over; a dense, well-garrisoned one is dear — so a
 * stockpiled army has real defensive value and high ground costs more to take.
 */
export const attackerLossPerTile = (
  defenderTroops: number,
  defenderDensity: number,
  attackForce: number,
  mag: number,
): number => {
  const ratioTerm = defenderStrengthFactor(defenderTroops, attackForce) * mag * ATTACKER_EFFICIENCY;
  const densityTerm = ATTACK_DENSITY_FACTOR * defenderDensity * (mag / 100);
  return ATTACK_RATIO_LOSS_WEIGHT * ratioTerm + ATTACK_DENSITY_LOSS_WEIGHT * densityTerm;
};

/** Troops the attacker loses to claim one neutral tile of magnitude `mag` (mag/5). */
export const neutralLossPerTile = (mag: number): number => mag / NEUTRAL_LOSS_DIVISOR;

/**
 * Large-empire defence debuff, mirroring OpenFront's `defenseSig`: a sprawling
 * nation defends each of its tiles *worse*, so the attacker's per-tile loss is
 * scaled down toward {@link LARGE_DEFENDER_LOSS_FLOOR} as the defender's territory
 * grows past {@link LARGE_DEFENDER_MIDPOINT}. This is a deliberate anti-snowball
 * lever: a runaway empire becomes cheaper to chip away at, so it can't harden
 * into an unbeatable turtle. Returns 1 for a small empire (no effect), easing to
 * the floor for a huge one.
 */
export const LARGE_DEFENDER_MIDPOINT = 150_000;
export const LARGE_DEFENDER_DECAY = Math.LN2 / 50_000;
export const LARGE_DEFENDER_LOSS_FLOOR = 0.7;
const sigmoid = (value: number, decay: number, midpoint: number): number =>
  1 / (1 + Math.exp(-decay * (value - midpoint)));
export const largeDefenderLossFactor = (defenderTiles: number): number => {
  const defenseSig = 1 - sigmoid(Math.max(0, defenderTiles), LARGE_DEFENDER_DECAY, LARGE_DEFENDER_MIDPOINT);
  return LARGE_DEFENDER_LOSS_FLOOR + (1 - LARGE_DEFENDER_LOSS_FLOOR) * defenseSig;
};

/**
 * Tiles a front may capture in a single tick, mirroring OpenFront's
 * `attackTilesPerTick`. Against a player the budget scales with the attacker's
 * troop advantage (clamped into a band) and the contested border width; against
 * neutral land it is simply a multiple of the border. `border` is the number of
 * frontier tiles pressed this tick. So an overwhelming assault rolls fast while
 * an under-committed poke barely creeps.
 */
export const ENEMY_TILES_PER_TICK_MIN = 0.01;
export const ENEMY_TILES_PER_TICK_MAX = 0.5;
export const ENEMY_TILES_BORDER_MULT = 3;
export const NEUTRAL_TILES_BORDER_MULT = 2;
export const attackTilesPerTick = (
  defenderTroops: number,
  attackForce: number,
  border: number,
  vsPlayer: boolean,
): number => {
  if (!vsPlayer) return border * NEUTRAL_TILES_BORDER_MULT;
  const advantage = ((5 * attackForce) / Math.max(1, defenderTroops)) * 2;
  const clamped = Math.min(ENEMY_TILES_PER_TICK_MAX, Math.max(ENEMY_TILES_PER_TICK_MIN, advantage));
  return clamped * border * ENEMY_TILES_BORDER_MULT;
};

/**
 * Defense-post aura. A defense post is a fortified location (e.g. a player's
 * capital) that makes capturing ground around it dearer, mirroring OpenFront's
 * defense posts that multiply attacker losses within a tile range. Capture cost
 * inside the aura is scaled up to {@link DEFENSE_POST_STRENGTH}× at the post
 * itself, falling off linearly to 1× at {@link DEFENSE_POST_RADIUS} tiles
 * (Chebyshev distance). Beyond the radius a post has no effect.
 */
export const DEFENSE_POST_RADIUS = 6;
export const DEFENSE_POST_STRENGTH = 3;

/**
 * Floor on the troops a defender loses from their pool for each tile captured
 * from them. The actual bleed is *density-based* (see {@link defenderLossPerTile}):
 * a defender loses troops proportional to how thinly its pool is spread over its
 * territory, mirroring OpenFront's `defender.troops() / defender.numTilesOwned()`.
 * This floor guarantees a captured tile always costs the defender at least this
 * much, so a troop-starved blob still bleeds as it is dismantled.
 */
export const DEFENDER_LOSS_PER_TILE = 1;

/**
 * Density-based troops a defender loses when one of its tiles is captured: its
 * current pool spread over the tiles it holds, floored at {@link DEFENDER_LOSS_PER_TILE}.
 * A dense defender (many troops, little land) bleeds hard per tile lost; a vast,
 * thinly-garrisoned empire barely notices each tile — the OpenFront feel where
 * over-extension is punished. `troops`/`tiles` are the defender's *current* pool
 * and tile count, so the bleed naturally eases as the empire shrinks.
 */
export const defenderLossPerTile = (troops: number, tiles: number): number => {
  if (tiles <= 0) return DEFENDER_LOSS_PER_TILE;
  return Math.max(DEFENDER_LOSS_PER_TILE, troops / tiles);
};

/**
 * Frontier ordering weights. A land attack captures the tiles of its frontier
 * in *priority* order rather than raw tile order, so fronts grow organically —
 * filling pockets and eating the easy ground first the way OpenFront's conquest
 * queue does. Each frontier tile gets a priority (lower = captured sooner):
 *
 *   priority = max(FRONTIER_PRIORITY_FLOOR,
 *                  1 + magnitude * FRONTIER_MAGNITUDE_WEIGHT
 *                    - ownedNeighbours * FRONTIER_SURROUND_WEIGHT) * jitter
 *
 * The **surround** term must dominate so a front spreads as an even, radial ring
 * rather than a thin tendril. A frontier tile has 1–4 owned neighbours, so the
 * surround term spans at most ~2.4; land elevation (`magnitude`) spans 1–30, so
 * if its weight were comparable the front would simply chase the lowest ground
 * across the whole map — snaking single-file along a coast or valley instead of
 * bulging outward, and extending that thread rather than back-filling the
 * concavities behind it. `FRONTIER_MAGNITUDE_WEIGHT` is therefore kept small: a
 * tile hugged by more of the attacker's own land (a pocket/bay) is always pulled
 * in before the perimeter pushes further out, so borders smooth into a blob;
 * elevation only gently biases *which* perimeter tile goes next (and high ground
 * already costs more troops to take — see {@link terrainLossMultiplier}).
 * `jitter` is a deterministic per-tile/-tick wobble (no RNG, so replays stay
 * stable) that scatters captures among otherwise-equal perimeter tiles, keeping
 * the ring from advancing lopsidedly along one edge.
 */
export const FRONTIER_MAGNITUDE_WEIGHT = 0.02;
export const FRONTIER_SURROUND_WEIGHT = 0.6;
export const FRONTIER_PRIORITY_FLOOR = 0.05;
export const FRONTIER_JITTER_SPAN = 0.15;

/**
 * Directional pull toward the tile a player actually clicked. When an attack
 * carries a `toward` target, each frontier tile's priority is nudged up by its
 * normalised distance (0 at the frontier tile nearest the click, 1 at the
 * farthest) times this weight, so the limited per-tick budget is spent on the
 * side of the front facing the click — the blob *bulges* toward where you
 * pointed instead of advancing evenly on all sides (OpenFront's directed
 * attack). Deliberately kept **below** {@link FRONTIER_SURROUND_WEIGHT}: one
 * extra owned neighbour (a pocket) lowers priority by 0.6, more than this term
 * can ever add, so back-filling concavities still dominates and the front stays
 * a smooth bulge rather than snaking a tendril straight at the target. `0`
 * disables the bias entirely (pure radial growth, the old behaviour).
 */
export const FRONTIER_TOWARD_WEIGHT = 0.5;

/**
 * Fraction of an attack's remaining committed troops that may be spent in a
 * single tick. Spreading the spend over multiple ticks is what makes the front
 * advance gradually (ring by ring) instead of teleporting across the map.
 *
 * Kept deliberately low so even a huge committed army advances as a thin,
 * smoothly-creeping front (the OpenFront feel) rather than swallowing a big
 * chunk of land in one tick. The {@link NEUTRAL_CAPTURE_COST} budget floor in
 * the engine still guarantees at least one tile of progress per tick, so a
 * small assault never stalls despite the low fraction.
 */
export const EXPANSION_SPEND_FRACTION = 0.12;

/**
 * Radius (in tiles, Chebyshev) within which a click that lands on un-ownable
 * terrain — open water or impassable rock — snaps to the nearest capturable
 * land tile before the attack is resolved. This is what lets a player target a
 * *territory* rather than pixel-hunt: a click just off a coastline (or on a
 * mountain pixel inside an enemy's land) resolves to the land they obviously
 * meant. Beyond this radius the click is treated as deliberate empty space and
 * rejected, so a tap in the open ocean still does nothing.
 */
export const CLICK_SNAP_RADIUS = 4;

/**
 * How far a *land* attack may reach from the player's territory, in tiles of
 * 4-connected land travel, before a click is treated as an amphibious (boat)
 * order instead.
 *
 * This is the land-vs-boat gate, and it mirrors OpenFront precisely. OpenFront
 * does not decide "boat or march" by whether the target sits on the *same
 * landmass* (on a real map an entire continent is one connected landmass, so
 * that test would march a front the long way around a bay forever). Instead it
 * asks a bounded question: starting from the clicked tile, can a short corridor
 * of contiguous land reach my territory? OpenFront caps that flood fill at a
 * Manhattan radius (≈200 tiles) — within it the target is "marchable" and a land
 * attack is launched; beyond it the sensible route is across the water, so a
 * transport ship is sent (see {@link TerritoryGrid.canReachByLand}).
 *
 * On the small procedural/ASCII test maps every tile is well within this radius,
 * so they behave exactly as a contiguous landmass; the bound only bites on the
 * large real-world maps, which is where a coast "across the bay" must become a
 * boat rather than a continent-spanning crawl.
 */
export const LAND_ATTACK_REACH = 200;

/**
 * Troops a transport ship must spend to establish its beachhead — the cost of
 * landing on and capturing the destination tile. Whatever the ship still
 * carries after paying this seeds a normal land attack from the landing tile.
 * Crossing water is meant to be possible but costlier than a contiguous push.
 */
export const SEA_CROSSING_SURCHARGE = 8;

/**
 * How many water tiles a bot's amphibious-target scan explores before stopping.
 * A player can boat anywhere within a connected body of water (no distance cap),
 * but a bot autonomously *discovering* targets must bound its search, so it only
 * considers landings reachable within roughly this many tiles of open water of
 * its coast — generous (whole nearby seas and islands), not the entire globe.
 * Only limits bot target discovery; an ordered boat still sails unbounded.
 */
export const SEA_TARGET_SCAN_BUDGET = 3000;

/**
 * How many transport ships a single player may have at sea simultaneously.
 * Mirrors OpenFront's cap of three boats in flight — water assaults are
 * deliberately rationed, so a player commits to a few landings rather than
 * swarming a coast with an unbounded fleet. One ship is launched per click.
 */
export const MAX_TRANSPORT_SHIPS_PER_PLAYER = 3;

/**
 * Tiles a transport ship advances along its water path each tick. The ship
 * crosses visibly over several ticks (at 20 TPS) rather than teleporting, so the
 * shortest route it takes is legible and interceptable in feel.
 */
export const SHIP_TILES_PER_TICK = 1;
