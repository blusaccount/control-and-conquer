/**
 * Server-side scheduling configuration. Pure runtime/loop concerns — does not
 * touch game-state semantics (those live in `src/Core/conflictConfig.ts`).
 */

export const SIMULATION_TICK_RATE = 10;
export const TICK_INTERVAL_MS = 1000 / SIMULATION_TICK_RATE;

/**
 * Length of the opening "start phase" in seconds. During this window every
 * player chooses where to found their nation; territory can only be taken once
 * it elapses and the game phase begins.
 */
export const SPAWN_PHASE_SECONDS = 15;
export const MAX_CATCH_UP_TICKS = SIMULATION_TICK_RATE;
export const TICK_DURATION_WARN_MS = TICK_INTERVAL_MS * 1.1;
export const DRIFT_WARN_MS = TICK_INTERVAL_MS * 2;
