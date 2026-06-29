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

/** Base troop cost to claim a flat (elevation 0) neutral tile. */
export const NEUTRAL_CAPTURE_COST = 1;

/** Extra base cost to capture a tile currently held by an enemy player. */
export const ENEMY_CAPTURE_SURCHARGE = 2;

/** Additional troop cost per unit of land elevation (higher ground is harder). */
export const ELEVATION_COST_PER_LEVEL = 0.1;

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
 * eating the easy, enclosed ground first the way OpenFront's conquest queue
 * does. Each frontier tile gets a priority (lower = captured sooner):
 *
 *   priority = max(FRONTIER_PRIORITY_FLOOR,
 *                  1 + magnitude * FRONTIER_MAGNITUDE_WEIGHT
 *                    - ownedNeighbours * FRONTIER_SURROUND_WEIGHT) * jitter
 *
 * High ground (`magnitude`) is pushed later; a tile hugged by many of the
 * attacker's own tiles (a pocket/bay) is pulled earlier so borders smooth out
 * instead of leaving ragged islands. `jitter` is a deterministic per-tile/-tick
 * wobble (no RNG, so replays stay stable) that only breaks ties between
 * otherwise-equal tiles — its span is kept small so terrain dominates order.
 */
export const FRONTIER_MAGNITUDE_WEIGHT = 0.5;
export const FRONTIER_SURROUND_WEIGHT = 0.6;
export const FRONTIER_PRIORITY_FLOOR = 0.05;
export const FRONTIER_JITTER_SPAN = 0.15;

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
