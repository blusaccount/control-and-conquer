# Simulation Tick Model

> Reflects the raster (OpenFront-style) engine on `main`. The earlier
> polygon/`MapState` engine described in older revisions of this file has been
> removed.

## Tick Lifecycle

The server simulation runs at a fixed tick rate configured in
`src/Server/simulationConfig.ts` (`SIMULATION_TICK_RATE`, currently 20 TPS).

The scheduler in `src/Server/index.ts` is a fixed-step, catch-up loop. On each
wake-up it advances as many whole ticks as wall-clock time has accrued (capped
by `MAX_CATCH_UP_TICKS`), calling `MatchRegistry.tickAll()` once per tick, which
drives every live `RasterGameSession.tick()`.

For each session tick (`RasterGameSession.tick`):

1. Drain the expand intents queued since the previous tick.
2. Validate each against the authoritative state; valid ones become
   `AttackIntent`s, invalid ones become `SERVER_RASTER_ACTION_REJECTED` events.
3. Advance the conflict engine one step (`RasterConflict.processTick`).
4. Broadcast a fresh `RasterSnapshot` to every subscriber.

WebSocket messages never mutate game state immediately. They are enqueued via
`queueExpand` and only applied at the next tick boundary.

## System Order inside `RasterConflict.processTick`

The engine resolves a tick in this fixed order (see `src/Core/RasterConflict.ts`):

1. If the match already has a winner, short-circuit (no further mutation).
2. Register validated intents (`launchAttack`): committed troops leave the
   attacker's pool immediately to prevent double-spend.
3. `applyIncome()` — each player gains troops proportional to tiles held,
   accumulated fractionally and flushed into the integer pool, capped at
   `MAX_POOL_PER_TILE × tiles`.
4. `advanceAttacks()` — each active attack spends a slice of its committed
   troops (`EXPANSION_SPEND_FRACTION`) to capture frontier tiles, one BFS ring
   per tick. Stalled attacks refund leftover troops.
5. `checkVictory()` — a player owning every capturable tile is the winner.

This stable ordering is critical for reproducible outcomes.

## Drift and Overload Protection

- Tick interval derives from `SIMULATION_TICK_RATE`.
- Slow ticks are measured and logged (`TICK_DURATION_WARN_MS`).
- Scheduler drift behind wall-clock is logged (`DRIFT_WARN_MS`).
- Catch-up execution is capped (`MAX_CATCH_UP_TICKS`) to avoid runaway loops.
- If overload persists beyond the cap, the scheduler resynchronizes and warns.

## Determinism

The only inputs to the engine are the player-supplied intents and the terrain,
which is generated once at construction from a fixed seed (or loaded from a
hand-authored map). There is no `Math.random` or `Date.now` in the simulation
path. Determinism can still be compromised by:

- Introducing real-time or unseeded-random rules inside simulation logic.
- Changing intent processing order away from stable FIFO.
- Iterating unordered collections without an explicit deterministic order
  (frontier scans sort by `TileRef`; player iteration sorts by id).

To preserve determinism, keep all authoritative mutations inside the tick
pipeline and maintain a consistent system execution order.
