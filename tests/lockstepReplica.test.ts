import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController } from "../src/Server/RasterBotController.js";
import { buildFieldConfigs } from "../src/Server/botField.js";
import { LockstepReplica } from "../src/Client/lockstep/replica.js";
import { HASH_INTERVAL_TICKS, type RasterTurn } from "../src/Core/lockstep.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import type { RasterServerMessage } from "../src/Core/types.js";

// ---------------------------------------------------------------------------
// Server-refereed lockstep: the referee session records every command and
// relays them as per-tick turns; a replica session fed those turns must land
// on bit-identical state. These tests drive a real referee (bots included),
// replay its turn stream into a replica, and compare.
// ---------------------------------------------------------------------------

/**
 * Session options shared by referee and replica — identical sim inputs. Wider
 * than the default test map so a 7-seat field can't hit the 80% win threshold
 * (which would freeze the turn stream) inside the 400-tick replay window.
 */
const SESSION_OPTIONS = { spawnPhaseTicks: 20, width: 128, height: 80 } as const;

/** First neutral capturable land tile — a deterministic spawn target. */
const firstOpenTile = (session: RasterGameSession): { x: number; y: number } => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (grid.isCapturable(ref) && grid.ownerOf(ref) === NEUTRAL_PLAYER) {
      return { x: map.x(ref), y: map.y(ref) };
    }
  }
  throw new Error("no open land tile");
};

/**
 * First capturable tile not held by `attackerId` — a deterministic attack
 * target that keeps working once the field has swallowed all neutral land
 * (attacks against rivals are as good as land-grabs for the replay test).
 */
const targetTileFor = (session: RasterGameSession, attackerId: number): { x: number; y: number } | null => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (grid.isCapturable(ref) && grid.ownerOf(ref) !== attackerId) {
      return { x: map.x(ref), y: map.y(ref) };
    }
  }
  // Total conquest (possible on this tiny map) — nothing left to attack.
  return null;
};

/** Subscribe a lockstep human and capture the relay-turn stream. */
const seatLockstepHuman = (
  session: RasterGameSession,
  clientId: string,
): { turns: RasterTurn[]; messages: RasterServerMessage[] } => {
  const turns: RasterTurn[] = [];
  const messages: RasterServerMessage[] = [];
  const unsub = session.subscribe(
    clientId,
    (m) => {
      messages.push(m);
      if (m.type === "SERVER_RASTER_TURN") turns.push(m.payload);
    },
    false,
    false,
    undefined,
    "human",
    true,
  );
  assert.ok(unsub, "lockstep human seated");
  return { turns, messages };
};

/**
 * Build a replica from a referee's setup. `seats` must be the seat list taken
 * right after the match was fully seated (exactly what the registry sends in
 * `SERVER_RASTER_LOCKSTEP_START`) — a later snapshot would miss seats whose
 * subscribers have since detached.
 */
const buildReplica = (
  referee: RasterGameSession,
  seats: ReturnType<RasterGameSession["seatList"]>,
  yourPlayerId: number,
): { replica: LockstepReplica; session: RasterGameSession; messages: RasterServerMessage[] } => {
  const session = new RasterGameSession(SESSION_OPTIONS);
  assert.equal(session.peekTerrainHash(), referee.peekTerrainHash(), "replica runs the identical terrain");
  const messages: RasterServerMessage[] = [];
  const replica = new LockstepReplica({
    session,
    seats,
    yourPlayerId,
    send: (m) => messages.push(m),
  });
  return { replica, session, messages };
};

/** Feed every turn into the replica, asserting the referee hashes match. */
const replay = (replica: LockstepReplica, turns: RasterTurn[]): void => {
  let hashTurns = 0;
  for (const turn of turns) {
    if (turn.hash !== undefined) hashTurns += 1;
    const desync = replica.applyTurn(turn);
    assert.equal(
      desync,
      null,
      desync ? `desync at turn ${turn.turn}: referee ${desync.expectedHash}, replica ${desync.localHash}` : undefined,
    );
  }
  assert.ok(hashTurns >= 1, "at least one referee hash was checked");
};

/** Assert two sessions hold bit-identical simulation state. */
const assertSameState = (a: RasterGameSession, b: RasterGameSession): void => {
  assert.equal(b.stateHash(), a.stateHash(), "state hashes agree");
  assert.deepEqual(Array.from(b.peekGrid().owner), Array.from(a.peekGrid().owner), "ownership rasters agree");
  for (const id of a.peekGrid().players()) {
    assert.equal(Math.floor(b.peekGrid().troopsOf(id)), Math.floor(a.peekGrid().troopsOf(id)), `troops of ${id}`);
    assert.equal(Math.floor(b.peekGrid().goldOf(id)), Math.floor(a.peekGrid().goldOf(id)), `gold of ${id}`);
  }
  assert.equal(b.peekTick(), a.peekTick(), "match clocks agree");
};

test("a replica fed the referee's turns reproduces a bot-field match exactly", () => {
  const referee = new RasterGameSession(SESSION_OPTIONS);
  const { turns } = seatLockstepHuman(referee, "net-client");

  // A real AI field: bots and nations generate a steady stream of expand,
  // build and diplomacy commands — including commands issued *during* a tick's
  // snapshot broadcast, the ordering subtlety the turn protocol must preserve.
  const unsubBots: Array<() => void> = [];
  for (const cfg of buildFieldConfigs(6, "medium", "referee-match")) {
    unsubBots.push(new RasterBotController(cfg).attach(referee));
  }
  const seats = referee.seatList();

  const spawn = firstOpenTile(referee);
  referee.selectSpawn("net-client", spawn.x, spawn.y);

  for (let i = 0; i < 400; i += 1) {
    // Sporadic human intents, including ones the session must reject — the
    // replica has to walk the identical accept/reject path.
    if (i % 60 === 10) {
      // Small commits: the point is a steady command stream, not conquest — a
      // human steamrolling this tiny map would end the match (80% win) before
      // the 400-turn stream the replay assertions need.
      const target = targetTileFor(referee, 1);
      if (target) referee.queueExpand("net-client", { targetX: target.x, targetY: target.y, percent: 5 });
    }
    if (i === 75) referee.proposeAlliance("net-client", 2);
    if (i === 90) referee.queueBuild("net-client", { targetX: spawn.x, targetY: spawn.y, building: "city" });
    if (i === 120) referee.sendEmoji("net-client", 2, 3);
    if (i === 150) referee.queueExpand("net-client", { targetX: 10_000, targetY: 10_000, percent: 25 });
    referee.tick();
  }

  // Quiesce: detach the AI so no commands are recorded during the final ticks,
  // then flush the tail — after this, referee and replica have simulated the
  // same tick count with every relayed command applied on both sides.
  for (const unsub of unsubBots) unsub();
  referee.tick();
  referee.tick();

  assert.ok(turns.length >= 400, "one relay turn per tick");
  assert.ok(
    turns.some((t) => t.commands.length > 0),
    "the AI field actually produced relayed commands",
  );

  const { replica, session } = buildReplica(referee, seats, 1);
  replay(replica, turns);
  assertSameState(referee, session);
});

test("interleaved commands from two lockstep humans replay in referee order", () => {
  const referee = new RasterGameSession(SESSION_OPTIONS);
  const alice = seatLockstepHuman(referee, "alice");
  seatLockstepHuman(referee, "bob");

  const spawnA = firstOpenTile(referee);
  referee.selectSpawn("alice", spawnA.x, spawnA.y);
  const spawnB = firstOpenTile(referee);
  referee.selectSpawn("bob", spawnB.x, spawnB.y);

  for (let i = 0; i < 220; i += 1) {
    if (i === 30) referee.proposeAlliance("alice", 2);
    if (i === 31) referee.proposeAlliance("bob", 1); // crossing offer seals the pact
    if (i === 60) referee.donate("alice", 2, "troops", 10);
    if (i === 61) referee.donate("bob", 1, "gold", 5);
    if (i === 80) referee.setEmbargo("alice", 2, true);
    if (i === 90) referee.breakAlliance("bob", 1);
    if (i % 40 === 20) {
      const ta = targetTileFor(referee, 1);
      const tb = targetTileFor(referee, 2);
      referee.queueExpand("alice", { targetX: ta.x, targetY: ta.y, percent: 20 });
      referee.queueExpand("bob", { targetX: tb.x, targetY: tb.y, percent: 20 });
    }
    referee.tick();
  }
  referee.tick();

  // Replay from Bob's perspective — the local seat must not matter for state.
  const { replica, session, messages } = buildReplica(referee, referee.seatList(), 2);
  replay(replica, alice.turns);
  assertSameState(referee, session);
  // Bob's replica produced his own local stream: assignment + snapshots.
  assert.ok(messages.some((m) => m.type === "SERVER_RASTER_PLAYER_ASSIGNED"), "local seat got its assignment");
  assert.ok(messages.some((m) => m.type === "SERVER_RASTER_SNAPSHOT"), "local seat renders from replica snapshots");
});

test("a replica that drifts from the referee reports a desync at the next hash turn", () => {
  const referee = new RasterGameSession(SESSION_OPTIONS);
  const { turns } = seatLockstepHuman(referee, "net-client");
  const spawn = firstOpenTile(referee);
  referee.selectSpawn("net-client", spawn.x, spawn.y);
  for (let i = 0; i < HASH_INTERVAL_TICKS * 2 + 5; i += 1) referee.tick();

  const { replica, session } = buildReplica(referee, referee.seatList(), 1);

  let sawDesync = false;
  for (const turn of turns) {
    // Just after the first hash checkpoint, corrupt the replica with a command
    // the referee never saw.
    if (turn.turn === HASH_INTERVAL_TICKS + 1) {
      const target = firstOpenTile(session);
      session.queueExpand("local", { targetX: target.x, targetY: target.y, percent: 50 });
    }
    const desync = replica.applyTurn(turn);
    if (desync) {
      sawDesync = true;
      assert.notEqual(desync.localHash, desync.expectedHash);
      break;
    }
  }
  assert.ok(sawDesync, "the divergence was caught at a hash checkpoint");
});

test("a gap in the turn sequence is fatal, never silently skipped", () => {
  const referee = new RasterGameSession(SESSION_OPTIONS);
  const { turns } = seatLockstepHuman(referee, "net-client");
  for (let i = 0; i < 3; i += 1) referee.tick();

  const { replica } = buildReplica(referee, referee.seatList(), 1);
  replica.applyTurn(turns[0]);
  assert.throws(() => replica.applyTurn(turns[2]), /turn gap/i);
});

test("non-lockstep sessions record nothing and relay nothing", () => {
  const session = new RasterGameSession(SESSION_OPTIONS);
  const messages: RasterServerMessage[] = [];
  session.subscribe("plain", (m) => messages.push(m));
  const spawn = firstOpenTile(session);
  session.selectSpawn("plain", spawn.x, spawn.y);
  for (let i = 0; i < 5; i += 1) session.tick();
  assert.ok(messages.length > 0, "the plain client still gets its snapshots");
  assert.ok(
    messages.every((m) => m.type !== "SERVER_RASTER_TURN"),
    "no relay turns leak to snapshot-streamed clients",
  );
});
