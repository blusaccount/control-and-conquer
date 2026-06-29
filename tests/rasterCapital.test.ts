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

test("a player's capital is published at their spawn tile", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const messages = collect(session, "alice");
  const snap = lastSnapshot(messages);
  const me = snap.players.find((p) => p.playerId === 1);
  assert.ok(me, "player 1 must be present");

  // At spawn the player owns exactly one tile; the capital must be that tile.
  const grid = session.peekGrid();
  let ownedRef = -1;
  for (let i = 0; i < grid.owner.length; i += 1) {
    if (grid.owner[i] === 1) ownedRef = i;
  }
  assert.notEqual(ownedRef, -1, "player 1 should own a spawn tile");
  assert.equal(me!.capitalX, ownedRef % snap.width);
  assert.equal(me!.capitalY, Math.floor(ownedRef / snap.width));
  assert.equal(me!.eliminated, false);
});

test("capturing a capital eliminates the owner and turns their territory neutral", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a = collect(session, "alice");
  collect(session, "bob");
  const grid = session.peekGrid();

  // Find player 1's capital ref from the snapshot.
  const snap = lastSnapshot(a);
  const me = snap.players.find((p) => p.playerId === 1)!;
  const capitalRef = me.capitalY * snap.width + me.capitalX;

  // Give player 1 a few extra tiles so we can prove they go neutral on death.
  let granted = 0;
  for (let ref = 0; ref < grid.owner.length && granted < 3; ref += 1) {
    if (grid.isCapturable(ref) && grid.owner[ref] === 0) {
      grid.claim(ref, 1);
      granted += 1;
    }
  }
  assert.ok(grid.tileCountOf(1) >= 2, "player 1 should hold capital + extra tiles");

  // Player 2 storms the capital, then a tick resolves the capture.
  grid.claim(capitalRef, 2);
  session.tick();

  const after = lastSnapshot(a);
  const fallen = after.players.find((p) => p.playerId === 1)!;
  assert.equal(fallen.eliminated, true, "player 1 must be flagged eliminated");
  assert.equal(grid.tileCountOf(1), 0, "all of player 1's tiles must be neutral");
  assert.equal(grid.ownerOf(capitalRef), 2, "the conqueror keeps the captured capital tile");
  assert.ok(
    after.recentEvents.some((e) => e.includes("eliminated")),
    "an elimination event should be broadcast",
  );
});

test("an eliminated player is not re-eliminated on later ticks", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a = collect(session, "alice");
  collect(session, "bob");
  const grid = session.peekGrid();
  const snap = lastSnapshot(a);
  const me = snap.players.find((p) => p.playerId === 1)!;
  const capitalRef = me.capitalY * snap.width + me.capitalX;

  grid.claim(capitalRef, 2);
  session.tick();
  const eventsAfterFirst = lastSnapshot(a).recentEvents.filter((e) => e.includes("eliminated")).length;
  session.tick();
  const eventsAfterSecond = lastSnapshot(a).recentEvents.filter((e) => e.includes("eliminated")).length;
  assert.equal(eventsAfterSecond, eventsAfterFirst, "no duplicate elimination event");
});
