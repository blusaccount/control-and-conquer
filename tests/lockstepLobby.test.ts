import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { LockstepReplica } from "../src/Client/lockstep/replica.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import type { RasterLockstepStartPayload, RasterTurn } from "../src/Core/lockstep.js";
import type { RasterServerMessage } from "../src/Core/types.js";

// ---------------------------------------------------------------------------
// Shared lockstep lobbies (PvP) + reconnect via resume token & turn backlog.
// The contract under test: everything a client needs to mirror the referee is
// in SERVER_RASTER_LOCKSTEP_START + the turn stream — nothing else.
// ---------------------------------------------------------------------------

/** A fake connection: collects every server message, exposes the interesting ones. */
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
    backlog(): RasterTurn[] {
      const m = messages.find((x) => x.type === "SERVER_RASTER_TURN_BACKLOG");
      assert.ok(m && m.type === "SERVER_RASTER_TURN_BACKLOG", "received the turn backlog");
      return m.payload.turns;
    },
    lobbyStates() {
      return messages.flatMap((m) => (m.type === "SERVER_RASTER_LOBBY_STATE" ? [m.payload] : []));
    },
  };
};

/** Build a replica session straight from the wire setup — the real client path. */
const replicaFromSetup = (setup: RasterLockstepStartPayload, sink: RasterServerMessage[] = []) => {
  const session = new RasterGameSession({
    spawnPhaseTicks: setup.spawnPhaseTicks,
    difficulty: setup.difficulty,
    startingTroops: setup.startingTroops,
  });
  assert.equal(session.peekTerrainHash(), setup.terrainHash, "the setup names the terrain the replica builds");
  const replica = new LockstepReplica({
    session,
    seats: setup.seats,
    yourPlayerId: setup.yourPlayerId,
    send: (m) => sink.push(m),
  });
  return { session, replica };
};

/**
 * First neutral capturable tile at least `clearOf`-distant (Chebyshev) from
 * the given points — spawn picks must not land inside an earlier founder's
 * blob (radius 4), or the session rightly rejects them.
 */
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

/** Apply turns, asserting every embedded referee hash matches. */
const replay = (replica: LockstepReplica, turns: RasterTurn[]): void => {
  for (const turn of turns) {
    const desync = replica.applyTurn(turn);
    assert.equal(desync, null, desync ? `desync at turn ${turn.turn}` : undefined);
  }
};

test("with several humans, the battle only starts once every human has picked", () => {
  const session = new RasterGameSession({ spawnPhaseTicks: 50 });
  session.subscribe("a", () => {}, false);
  session.subscribe("b", () => {}, false);
  const t = openTileAwayFrom(session);
  session.selectSpawn("a", t.x, t.y);
  assert.equal(session.peekTick(), 0);
  session.tick();
  // One human picked, the other hasn't — still the start phase.
  assert.equal(session.peekTick(), 0, "the match clock has not started with a human still unspawned");
  const t2 = openTileAwayFrom(session, [t]);
  session.selectSpawn("b", t2.x, t2.y);
  session.tick();
  assert.ok(session.peekTick() >= 1, "the second pick starts the battle at once");
});

test("a lobby seats every member into one shared match whose replicas mirror the referee", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const guest = makeClient();

  const code = registry.createLobby("host-conn", host.send, "test-map", "Test Map", {}, "medium", 3, "Alice");
  assert.ok(code.length >= 4, "the host got a share code");
  assert.equal(host.lobbyStates().at(-1)?.youAreHost, true);

  registry.joinLobby("guest-conn", guest.send, code, "Bob");
  const state = guest.lobbyStates().at(-1);
  assert.equal(state?.members.length, 2, "both members are in the waiting room");
  assert.equal(state?.members.some((m) => m.name === "Alice" && m.isHost), true);

  // Only the host can start.
  registry.startLobby("guest-conn");
  assert.ok(
    guest.messages.some((m) => m.type === "SERVER_RASTER_LOBBY_ERROR"),
    "a guest pressing start is refused",
  );
  registry.startLobby("host-conn");

  const hostSetup = host.setup();
  const guestSetup = guest.setup();
  assert.notEqual(hostSetup.yourPlayerId, guestSetup.yourPlayerId, "each member owns a distinct seat");
  assert.notEqual(hostSetup.resumeToken, guestSetup.resumeToken, "each member gets a private resume token");
  assert.deepEqual(hostSetup.seats, guestSetup.seats, "both see the identical seat list");
  const humanSeats = hostSetup.seats.filter((s) => s.kind === "human");
  assert.deepEqual(humanSeats.map((s) => s.name).sort(), ["Alice", "Bob"], "display names reached the seats");

  // Play: both pick spawns (ending the long lobby start phase early), then a
  // few hundred ticks of the shared world with its bot field.
  const hostView: RasterServerMessage[] = [];
  const { session: hostReplicaSession, replica: hostReplica } = replicaFromSetup(hostSetup, hostView);
  const spawnA = openTileAwayFrom(hostReplicaSession);
  const spawnB = openTileAwayFrom(hostReplicaSession, [spawnA]);
  registry.selectRasterSpawn("host-conn", spawnA.x, spawnA.y);
  registry.selectRasterSpawn("guest-conn", spawnB.x, spawnB.y);

  for (let i = 0; i < 260; i += 1) {
    if (i === 40) registry.proposeRasterAlliance("host-conn", guestSetup.yourPlayerId);
    if (i === 41) registry.respondRasterAlliance("guest-conn", hostSetup.yourPlayerId, true);
    if (i === 90) registry.donateRaster("host-conn", guestSetup.yourPlayerId, "gold", 10);
    if (i % 50 === 20) {
      registry.queueRasterExpand("host-conn", { targetX: spawnA.x + 5, targetY: spawnA.y, percent: 20 });
      registry.queueRasterExpand("guest-conn", { targetX: spawnA.x + 7, targetY: spawnA.y, percent: 20 });
    }
    registry.tickAll();
  }

  // Both members' turn streams must be identical, and each replica must land
  // on the same referee-hashed state.
  assert.deepEqual(guest.turns(), host.turns(), "every member receives the identical turn stream");
  replay(hostReplica, host.turns());

  const guestView: RasterServerMessage[] = [];
  const { session: guestReplicaSession, replica: guestReplica } = replicaFromSetup(guestSetup, guestView);
  replay(guestReplica, guest.turns());
  assert.equal(guestReplicaSession.stateHash(), hostReplicaSession.stateHash(), "both replicas agree bit-for-bit");
  assert.ok(hostView.some((m) => m.type === "SERVER_RASTER_SNAPSHOT"), "the host's replica renders locally");
  assert.ok(
    guestReplicaSession.peekGrid().hasPlayer(hostSetup.yourPlayerId) &&
      guestReplicaSession.peekGrid().hasPlayer(guestSetup.yourPlayerId),
    "both human nations are on the shared map",
  );
});

test("a dropped member resumes by token: setup + backlog fast-forward to the live state", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const guest = makeClient();
  // No AI seats: this test is about resume plumbing, and an AI field on this
  // tiny map can win (and freeze the match) inside the pre-resume tick window.
  const code = registry.createLobby("h", host.send, "test-map", "Test Map", {}, "medium", 0, "Alice");
  registry.joinLobby("g", guest.send, code, "Bob");
  registry.startLobby("h");
  const hostSetup = host.setup();
  const guestSetup = guest.setup();

  const { session: probe } = replicaFromSetup(hostSetup);
  const spawn = openTileAwayFrom(probe);
  const spawnG = openTileAwayFrom(probe, [spawn]);
  registry.selectRasterSpawn("h", spawn.x, spawn.y);
  registry.selectRasterSpawn("g", spawnG.x, spawnG.y);
  for (let i = 0; i < 60; i += 1) registry.tickAll();

  // Bob's socket dies: his seat stays in the match, muted.
  assert.equal(registry.handleSocketClose("g"), true, "the registry owns lockstep disconnects");
  const guestTurnsBeforeDrop = guest.turns().length;
  for (let i = 0; i < 80; i += 1) registry.tickAll();
  assert.equal(guest.turns().length, guestTurnsBeforeDrop, "a dead socket receives nothing");

  // Bob reconnects on a fresh connection, presenting his token.
  const rejoined = makeClient();
  assert.equal(registry.resumeLockstep("g2", rejoined.send, guestSetup.resumeToken), true);
  const resumedSetup = rejoined.setup();
  assert.equal(resumedSetup.yourPlayerId, guestSetup.yourPlayerId, "the resume re-binds the same seat");

  // More live play after the resume — including a command from the new socket.
  registry.queueRasterExpand("g2", { targetX: spawn.x + 5, targetY: spawn.y, percent: 30 });
  for (let i = 0; i < 60; i += 1) registry.tickAll();

  // A fresh replica fed backlog + live turns must match the host's replica,
  // which followed the whole match live.
  const { replica: rejoinReplica, session: rejoinSession } = replicaFromSetup(resumedSetup);
  replay(rejoinReplica, [...rejoined.backlog(), ...rejoined.turns()]);
  const { replica: hostReplica, session: hostSession } = replicaFromSetup(hostSetup);
  replay(hostReplica, host.turns());
  assert.equal(rejoinSession.stateHash(), hostSession.stateHash(), "the resumed replica converges on the live state");

  // An unknown token is refused.
  const stranger = makeClient();
  assert.equal(registry.resumeLockstep("x", stranger.send, "not-a-real-token"), false);
});

test("lobby lifecycle edges: bad codes, full rooms, host departure", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const code = registry.createLobby("h", host.send, "m", "Map", {}, "easy", 0, "Host");

  const wrong = makeClient();
  registry.joinLobby("w", wrong.send, "ZZZZZZ", "Nobody");
  assert.ok(wrong.messages.some((m) => m.type === "SERVER_RASTER_LOBBY_ERROR"), "unknown codes are refused");

  const guest = makeClient();
  registry.joinLobby("g", guest.send, code, "Guest");
  registry.leaveLobby("h"); // host walks away → room closes for everyone
  assert.ok(
    guest.messages.some((m) => m.type === "SERVER_RASTER_LOBBY_ERROR" && m.payload.message.includes("closed")),
    "members learn the room closed",
  );
  const late = makeClient();
  registry.joinLobby("l", late.send, code, "Late");
  assert.ok(late.messages.some((m) => m.type === "SERVER_RASTER_LOBBY_ERROR"), "a closed room is gone");
});

test("the new lobby/resume messages validate strictly", () => {
  assert.deepEqual(
    validateCommand({ type: "CLIENT_RASTER_LOBBY_JOIN", payload: { code: "abc123", name: "  Käpt'n Blau  " } }),
    { type: "CLIENT_RASTER_LOBBY_JOIN", payload: { code: "ABC123", name: "Käpt'n Blau" } },
  );
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_LOBBY_JOIN", payload: { code: "no" } }), /code/);
  assert.throws(
    () => validateCommand({ type: "CLIENT_RASTER_LOBBY_CREATE", payload: { name: "<script>alert(1)</script>" } }),
    /name/,
  );
  assert.deepEqual(validateCommand({ type: "CLIENT_RASTER_LOBBY_START" }), { type: "CLIENT_RASTER_LOBBY_START" });
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_RESUME", payload: { token: "x" } }), /token/);
  const join = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { fieldSize: 12, lockstep: true } });
  assert.deepEqual(join, { type: "CLIENT_RASTER_JOIN", payload: { fieldSize: 12, lockstep: true } });
});
