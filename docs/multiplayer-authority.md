# Multiplayer Authority Architecture

This document describes the server-authoritative design used by Control & Conquer's
multiplayer layer, the event flow between client and server, and the known
limitations of the current MVP implementation.

---

## Guiding Principle

**The server is the single source of truth for all game state.**  
Clients never mutate game state locally; they only render the snapshot most
recently received from the server and send intent-only commands.

---

## Components

| Component | File(s) | Responsibility |
|-----------|---------|----------------|
| **WebSocket server** | `src/Server/index.ts` | Accepts connections, parses messages, dispatches validated commands, broadcasts snapshots |
| **Command validator** | `src/Server/validateCommand.ts` | Structural validation of raw incoming JSON before it reaches game logic |
| **GameSession** | `src/Server/GameSession.ts` | Owns the authoritative `MapState`; exposes `handleCommand` and `tick` |
| **MapState** | `src/Core/MapState.ts` | Applies commands with business-rule validation (ownership, credits, etc.); advances ticks |
| **BattleEngine** | `src/Core/BattleEngine.ts` | Deterministic, self-contained combat resolution |
| **Client** | `src/Client/main.ts` | Renders server snapshots; emits input events over WebSocket |

---

## Event Flow

```
Client                              Server
  │                                   │
  │  ── WebSocket connect ──────────► │  game.subscribe(socket → send snapshot)
  │  ◄─ { type:"snapshot", … } ────── │  (initial state sent immediately)
  │                                   │
  │  User clicks "Purchase 2 inf"     │
  │  ── { type:"purchase",           │
  │       playerId, provinceId,       │
  │       unitType, count } ────────► │  validateCommand(raw)       [shape check]
  │                                   │  mapState.applyCommand(cmd) [business rules]
  │  ◄─ { type:"snapshot", … } ────── │  broadcast to all subscribers
  │                                   │
  │  ── { type:"move", … } ─────────► │  validateCommand → applyCommand → broadcast
  │  ◄─ { type:"snapshot", … } ────── │
  │                                   │
  │  ── { type:"placeMine", … } ────► │  validateCommand → applyCommand → broadcast
  │  ◄─ { type:"snapshot", … } ────── │
  │                                   │
  │  (server-side 1 s tick)           │
  │  ◄─ { type:"snapshot", … } ────── │  game.tick() → income → broadcast
  │                                   │
  │  Bad command sent by client       │
  │  ── { type:"nuke" } ────────────► │  validateCommand throws
  │  ◄─ { type:"error", message } ─── │  error sent to that socket only
```

---

## Server Responsibilities

1. **Structural validation** (`validateCommand`)  
   Checks that the raw JSON object has the correct `type` discriminant and that
   every required field is present with the right data type (non-empty string,
   positive integer, known `UnitType`).  Any violation produces a `{ type: "error" }`
   message sent back to the offending client; no state change occurs.

2. **Business-rule validation** (`MapState`)  
   After structural validation the command is forwarded to `MapState.applyCommand`,
   which enforces game rules:
   - Province ownership (can only purchase/mine in your own province)
   - Connectivity (move must be to a neighbouring province, unless GLA tunnel)
   - Affordability (credits must cover unit cost)
   - Mine prerequisites (general level ≥ 1 and unused mine charge)
   Violations throw an `Error` that the server catches and relays as a `{ type: "error" }` message.

3. **Authoritative state mutation**  
   Only `MapState` methods (`purchase`, `move`, `placeMine`, `tick`) mutate game
   state.  There is no code path by which a client can influence state other than
   through these validated entry points.

4. **Broadcast** (`GameSession.broadcast`)  
   After every state-changing operation a full `GameState` snapshot is sent to
   every connected socket via `{ type: "snapshot", payload: GameState }`.

---

## Client Responsibilities

- Render the most recently received `GameState` snapshot (read-only).
- Translate UI gestures (button clicks, canvas clicks) into command objects and
  send them over the WebSocket.
- Display error messages returned by the server.
- Maintain ephemeral UI-only state (selected province, battle animation timers)
  that has no effect on game logic.

The client holds **no authoritative state**.  Local variables (`state`,
`selectedProvinceId`, `animatedBattleId`) are purely presentational and are
overwritten on every server snapshot.

---

## Known Limitations (MVP)

| # | Limitation | Impact |
|---|-----------|--------|
| 1 | **No session / player identity** – The client sends its own `playerId` string with every command; the server trusts it. Any connected client can act as any player. | Any peer can issue commands on behalf of another player. |
| 2 | **No reconnection / state recovery** – Clients that disconnect lose their subscription and must reload to receive a new snapshot. In-flight commands sent while disconnected are silently dropped. | Poor resilience in unstable network conditions. |
| 3 | **Single shared game session** – There is one global `GameSession` instance; all connected clients participate in the same match. | No matchmaking, no multiple concurrent games. |
| 4 | **Full snapshots only** – Every state change broadcasts the entire `GameState`. For a small map this is acceptable; for larger maps it will become bandwidth-inefficient. | Not suitable for maps with many provinces or large player counts. |
| 5 | **No anti-cheat beyond basic validation** – Count ceilings, rate limiting, and action-frequency checks are not implemented. | Trivial programmatic exploits remain possible. |

Items 1 and 3 are the highest-priority gaps for the next iteration.
