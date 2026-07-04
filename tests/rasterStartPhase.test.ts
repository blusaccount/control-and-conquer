import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

/** First neutral, capturable land tile on the session's map. */
const firstNeutralLand = (session: RasterGameSession): number => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (grid.isCapturable(ref) && grid.ownerOf(ref) === 0) return ref;
  }
  throw new Error("no neutral land on the test map");
};

test("a configured start phase opens the match in the spawn phase with a countdown", () => {
  // 20 ticks = 1s at the test tick rate, so the countdown reads ~1s.
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 20 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);

  const snap = lastSnapshot(messages);
  assert.equal(snap.phase, "spawn", "the match starts in the spawn (start) phase");
  assert.ok(snap.spawnRemainingSeconds >= 1, "a positive countdown is reported");
});

test("with no start phase the match is live from the first snapshot", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);
  const snap = lastSnapshot(messages);
  assert.equal(snap.phase, "playing", "no spawn-phase length means immediate play");
  assert.equal(snap.spawnRemainingSeconds, 0);
});

test("the world stays frozen while the start phase runs, and opens once it ends", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 4 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);
  const grid = session.peekGrid();
  const map = session.peekMap();

  // An expand queued during the start phase is dropped — no territory is taken
  // (the human hasn't even founded yet; picking would start the game at once).
  const spawn = firstNeutralLand(session);
  session.queueExpand("human", { targetX: map.x(spawn), targetY: map.y(spawn), percent: 100 });
  session.tick(); // tick 1 of the start phase
  assert.equal(grid.hasPlayer(1), false, "no expansion or seating happens during the start phase");
  assert.equal(lastSnapshot(messages).phase, "spawn");

  // Run the rest of the start-phase countdown out.
  session.tick(); // 2
  session.tick(); // 3
  assert.equal(lastSnapshot(messages).phase, "spawn", "still in the start phase before it elapses");

  session.tick(); // 4 — countdown elapses, flips to the game phase this tick
  const snap = lastSnapshot(messages);
  assert.equal(snap.phase, "playing", "the game phase begins once the countdown elapses");
  assert.equal(snap.spawnRemainingSeconds, 0);

  // Now expansion works (the no-show was auto-seated on its founding blob).
  const seated = session.peekGrid().tileCountOf(1);
  assert.ok(seated >= 1, "auto-seated once the game phase begins");
  session.queueExpand("human", { targetX: map.x(spawn) + 1, targetY: map.y(spawn), percent: 100 });
  session.tick();
  assert.ok(session.peekGrid().tileCountOf(1) >= seated, "expansion resolves once the game is live");
});

test("a human pick during the start phase begins the battle immediately (solo)", () => {
  // OpenFront singleplayer ends the spawn phase the moment the human picks a
  // start position (`SpawnExecution` → `endSpawnPhase()`); the countdown is
  // only a fallback for a player who never clicks.
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 50 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);
  const map = session.peekMap();

  const spawn = firstNeutralLand(session);
  session.selectSpawn("human", map.x(spawn), map.y(spawn));
  const snap = lastSnapshot(messages);
  assert.equal(snap.phase, "playing", "the pick starts the game — no dead countdown wait");

  // The very next tick resolves live orders.
  session.queueExpand("human", { targetX: map.x(spawn) + 1, targetY: map.y(spawn), percent: 100 });
  session.tick();
  assert.ok(session.peekGrid().tileCountOf(1) >= 1, "the world is live right after the pick");
});

test("a player who never picks a spawn is auto-seated when the game phase begins", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 2 });
  session.subscribe("human", () => {}, false);
  const grid = session.peekGrid();
  assert.equal(grid.hasPlayer(1), false, "unspawned during the start phase");

  session.tick(); // 1
  session.tick(); // 2 — start phase elapses
  assert.equal(grid.hasPlayer(1), true, "auto-seated when the game phase begins");
  assert.ok(grid.tileCountOf(1) > 1, "auto-seated on a founding blob (OpenFront spawn radius)");
});

test("the match clock only starts once the game phase begins", () => {
  // A 3-up start phase then a 2-tick game; the run must not end during the start
  // phase even though more than `maxDurationTicks` ticks pass overall.
  const session = new RasterGameSession({
    width: 32,
    height: 24,
    seed: 9,
    spawnPhaseTicks: 3,
    maxDurationTicks: 2,
  });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);

  session.tick(); // start 1
  session.tick(); // start 2
  assert.ok(
    !messages.some((m) => m.type === "SERVER_RASTER_MATCH_ENDED"),
    "the match must not end (or its clock run) during the start phase",
  );
  assert.equal(lastSnapshot(messages).tick, 0, "the game tick stays at 0 through the start phase");
});
