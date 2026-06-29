import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

/**
 * Stage a sea assault for player 1 on a hand-authored map: find a sea-link pair
 * spanning two landmasses, give player 1 a coastal foothold on the near one, and
 * return the far tile to click. Procedural continents almost never place a small
 * island within ship range of a spawn, so we construct the situation explicitly.
 */
const stageSeaTarget = (session: RasterGameSession): { x: number; y: number } => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  const spawnComp = (() => {
    for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) === 1) return grid.landComponentId(ref);
    return -1;
  })();
  for (let a = 0; a < map.size; a += 1) {
    const compA = grid.landComponentId(a);
    if (compA < 0) continue;
    for (const b of grid.seaLinks.neighborsOf(a)) {
      const compB = grid.landComponentId(b);
      // b must be a different landmass from both the foothold and the spawn, so
      // the only way to reach it is by ship.
      if (compB === compA || compB === spawnComp || grid.ownerOf(b) !== 0) continue;
      grid.claim(a, 1); // player 1 gains a coast on landmass A
      return { x: map.x(b), y: map.y(b) };
    }
  }
  throw new Error("no cross-landmass sea link on this map");
};

test("first subscriber gets PLAYER_ASSIGNED and an initial snapshot with terrain", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  assert.equal(messages[0].type, "SERVER_RASTER_PLAYER_ASSIGNED");
  assert.equal(messages[1].type, "SERVER_RASTER_SNAPSHOT");
  const snap = messages[1];
  if (snap.type !== "SERVER_RASTER_SNAPSHOT") throw new Error("type");
  assert.ok(snap.payload.terrainBase64, "first snapshot must include terrain bytes");
  assert.equal(snap.payload.width, 32);
  assert.equal(snap.payload.height, 24);
});

test("subsequent snapshots omit terrainBase64", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  session.tick();
  const snaps = messages.filter((m): m is Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }> => m.type === "SERVER_RASTER_SNAPSHOT");
  assert.equal(snaps.length, 2);
  assert.ok(snaps[0].payload.terrainBase64);
  assert.equal(snaps[1].payload.terrainBase64, undefined);
});

test("two subscribers get distinct playerIds and distinct spawn tiles", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a: RasterServerMessage[] = [];
  const b: RasterServerMessage[] = [];
  session.subscribe("alice", (m) => a.push(m));
  session.subscribe("bob", (m) => b.push(m));

  const aId = a[0].type === "SERVER_RASTER_PLAYER_ASSIGNED" ? a[0].payload.playerId : -1;
  const bId = b[0].type === "SERVER_RASTER_PLAYER_ASSIGNED" ? b[0].payload.playerId : -1;
  assert.notEqual(aId, bId);

  // After both join, the grid should have at least 2 distinct claimed tiles.
  const grid = session.peekGrid();
  let claimedA = 0, claimedB = 0;
  for (let i = 0; i < grid.owner.length; i += 1) {
    if (grid.owner[i] === aId) claimedA += 1;
    if (grid.owner[i] === bId) claimedB += 1;
  }
  assert.equal(claimedA, 1);
  assert.equal(claimedB, 1);
});

test("startingTroops option seeds each player's pool", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3, startingTroops: 123 });
  session.subscribe("human", () => {});
  const grid = session.peekGrid();
  // The human is player 1; income has not run yet (no tick), so the pool equals
  // the configured starting troops — proving the option is actually applied.
  assert.equal(grid.troopsOf(1), 123);
});

test("queueExpand with invalid tile is rejected on tick", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  session.queueExpand("human", { targetX: 1000, targetY: 1000, percent: 50 });
  session.tick();
  const rejected = messages.find((m) => m.type === "SERVER_RASTER_ACTION_REJECTED");
  assert.ok(rejected, "out-of-bounds tile must be rejected");
  if (rejected?.type === "SERVER_RASTER_ACTION_REJECTED") {
    assert.equal(rejected.payload.reason, "INVALID_TILE");
  }
});

test("ticks broadcast a snapshot every tick", () => {
  const session = new RasterGameSession({ width: 16, height: 12, seed: 2 });
  const messages = collect(session, "human");
  const before = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  session.tick();
  session.tick();
  session.tick();
  const after = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  assert.equal(after - before, 3);
});

test("snapshots carry a ships array (empty when none are at sea)", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  const snap = lastSnapshot(messages);
  assert.ok(Array.isArray(snap.ships), "every snapshot must carry a ships array");
  assert.equal(snap.ships.length, 0, "no ships are at sea before any are launched");
});

test("clicking a sea-only target dispatches a transport ship that lands", () => {
  const session = new RasterGameSession({ realMapId: "world", startingTroops: 200 });
  const messages = collect(session, "human");
  const target = stageSeaTarget(session);

  session.queueExpand("human", { targetX: target.x, targetY: target.y, percent: 100 });
  session.tick();

  const afterLaunch = lastSnapshot(messages);
  const myShips = afterLaunch.ships.filter((s) => s.playerId === 1);
  assert.equal(myShips.length, 1, "one click dispatches exactly one ship");
  assert.ok(afterLaunch.recentEvents.some((e) => e.includes("transport ship")), "the launch is logged");

  // Let the ship sail and disembark; it should capture its target tile.
  for (let i = 0; i < 30; i += 1) session.tick();
  const grid = session.peekGrid();
  const ref = session.peekMap().ref(target.x, target.y);
  assert.equal(grid.ownerOf(ref), 1, "the ship captured its beachhead");
  assert.equal(lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 0, "the ship is gone once it has landed");
});

test("a fourth simultaneous ship is rejected with TOO_MANY_SHIPS", () => {
  const session = new RasterGameSession({ realMapId: "world", startingTroops: 200 });
  const messages = collect(session, "human");
  const target = stageSeaTarget(session);

  // Four clicks on the same tick: only three ships may put to sea.
  for (let i = 0; i < 4; i += 1) {
    session.queueExpand("human", { targetX: target.x, targetY: target.y, percent: 10 });
  }
  session.tick();

  const rejections = messages.filter(
    (m): m is Extract<RasterServerMessage, { type: "SERVER_RASTER_ACTION_REJECTED" }> =>
      m.type === "SERVER_RASTER_ACTION_REJECTED",
  );
  assert.equal(rejections.length, 1, "exactly the fourth click is rejected");
  assert.equal(rejections[0].payload.reason, "TOO_MANY_SHIPS");
  assert.equal(session.peekGrid() && lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 3);
});

test("sessions with identical seed produce identical terrain bytes", () => {
  const a = new RasterGameSession({ width: 24, height: 16, seed: 11 });
  const b = new RasterGameSession({ width: 24, height: 16, seed: 11 });
  const aMap = a.peekMap();
  const bMap = b.peekMap();
  assert.equal(aMap.width, bMap.width);
  for (let i = 0; i < aMap.terrain.length; i += 1) {
    if (aMap.terrain[i] !== bMap.terrain[i]) {
      throw new Error(`terrain differs at byte ${i}: ${aMap.terrain[i]} vs ${bMap.terrain[i]}`);
    }
  }
});

const firstSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (const m of messages) if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  throw new Error("no snapshot seen");
};

test("headless subscribers get no ownership raster (the bot bandwidth saving)", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3 });
  const human: RasterServerMessage[] = [];
  const bot: RasterServerMessage[] = [];
  session.subscribe("human", (m) => human.push(m), true, true);
  session.subscribe("bot", (m) => bot.push(m), true, false);

  const humanSnap = firstSnapshot(human);
  const botSnap = firstSnapshot(bot);

  // The real client is seeded with the full terrain + owner raster...
  assert.ok(humanSnap.terrainBase64 !== undefined, "human gets terrain bytes");
  assert.ok(humanSnap.ownerBase64 !== undefined, "human gets the full owner raster");

  // ...while the headless bot, which reads engine state directly, gets neither
  // the terrain bytes nor any ownership encoding (the per-tick cost we cut).
  assert.equal(botSnap.terrainBase64, undefined, "bot gets no terrain bytes");
  assert.equal(botSnap.ownerBase64, undefined, "bot gets no full owner raster");
  assert.equal(botSnap.ownerDeltaBase64, undefined, "bot gets no owner delta");
  // It still receives the player standings it needs to make decisions.
  assert.ok(botSnap.players.length >= 1, "bot still sees player standings");
});

test("the snapshot reports an active attack front with the troops fighting on it", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), true, true); // auto-spawn on land
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.setTroops(1, 60);

  // Push into a neutral capturable neighbour of our founding tile.
  let target = -1;
  for (const ref of grid.tilesOf(1)) {
    for (const n of map.neighbors(ref)) {
      if (grid.isCapturable(n) && grid.ownerOf(n) === 0) { target = n; break; }
    }
    if (target >= 0) break;
  }
  assert.ok(target >= 0, "the spawn should border neutral land");
  session.queueExpand("human", { targetX: map.x(target), targetY: map.y(target), percent: 80 });
  session.tick();

  const snap = lastSnapshot(messages);
  const front = snap.fronts.find((f) => f.playerId === 1);
  assert.ok(front, "the player's own front is reported");
  assert.equal(front!.targetId, 0, "it pushes into neutral land");
  assert.ok(front!.troops > 0, "the troops fighting on the front are reported");
  assert.ok(front!.x >= 0 && front!.x < snap.width, "the front anchor is a real tile");
});
