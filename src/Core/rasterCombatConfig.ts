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

/**
 * Fractional troops generated per owned tile per tick. Accumulated per player
 * and flushed into the integer pool once it reaches >= 1, mirroring the
 * polygon engine's income model. 0.02 at 20 TPS ~= 0.4 troops/tile/second.
 */
export const INCOME_PER_TILE_PER_TICK = 0.02;

/** Troop pool ceiling, scaled by territory size, to keep numbers bounded. */
export const MAX_POOL_PER_TILE = 50;

/**
 * Troops generated per second by a player holding `tiles` tiles — the figure the
 * leaderboard shows as "(+N/s)". Derived directly from the engine's real per-tick
 * income so the displayed rate matches the pool growth a player actually sees.
 * `incomeMultiplier` folds in perk/class bonuses (e.g. Wachstumstreiber) so the
 * display tracks them; `ticksPerSecond` converts the per-tick income to seconds.
 */
export const troopsPerSecond = (
  tiles: number,
  ticksPerSecond: number,
  incomeMultiplier = 1,
): number => tiles * INCOME_PER_TILE_PER_TICK * ticksPerSecond * incomeMultiplier;

/**
 * Maximum wall-clock length of a single roguelite run, in seconds. When the
 * clock runs out the territory leader is declared the winner. Kept in seconds
 * (a pure gameplay rule) so it stays independent of the server tick rate, which
 * the session multiplies in to derive a tick budget.
 */
export const RASTER_MATCH_DURATION_SECONDS = 600;

/** Base troop cost to claim a flat (elevation 0) neutral tile. */
export const NEUTRAL_CAPTURE_COST = 1;

/** Extra base cost to capture a tile currently held by an enemy player. */
export const ENEMY_CAPTURE_SURCHARGE = 2;

/** Additional troop cost per unit of land elevation (higher ground is harder). */
export const ELEVATION_COST_PER_LEVEL = 0.1;

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
export const FRONTIER_SURROUND_WEIGHT = 0.25;
export const FRONTIER_PRIORITY_FLOOR = 0.05;
export const FRONTIER_JITTER_SPAN = 0.5;

/**
 * Fraction of an attack's remaining committed troops that may be spent in a
 * single tick. Spreading the spend over multiple ticks is what makes the front
 * advance gradually (ring by ring) instead of teleporting across the map.
 */
export const EXPANSION_SPEND_FRACTION = 0.25;

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

/** Seconds between perk-offer rounds in a roguelite run. */
export const PERK_OFFER_INTERVAL_SECONDS = 120;

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
