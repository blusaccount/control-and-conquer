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
