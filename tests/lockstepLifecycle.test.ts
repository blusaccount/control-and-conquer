import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { LockstepReplica } from "../src/Client/lockstep/replica.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import type { RasterLockstepStartPayload, RasterTurn } from "../src/Core/lockstep.js";
import type { RasterServerMessage } from "../src/Core/types.js";

// ---------------------------------------------------------------------------
// Regression tests for the lifecycle/reconnect defects found in review:
// pending-intent migration on rebind, membership guards, prompt reaping,
// spawn-veto release, backlog chunking, and fatal-flagged lobby errors.
// ---------------------------------------------------------------------------

const makeClient = () => {
  const messages: RasterServerMessage[] = [];
  return {
    messages,
    send: (m: RasterServerMessage) => messages.push(m),
    setup(): RasterLockstepStartPayload {
      const m = messages.find((x) => x.type === "SERVER_RASTER_LOCKSTEP_START");
      assert.ok(m && m.type === "SERVER_RASTER_LOCKSTEP_START", "received the lockstep setup");
      return m.payload;
    },
    turns(): RasterTurn[] {
      return messages.flatMap((m) => (m.type === "SERVER_RASTER_TURN" ? [m.payload] : []));
    },
    backlogs(): RasterTurn[][] {
      return messages.flatMap((m) => (m.type === "SERVER_RASTER_TURN_BACKLOG" ? [m.payload.turns] : []));
    },
    lobbyErrors() {
      return messages.flatMap((m) => (m.type === "SERVER_RASTER_LOBBY_ERROR" ? [m.payload] : []));
    },
  };
};

const openTileAwayFrom = (
  session: RasterGameSession,
  clear: Array<{ x: number; y: number }> = [],
  clearOf = 8,
): { x: number; y: number } => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (!grid.isCapturable(ref) || grid.ownerOf(ref) !== NEUTRAL_PLAYER) continue;
    const x = map.x(ref);
    const y = map.y(ref);
    if (clear.every((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) >= clearOf)) return { x, y };
  }
  throw new Error("no open land tile");
};

test("a rebind mid-window migrates pending intents — referee and replica stay in lockstep", () => {
  const referee = new RasterGameSession({ spawnPhaseTicks: 5 });
  const turns: RasterTurn[] = [];
  referee.setTurnListener((t) => turns.push(t));
  const unsub = referee.subscribe("old-conn", () => {}, false, false, undefined, "human", true);
  assert.ok(unsub);
  const seats = referee.seatList();

  const spawn = openTileAwayFrom(referee);
  referee.selectSpawn("old-conn", spawn.x, spawn.y);
  for (let i = 0; i < 10; i += 1) referee.tick();

  // Queue an expand, then rebind the seat BEFORE the tick drains the queue —
  // exactly the resume race. The recorded command has already been relayed,
  // so the referee dropping it would desync every replica. The target sits
  // right on the player's frontier, so the attack is guaranteed to be
  // accepted and to take ground (a rejected intent would prove nothing:
  // both sides would no-op identically).
  const map = referee.peekMap();
  const grid = referee.peekGrid();
  let target: { x: number; y: number } | null = null;
  for (const owned of grid.tilesOf(1)) {
    for (const n of map.neighbors(owned)) {
      if (grid.isCapturable(n) && grid.ownerOf(n) === NEUTRAL_PLAYER) {
        target = { x: map.x(n), y: map.y(n) };
        break;
      }
    }
    if (target) break;
  }
  assert.ok(target, "found a neutral tile on the frontier");
  referee.queueExpand("old-conn", { targetX: target.x, targetY: target.y, percent: 40 });
  assert.equal(referee.getPendingExpandCount(), 1, "the intent is queued");
  assert.equal(referee.rebindSubscriber("old-conn", "new-conn", () => {}), true);
  const tilesBefore = referee.peekGrid().tileCountOf(1);
  for (let i = 0; i < 10; i += 1) referee.tick();
  assert.ok(referee.peekGrid().tileCountOf(1) > tilesBefore, "the referee applied the pre-rebind intent");

  const session = new RasterGameSession({ spawnPhaseTicks: 5 });
  const replica = new LockstepReplica({ session, seats, yourPlayerId: 1, send: () => {} });
  for (const turn of turns) {
    assert.equal(replica.applyTurn(turn), null, `no desync at turn ${turn.turn}`);
  }
  assert.equal(session.stateHash(), referee.stateHash(), "referee and replica agree after the rebind");
});

test("a connection can drive only one lobby/match; a busy resume is refused with a fatal error", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  registry.createLobby("c1", host.send, "m", "Map", {}, "easy", 0, "Host");

  // A JOIN while waiting in a lobby must not spawn a parallel match.
  const before = registry.getActiveRasterMatchCount();
  registry.joinRasterSolo("c1", host.send, {}, "easy", 0);
  assert.equal(registry.getActiveRasterMatchCount(), before, "join-while-in-lobby is ignored");

  // Start the match, grab the token, then try to resume it from a connection
  // that is already seated elsewhere.
  registry.startLobby("c1");
  const token = host.setup().resumeToken;
  const other = makeClient();
  registry.createLobby("c2", other.send, "m", "Map", {}, "easy", 0, "Other");
  assert.equal(registry.resumeLockstep("c2", other.send, token), false, "a busy connection cannot hijack a seat");
  assert.ok(other.lobbyErrors().some((e) => e.fatal === true), "the refusal is explicit and fatal");
});

test("socket close winds down every membership, including the plain solo match", () => {
  const registry = new MatchRegistry();
  const client = makeClient();
  registry.joinRasterSolo("p1", client.send, {}, "easy", 0);
  assert.equal(registry.getActiveRasterMatchCount(), 1);
  assert.equal(registry.handleSocketClose("p1"), true, "the registry owns plain-match teardown now");
  assert.equal(registry.getActiveRasterMatchCount(), 0, "the solo session is gone");
});

test("an ended lockstep match is reaped promptly, freeing the connection for a new lobby", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const code = registry.createLobby("h", host.send, "m", "Map", { maxDurationTicks: 20 }, "easy", 0, "Host");
  assert.ok(code);
  registry.startLobby("h");
  const setup = host.setup();
  assert.ok(setup.spawnPhaseTicks > 0);

  // Play past the time limit: spawn phase + 20 game ticks + the reap sweep.
  for (let i = 0; i < setup.spawnPhaseTicks + 25; i += 1) registry.tickAll();
  assert.equal(registry.getActiveRasterMatchCount(), 0, "the ended match left activeMatches");
  assert.equal(registry.isClientBusy("h"), false, "the connection is free again");
  const code2 = registry.createLobby("h", host.send, "m", "Map", {}, "easy", 0, "Host");
  assert.ok(code2.length >= 4, "a new lobby can be created on the same connection");
});

test("a dead socket's unpicked seat is auto-seated, so it stops vetoing the early start", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const guest = makeClient();
  const code = registry.createLobby("h", host.send, "m", "Map", {}, "medium", 0, "Alice");
  registry.joinLobby("g", guest.send, code, "Bob");
  registry.startLobby("h");
  const setup = host.setup();

  // The guest's tab dies before picking; the host then picks. With the ghost
  // seat auto-seated on disconnect, the battle must start at once instead of
  // holding the host hostage for the whole lobby countdown.
  registry.handleSocketClose("g");
  const probe = new RasterGameSession({ spawnPhaseTicks: setup.spawnPhaseTicks });
  const spawn = openTileAwayFrom(probe, [], 12);
  registry.selectRasterSpawn("h", spawn.x, spawn.y);
  registry.tickAll();
  const turns = host.turns();
  // The relay stream carries both the auto-pick (recorded on disconnect) and
  // the host's pick — and the match clock is running.
  const picks = turns.flatMap((t) => t.commands).filter((c) => c.command.type === "CLIENT_RASTER_SELECT_SPAWN");
  assert.ok(picks.length >= 2, "the abandoned seat was auto-seated via a recorded pick");
});

test("a long backlog is resumed in bounded chunks that fast-forward to the live state", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const code = registry.createLobby("h", host.send, "m", "Map", {}, "easy", 0, "Host");
  assert.ok(code);
  registry.startLobby("h");
  const setup = host.setup();

  const probe = new RasterGameSession({ spawnPhaseTicks: setup.spawnPhaseTicks });
  const spawn = openTileAwayFrom(probe);
  registry.selectRasterSpawn("h", spawn.x, spawn.y);
  // Cross the 2000-turn chunk boundary so the resume needs several messages.
  for (let i = 0; i < 2100; i += 1) registry.tickAll();

  registry.handleSocketClose("h");
  const rejoined = makeClient();
  assert.equal(registry.resumeLockstep("h2", rejoined.send, setup.resumeToken), true);
  const chunks = rejoined.backlogs();
  assert.ok(chunks.length >= 2, `the backlog arrived in ${chunks.length} bounded chunks`);
  assert.ok(chunks.every((c) => c.length <= 2000), "no chunk exceeds the slice size");

  const session = new RasterGameSession({ spawnPhaseTicks: setup.spawnPhaseTicks });
  const replica = new LockstepReplica({ session, seats: setup.seats, yourPlayerId: setup.yourPlayerId, send: () => {} });
  for (const turn of chunks.flat()) {
    assert.equal(replica.applyTurn(turn), null, `no desync at turn ${turn.turn}`);
  }
  // One relay turn per tick: the chunks cover the referee's full history.
  assert.equal(chunks.flat().length, 2100, "the chunks cover the whole match history");
});
