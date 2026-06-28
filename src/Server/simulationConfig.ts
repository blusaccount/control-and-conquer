export const SIMULATION_TICK_RATE = 20;
export const TICK_INTERVAL_MS = 1000 / SIMULATION_TICK_RATE;
export const MAX_CATCH_UP_TICKS = SIMULATION_TICK_RATE;
export const TICK_DURATION_WARN_MS = TICK_INTERVAL_MS * 1.1;
export const DRIFT_WARN_MS = TICK_INTERVAL_MS * 2;

// Conflict simulation tuning constants.
// Each side loses floor(opponentTroops * ATTRITION_RATE) troops per tick, minimum 1.
export const ATTRITION_RATE = 0.08;
// How fast the front line advances or retreats per tick when one side has more troops.
export const CONFLICT_ADVANCE_RATE = 0.05;
export const CONFLICT_RETREAT_RATE = 0.05;
// Starting progress for a new conflict: troops have just crossed the border (2 retreat steps from 0).
export const CONFLICT_INITIAL_PROGRESS = 2 * CONFLICT_ADVANCE_RATE;
