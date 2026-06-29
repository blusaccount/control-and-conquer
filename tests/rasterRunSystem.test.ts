import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

type Ended = Extract<RasterServerMessage, { type: "SERVER_RASTER_MATCH_ENDED" }>;
type Snap = Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }>;

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const endedOf = (messages: RasterServerMessage[]): Ended | undefined =>
  messages.find((m): m is Ended => m.type === "SERVER_RASTER_MATCH_ENDED");

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  const snaps = messages.filter((m): m is Snap => m.type === "SERVER_RASTER_SNAPSHOT");
  return snaps[snaps.length - 1].payload;
};

test("a match ends on the time limit and crowns the territory leader", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3, maxDurationTicks: 3 });
  const messages = collect(session, "human");
  session.tick();
  session.tick();
  session.tick(); // conflict.tick reaches 3 == limit

  const ended = endedOf(messages);
  assert.ok(ended, "a match-ended message must be broadcast at the time limit");
  assert.equal(ended!.payload.reason, "timeLimit");
  assert.equal(ended!.payload.durationTicks, 3);
  assert.ok(ended!.payload.tickRate > 0);
  // The lone player holds territory, so they are the declared winner.
  assert.equal(ended!.payload.winnerPlayerId, 1);
  assert.equal(ended!.payload.stats.playerId, 1);
  assert.equal(ended!.payload.stats.won, true);
});

test("the simulation freezes after a match ends (no further broadcasts)", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3, maxDurationTicks: 2 });
  const messages = collect(session, "human");
  session.tick();
  session.tick(); // ends here
  const countAfterEnd = messages.length;
  session.tick();
  session.tick();
  assert.equal(messages.length, countAfterEnd, "no messages should be sent once the match has ended");
});

test("capital captures are credited as kills and recorded in run stats", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, maxDurationTicks: 2 });
  const alice = collect(session, "alice");
  const bob = collect(session, "bob");
  const grid = session.peekGrid();

  const snap = lastSnapshot(alice);
  const p1 = snap.players.find((p) => p.playerId === 1)!;
  const capitalRef = p1.capitalY * snap.width + p1.capitalX;

  grid.claim(capitalRef, 2); // Bob storms Alice's capital.
  session.tick(); // tick 1: Alice eliminated
  session.tick(); // tick 2: time limit -> match ends

  const aliceEnded = endedOf(alice);
  const bobEnded = endedOf(bob);
  assert.ok(aliceEnded && bobEnded);
  assert.equal(aliceEnded!.payload.stats.eliminated, true, "Alice should be eliminated");
  assert.equal(aliceEnded!.payload.stats.survivedTicks, 1, "Alice survived only to the elimination tick");
  assert.equal(bobEnded!.payload.stats.kills, 1, "Bob should be credited one kill");
});

test("an eliminated player gets a defeat summary at once, while the match continues", () => {
  // Three players so eliminating one doesn't end the match (two survive).
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, maxDurationTicks: 999 });
  const alice = collect(session, "alice");
  const bob = collect(session, "bob");
  const carol = collect(session, "carol");
  const grid = session.peekGrid();

  const snap = lastSnapshot(alice);
  const a1 = snap.players.find((p) => p.playerId === 1)!;
  grid.claim(a1.capitalY * snap.width + a1.capitalX, 2); // Bob storms Alice's capital.

  session.tick(); // Alice eliminated; Bob and Carol live on, so the match continues.

  const aliceEnded = alice.filter((m): m is Ended => m.type === "SERVER_RASTER_MATCH_ENDED");
  assert.equal(aliceEnded.length, 1, "Alice gets exactly one summary, the instant she dies");
  assert.equal(aliceEnded[0].payload.stats.eliminated, true);
  assert.equal(aliceEnded[0].payload.winnerPlayerId, null, "no global winner yet");
  assert.equal(endedOf(bob), undefined, "survivors get nothing while the match is live");
  assert.equal(endedOf(carol), undefined);

  // Further ticks must not send Alice a second summary.
  for (let i = 0; i < 5; i += 1) session.tick();
  assert.equal(
    alice.filter((m) => m.type === "SERVER_RASTER_MATCH_ENDED").length,
    1,
    "no duplicate summary on later ticks",
  );
});
