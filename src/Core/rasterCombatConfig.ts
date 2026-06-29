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

/** Troops the defender loses from their pool for each tile captured from them. */
export const DEFENDER_LOSS_PER_TILE = 1;

/**
 * Fraction of an attack's remaining committed troops that may be spent in a
 * single tick. Spreading the spend over multiple ticks is what makes the front
 * advance gradually (ring by ring) instead of teleporting across the map.
 */
export const EXPANSION_SPEND_FRACTION = 0.25;

/**
 * Maximum width of open water (in tiles) a coastal tile can project an
 * amphibious landing across. A player who owns a shoreline tile may expand onto
 * an enemy/neutral shoreline tile on the far bank of a strait, lake or channel
 * no wider than this — the openfront-style "boats" mechanic. Set to 0 to disable
 * all water crossing (back to Phase 2 behaviour where water is a hard barrier).
 */
export const MAX_SEA_CROSSING_TILES = 6;

/**
 * Extra troop cost added when a captured tile is reached by an amphibious
 * landing rather than a land border. Crossing water is meant to be possible but
 * deliberately more expensive than pushing a contiguous land front.
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
