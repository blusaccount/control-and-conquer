# Multiplayer Authority Architecture

> Reflects the raster (OpenFront-style) engine on `main`. Earlier revisions of
> this file described a polygon `MapState`/`BattleEngine` with purchase/move
> commands; that engine has been removed.

---

## Guiding Principle

**The server is the single source of truth for all game state.**
Clients never mutate game state locally; they render the most recent snapshot
received from the server and send intent-only commands.

---

## Components

| Component | File(s) | Responsibility |
|-----------|---------|----------------|
| **WebSocket server** | `src/Server/index.ts` | Accepts connections, serves static assets, parses messages, runs the tick loop |
| **Command validator** | `src/Server/validateCommand.ts` | Structural validation of raw incoming JSON before it reaches game logic |
| **MatchRegistry** | `src/Server/MatchRegistry.ts` | Drops each client into its own solo match vs a field of server-side bots (FFA, count via `RASTER_BOTS`); routes intents; ticks all sessions |
| **RasterGameSession** | `src/Server/RasterGameSession.ts` | Owns the authoritative `GameMap` + `TerritoryGrid` + `RasterConflict`; validates intents into the engine's business rules; broadcasts snapshots |
| **RasterConflict** | `src/Core/RasterConflict.ts` | Deterministic, self-contained territorial combat resolution |
| **RasterBotController** | `src/Server/RasterBotController.ts` | Strategy-driven AI opponent (personality presets): grabs neutral land, prioritises beatable rivals, uses amphibious crossings; queues expand intents through the same channel as a human |
| **Client** | `src/Client/rasterClient.ts` | Renders snapshots; emits click-to-expand intents over WebSocket |

---

## Event Flow

```
Client                              Server
  │                                   │
  │  ── WebSocket connect ──────────► │  MatchRegistry.joinRasterSolo
  │  ◄─ PLAYER_ASSIGNED ───────────── │  assign id/colour, spawn tile
  │  ◄─ SNAPSHOT (with terrain) ───── │  initial snapshot (terrain bytes once)
  │                                   │
  │  User clicks a tile               │
  │  ── CLIENT_RASTER_EXPAND ───────► │  validateCommand(raw)   [shape check]
  │     { targetX, targetY, percent } │  queueExpand            [buffered]
  │                                   │
  │            (server tick boundary) │  validate intent → AttackIntent
  │                                   │  RasterConflict.processTick
  │  ◄─ SNAPSHOT (owner delta) ─────  │  broadcast to subscribers
  │  ◄─ ACTION_REJECTED (if invalid)  │  sent only to the offending client
  │                                   │
  │  ◄─ MATCH_ENDED (on victory) ───  │  broadcast once
```

---

## Server Responsibilities

1. **Structural validation** (`validateCommand`): the raw JSON must have a known
   `type` discriminant and well-typed fields (integer tile coords ≥ 0, percent
   1..100). Violations produce a `SERVER_RASTER_ACTION_REJECTED` with reason
   `INVALID_MESSAGE_FORMAT`; no state change occurs.

2. **Business-rule validation** (`RasterGameSession.validateAndBuildIntent`):
   the tile must be in bounds and capturable, not already owned by the attacker,
   the attacker must have a frontier touching the target, and the committed
   slice of the pool must be affordable. Failures yield a typed reject reason.

3. **Authoritative state mutation**: only `RasterConflict` (via the session's
   tick) mutates ownership and troop pools. There is no path by which a client
   can influence state except through validated, queued intents.

4. **Broadcast**: after every tick the session sends a `RasterSnapshot` to each
   subscriber. The subscriber-independent body (player standings, buildings,
   fronts, diplomacy, …) is assembled **once per tick** (`buildSharedSnapshot`)
   and reused for every subscriber; only the per-client ownership view is
   attached afterwards (`attachOwnership`). Static terrain bytes are shipped only
   on the first snapshot per client (keyed by `terrainHash`); ownership is sent
   as the full raster once, then as compact per-tile deltas. Headless subscribers
   (server-side bots) take the shared body verbatim — no terrain, no ownership
   encoding, no per-subscriber allocation — since they read engine state directly.
   This keeps the per-tick cost from scaling with the number of subscribers, which
   is what a shared multiplayer session needs.

---

## Client Responsibilities

- Render the most recent `RasterSnapshot` (terrain + ownership raster, boats).
- Translate canvas clicks into `CLIENT_RASTER_EXPAND` intents.
- Display reject/victory messages from the server.
- Hold no authoritative state — local fields are purely presentational and are
  overwritten on every snapshot.

---

## Server-Refereed Lockstep (the scalable multiplayer wire mode)

Alongside the snapshot-streaming path above, the server supports a **lockstep
relay mode** (`Core/lockstep.ts`) designed for large lobbies, where streaming
owner-deltas to every client would dominate egress:

- A client joins with `lockstep: true`. The server seats it as usual but sends
  it no snapshots — only a one-time `SERVER_RASTER_LOCKSTEP_START` (map id,
  terrain hash, session options, the full seat list) and then one
  `SERVER_RASTER_TURN` per tick.
- Every command entering the session — human intents *and* server-side bot
  decisions — is recorded at the session's public entry points, before
  validation, and relayed in the next turn in exact application order.
- The client runs the identical deterministic sim in a Web Worker
  (`Client/lockstep/lockstepWorker.ts` + `replica.ts`): per received turn it
  applies the commands through the same session entry points, then ticks. The
  server's cadence paces the replica; the rendering client consumes the
  replica's locally generated message stream unchanged.
- **The server still simulates** — it is the referee, not a relay. Every
  `HASH_INTERVAL_TICKS` turns it embeds its state hash (portable FNV-1a over
  ownership, pools, structures, fallout, clock); a replica that disagrees
  surfaces `SERVER_RASTER_DESYNC`. Server-side state remains authoritative for
  anti-cheat and is the basis for future reconnect snapshots.
- Ordering guarantee: turns are flushed at the top of `tick()`, so a turn
  holds exactly the commands applied since the previous tick, and the hash is
  taken at the one instant referee and replica agree by construction (all of
  the turn's commands applied, tick not yet simulated). Commands bots issue
  *during* a tick's snapshot broadcast land in the next turn — which is also
  when the sim first reads them on both sides.

Wire cost per lockstep client is a few KB/s of intents instead of the
owner-delta stream — the property that makes ~100-player lobbies affordable.
Try it against a running server with `?net=lockstep` in the client URL
(`?net=ws` selects the snapshot-streaming thin client).

Determinism replay coverage: `tests/lockstepReplica.test.ts` replays a full
bot-field match from the recorded turn stream and asserts bit-identical state.

---

## Known Limitations (MVP)

| # | Limitation | Impact |
|---|-----------|--------|
| 1 | **No player identity / auth** — the server trusts the socket; one socket = one solo match. | Fine for solo-vs-bot; real PvP needs identity. |
| 2 | **No reconnection / resync** — a dropped socket ends the match; the terrain cache is keyed by `terrainHash` but there is no session resume. | Reloading starts a fresh match. |
| 3 | **Solo matches only** — every client gets an isolated session vs one bot. There is no shared-session PvP or matchmaking yet. | No human-vs-human. |
| 4 | **Full ownership raster every tick** — the owner array is re-sent each tick (terrain is sent once). Acceptable at current map sizes; delta encoding will matter for larger maps or many players. | Bandwidth scales with map size × tick rate. |
| 5 | **No rate limiting beyond per-tick batching** — intents are buffered and applied at tick boundaries, but there is no per-client action-frequency cap. | Programmatic spam is throttled only by the tick cadence. |

Items 1 and 3 are the highest-priority gaps before real multiplayer.
