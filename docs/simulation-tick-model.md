# Simulation Tick Model

## Tick Lifecycle

The server simulation runs at a fixed tick rate configured in `src/Server/simulationConfig.ts` (`SIMULATION_TICK_RATE`).

For each tick, the lifecycle is:

1. Drain the queued client inputs accumulated since the previous tick.
2. Apply queued commands in deterministic FIFO sequence order.
3. Advance simulation systems (`MapState.tick()`).
4. Publish a full state snapshot to subscribers/clients.

WebSocket messages do not mutate game state immediately. They are only enqueued and applied at tick boundaries.

## System Order per Tick

Current server tick order is defined in `GameSession.tick()`:

1. `processQueuedCommands()` (player actions like purchase/move/placeMine)
2. `mapState.tick()` (global game systems, currently province income + tick counter)
3. `broadcast()` (state snapshot transfer)

This stable ordering is critical for reproducible outcomes.

## Drift and Overload Protection

The loop uses a fixed-step scheduler (no variable-delta simulation):

- Tick interval is derived from `SIMULATION_TICK_RATE`.
- Slow ticks are measured and logged (`TICK_DURATION_WARN_MS`).
- Scheduler drift behind wall-clock is logged (`DRIFT_WARN_MS`).
- Catch-up execution is capped (`MAX_CATCH_UP_TICKS`) to avoid runaway loops under heavy load.
- If overload persists beyond catch-up cap, the scheduler resynchronizes and logs a warning.

## Determinism Risks

Determinism can still be compromised by:

- Introducing real-time based rules (`Date.now()`, random values, non-seeded RNG) inside simulation logic.
- Changing command processing order away from stable FIFO.
- Adding systems that iterate over unordered collections without explicit ordering.
- Divergent floating-point behavior if future logic depends on non-normalized precision-sensitive operations.
- Multi-threaded/shared-state mutations outside the single tick pipeline.

To preserve determinism, keep all authoritative game mutations inside tick processing and maintain a consistent system execution order.
