import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

type Snapshot = Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }>;

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  const snaps = messages.filter((m): m is Snapshot => m.type === "SERVER_RASTER_SNAPSHOT");
  return snaps[snaps.length - 1].payload;
};

/** Hand `playerId` a few extra neutral tiles so we can prove a full wipe-out. */
const grantExtraTiles = (session: RasterGameSession, playerId: number, count: number): void => {
  const grid = session.peekGrid();
  let granted = 0;
  for (let ref = 0; ref < grid.owner.length && granted < count; ref += 1) {
    if (grid.isCapturable(ref) && grid.owner[ref] === 0) {
      grid.claim(ref, playerId);
      granted += 1;
    }
  }
};

test("a player begins holding a single founding tile and is not eliminated", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const messages = collect(session, "alice");
  const snap = lastSnapshot(messages);
  const me = snap.players.find((p) => p.playerId === 1);
  assert.ok(me, "player 1 must be present");
  assert.equal(session.peekGrid().tileCountOf(1), 1, "exactly the founding tile");
  assert.equal(me!.eliminated, false);
});

test("capturing a nation's entire territory eliminates it; the conqueror keeps the land", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a = collect(session, "alice");
  collect(session, "bob");
  const grid = session.peekGrid();

  grantExtraTiles(session, 1, 2);
  const before = grid.tilesOf(1);
  assert.ok(before.length >= 2, "player 1 should hold the founding tile plus extras");

  // Player 2 takes every one of player 1's tiles, then a tick resolves the wipe-out.
  for (const ref of before) grid.claim(ref, 2);
  session.tick();

  const after = lastSnapshot(a);
  const fallen = after.players.find((p) => p.playerId === 1)!;
  assert.equal(fallen.eliminated, true, "player 1 must be flagged eliminated");
  assert.equal(grid.tileCountOf(1), 0, "player 1 holds no tiles");
  // No capital shortcut and no collapse-to-neutral: the conqueror keeps it all.
  for (const ref of before) assert.equal(grid.ownerOf(ref), 2, "the conqueror keeps the captured ground");
  assert.ok(
    after.recentEvents.some((e) => e.includes("eliminated")),
    "an elimination event should be broadcast",
  );
});

test("a nation still holding one tile is not eliminated", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a = collect(session, "alice");
  collect(session, "bob");
  const grid = session.peekGrid();

  grantExtraTiles(session, 1, 2);
  const tiles = grid.tilesOf(1);
  assert.ok(tiles.length >= 2);
  // Take all but the last tile.
  for (let i = 0; i < tiles.length - 1; i += 1) grid.claim(tiles[i], 2);
  session.tick();

  const fallen = lastSnapshot(a).players.find((p) => p.playerId === 1)!;
  assert.equal(fallen.eliminated, false, "one tile left means still in the game");
  assert.equal(grid.tileCountOf(1), 1);
});

test("an eliminated player is not re-eliminated on later ticks", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a = collect(session, "alice");
  collect(session, "bob");
  const grid = session.peekGrid();

  for (const ref of grid.tilesOf(1)) grid.claim(ref, 2);
  session.tick();
  const eventsAfterFirst = lastSnapshot(a).recentEvents.filter((e) => e.includes("eliminated")).length;
  session.tick();
  const eventsAfterSecond = lastSnapshot(a).recentEvents.filter((e) => e.includes("eliminated")).length;
  assert.equal(eventsAfterSecond, eventsAfterFirst, "no duplicate elimination event");
});
