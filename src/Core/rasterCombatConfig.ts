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

import { CITY_TROOP_INCOME_PER_TICK } from "./buildings.js";

/**
 * Fractional troops generated per owned tile per tick. Accumulated per player
 * and flushed into the integer pool once it reaches >= 1, mirroring the
 * polygon engine's income model. 0.02 at 20 TPS ~= 0.4 troops/tile/second.
 */
export const INCOME_PER_TILE_PER_TICK = 0.02;

/** Troop pool ceiling, scaled by territory size, to keep numbers bounded. */
export const MAX_POOL_PER_TILE = 50;

/** Soft-cap troop pool maximum for an empire of `tiles` tiles. */
export const poolCap = (tiles: number): number => tiles * MAX_POOL_PER_TILE;

/**
 * Logistic growth factor in [0, 1] used as a **soft cap** on the troop pool:
 * full income when the pool is empty, tapering to zero as the pool approaches
 * its {@link poolCap}. Income is multiplied by this factor, so the pool
 * approaches the cap asymptotically instead of piling up at a flat rate — a
 * sprawling empire's army growth visibly slows and plateaus (OpenFront feel),
 * rather than every "+N/s" climbing without limit.
 */
export const growthFactor = (troops: number, tiles: number): number => {
  const cap = poolCap(tiles);
  if (cap <= 0) return 0;
  return Math.max(0, 1 - troops / cap);
};

/**
 * Troops generated per second by a player — the figure the leaderboard shows as
 * "(+N/s)". Derived directly from the engine's real per-tick income (including
 * the logistic {@link growthFactor} soft cap) so the displayed rate matches the
 * pool growth a player actually sees: it tapers toward 0 as the empire fills up.
 * `incomeMultiplier` folds in any income modifiers; `cities` adds each city's
 * flat troop dividend (gated by the same soft cap); `ticksPerSecond` converts
 * the per-tick income to seconds.
 */
export const troopsPerSecond = (
  tiles: number,
  troops: number,
  ticksPerSecond: number,
  incomeMultiplier = 1,
  cities = 0,
): number => {
  const perTick =
    (tiles * INCOME_PER_TILE_PER_TICK * incomeMultiplier + cities * CITY_TROOP_INCOME_PER_TICK) *
    growthFactor(troops, tiles);
  return perTick * ticksPerSecond;
};

/**
 * Maximum wall-clock length of a single roguelite run, in seconds. When the
 * clock runs out the territory leader is declared the winner. Kept in seconds
 * (a pure gameplay rule) so it stays independent of the server tick rate, which
 * the session multiplies in to derive a tick budget.
 */
export const RASTER_MATCH_DURATION_SECONDS = 600;

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
 * Base troop cost to capture a flat enemy-held tile at troop parity, before the
 * terrain, attacker-efficiency and garrison factors. Higher than neutral land:
 * an opposed border is dearer to push than empty wilderness.
 */
export const ENEMY_CAPTURE_BASE = 3;

/**
 * Flat attacker efficiency (OpenFront's ~20% attacker bonus): the attacker loses
 * this fraction of the nominal cost per tile, so committing to an assault is a
 * touch cheaper than the raw terrain/garrison maths imply. < 1 favours the
 * attacker; 1 would be neutral.
 */
export const ATTACKER_EFFICIENCY = 0.8;

/**
 * Terrain capture-cost multipliers by elevation band, mirroring OpenFront's
 * plains/highland/mountain split (plains are softer, mountains dearer). Land
 * elevation runs 0–30 (see `terrainCodec`); the two thresholds bucket it into
 * the three bands. The multiplier scales the *attacker's* per-tile loss, so high
 * ground is harder to take — but only mildly (a ~1.4× spread), as in OpenFront,
 * rather than the steep linear ramp the engine used before.
 */
export const TERRAIN_PLAINS_MAX_ELEVATION = 7;
export const TERRAIN_HIGHLAND_MAX_ELEVATION = 18;
export const TERRAIN_LOSS_PLAINS = 0.9;
export const TERRAIN_LOSS_HIGHLAND = 1.0;
export const TERRAIN_LOSS_MOUNTAIN = 1.3;

/** Capture-cost multiplier for a tile's terrain, by its land elevation (0–30). */
export const terrainLossMultiplier = (elevation: number): number => {
  if (elevation <= TERRAIN_PLAINS_MAX_ELEVATION) return TERRAIN_LOSS_PLAINS;
  if (elevation <= TERRAIN_HIGHLAND_MAX_ELEVATION) return TERRAIN_LOSS_HIGHLAND;
  return TERRAIN_LOSS_MOUNTAIN;
};

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
 * How much faster (or slower) a front advances given the garrison it faces —
 * OpenFront's "conquest speed scales with the attacker's advantage". The speed
 * is simply the reciprocal of the garrison factor: a weak defender (factor < 1)
 * is overrun faster, a strong one (factor > 1) slows the advance. Neutral land
 * has no garrison (factor 1), so it advances at the base rate.
 *
 * The bounds are **derived from** the garrison-factor band rather than picked
 * independently, so they stay consistent with it: the only input in play is
 * {@link defenderStrengthFactor}'s output, itself clamped to
 * [{@link DEFENDER_STRENGTH_MIN}, {@link DEFENDER_STRENGTH_MAX}], so the speed
 * can only ever range over [1/MAX, 1/MIN]. Hard-coding a wider ceiling (the old
 * `2.0`) was dead — the reciprocal of a clamped-in factor could never reach it —
 * and misleadingly implied a speed the engine can't produce. A degenerate
 * non-positive factor still floors to the ceiling.
 */
export const ATTACK_SPEED_MIN = 1 / DEFENDER_STRENGTH_MAX;
export const ATTACK_SPEED_MAX = 1 / DEFENDER_STRENGTH_MIN;
export const attackSpeedFactor = (garrisonFactor: number): number => {
  if (garrisonFactor <= 0) return ATTACK_SPEED_MAX;
  return Math.min(ATTACK_SPEED_MAX, Math.max(ATTACK_SPEED_MIN, 1 / garrisonFactor));
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
 * Maximum width of open water (in tiles) a transport ship can cross. A coastal
 * tile can reach an enemy/neutral coast on the far bank of a strait, lake or
 * channel no wider than this — the openfront-style "transport ship" mechanic.
 * It bounds two things that must agree: the precomputed {@link seaLinks}
 * reachability graph (which surfaces sea-reachable targets) and the per-launch
 * shortest-water-path search a ship actually follows. Set to 0 to disable all
 * water crossing (water becomes a hard barrier).
 */
export const MAX_SEA_CROSSING_TILES = 6;

/**
 * Troops a transport ship must spend to establish its beachhead — the cost of
 * landing on and capturing the destination tile. Whatever the ship still
 * carries after paying this seeds a normal land attack from the landing tile.
 * Crossing water is meant to be possible but costlier than a contiguous push.
 */
export const SEA_CROSSING_SURCHARGE = 8;

/**
 * Largest factor any perk/class can scale a player's sea-crossing range by. The
 * crossing graph is precomputed once at `MAX_SEA_CROSSING_TILES` times this, so
 * a Sea God player's extended reach is already in the graph and just gets
 * un-filtered; base players are filtered back down to {@link MAX_SEA_CROSSING_TILES}.
 */
export const MAX_SEA_RANGE_MULTIPLIER = 2;

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
