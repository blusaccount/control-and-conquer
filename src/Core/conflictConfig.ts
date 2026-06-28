/**
 * Conflict-simulation tuning constants.
 *
 * These belong to the Core simulation (consumed by MapState) and intentionally
 * do NOT depend on server scheduling. Server-side tick scheduling lives in
 * `src/Server/simulationConfig.ts`.
 */

// Each side loses floor(opponentTroops * ATTRITION_RATE) troops per tick, minimum 1.
export const ATTRITION_RATE = 0.08;

// How fast the front line advances or retreats per tick when one side has more troops.
export const CONFLICT_ADVANCE_RATE = 0.05;
export const CONFLICT_RETREAT_RATE = 0.05;

// Starting progress for a new conflict: troops have just crossed the border.
// Must be > 0 so a single retreat step does not immediately repel on the first tick.
export const CONFLICT_INITIAL_PROGRESS = 2 * CONFLICT_RETREAT_RATE;

/**
 * Per-territory troop growth applied each tick to non-contested territories.
 * 0.05 at 20 TPS == 1 troop / tile / second. Fractional accumulation is held
 * inside MapState so the public `troops` value stays integer.
 */
export const INCOME_PER_TICK = 0.05;

/** Hard cap on a single territory's garrison. */
export const MAX_TROOPS_PER_TERRITORY = 999;
