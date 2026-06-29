import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage } from "../src/Core/types.js";

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
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
