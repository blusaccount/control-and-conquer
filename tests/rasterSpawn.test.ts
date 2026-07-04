import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import type { RasterServerMessage } from "../src/Core/types.js";

/** First neutral, capturable land tile on the session's map. */
const firstNeutralLand = (session: RasterGameSession): number => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (grid.isCapturable(ref) && grid.ownerOf(ref) === 0) return ref;
  }
  throw new Error("no neutral land on the test map");
};

const firstWater = (session: RasterGameSession): number => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) if (!grid.isCapturable(ref)) return ref;
  throw new Error("no water on the test map");
};

test("a human stays unspawned until they pick a start position", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, maxDurationTicks: 999 });
  session.subscribe("human", () => {}, false);
  const grid = session.peekGrid();
  assert.equal(grid.hasPlayer(1), false, "no territory before choosing a spawn");

  const ref = firstNeutralLand(session);
  const map = session.peekMap();
  session.selectSpawn("human", map.x(ref), map.y(ref));

  assert.equal(grid.hasPlayer(1), true, "seated after selecting a spawn");
  assert.ok(grid.tileCountOf(1) > 1, "starts on a founding blob, not a lone tile (OpenFront spawn radius)");
  assert.equal(grid.ownerOf(ref), 1, "the chosen tile is now ours");
});

test("selecting a water tile is rejected and seats nobody", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, maxDurationTicks: 999 });
  const msgs: RasterServerMessage[] = [];
  session.subscribe("human", (m) => msgs.push(m), false);

  const water = firstWater(session);
  const map = session.peekMap();
  session.selectSpawn("human", map.x(water), map.y(water));

  assert.equal(session.peekGrid().hasPlayer(1), false, "water is not a valid spawn");
  assert.ok(
    msgs.some((m) => m.type === "SERVER_RASTER_ACTION_REJECTED"),
    "a rejection is sent back",
  );
});

test("once the game is live the spawn is fixed and re-picks are ignored", () => {
  // No start phase configured → the session is in the `playing` phase from the
  // first tick, so a player keeps the ground they founded on.
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, maxDurationTicks: 999 });
  session.subscribe("human", () => {}, false);
  const map = session.peekMap();
  const a = firstNeutralLand(session);
  session.selectSpawn("human", map.x(a), map.y(a));
  const tiles = session.peekGrid().tileCountOf(1);
  // A second pick is ignored (already spawned, game live).
  session.selectSpawn("human", map.x(a) + 1, map.y(a));
  assert.equal(session.peekGrid().tileCountOf(1), tiles, "second spawn pick is ignored once live");
  assert.equal(session.peekGrid().ownerOf(a), 1, "the original founding tile is still ours");
});

test("a human's spawn pick starts the battle at once (OpenFront singleplayer)", () => {
  // OpenFront's `SpawnExecution` ends the spawn phase the moment the human
  // picks in a singleplayer game — no dead wait for the countdown. Every
  // session here hosts exactly one human, so the same rule applies.
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 20 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), false);
  const grid = session.peekGrid();
  const map = session.peekMap();

  const a = firstNeutralLand(session);
  session.selectSpawn("human", map.x(a), map.y(a));
  assert.equal(grid.ownerOf(a), 1, "founded on the pick");

  const snapshot = messages
    .filter((m) => m.type === "SERVER_RASTER_SNAPSHOT")
    .at(-1);
  assert.ok(snapshot && snapshot.type === "SERVER_RASTER_SNAPSHOT");
  assert.equal(snapshot.payload.phase, "playing", "the pick ends the spawn phase immediately");
  assert.equal(snapshot.payload.spawnRemainingSeconds, 0);

  // The game is live now, so a re-pick is ignored — the spawn is fixed.
  const held = grid.tileCountOf(1);
  const b = a + 1;
  session.selectSpawn("human", map.x(b), map.y(b));
  assert.equal(grid.tileCountOf(1), held, "no relocation once the battle has begun");
  assert.equal(grid.ownerOf(a), 1, "the founding tile is still ours");
});

test("re-picking your own current spawn tile is a harmless no-op", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, spawnPhaseTicks: 20 });
  const msgs: RasterServerMessage[] = [];
  session.subscribe("human", (m) => msgs.push(m), false);
  const map = session.peekMap();
  const a = firstNeutralLand(session);
  session.selectSpawn("human", map.x(a), map.y(a));
  msgs.length = 0;
  session.selectSpawn("human", map.x(a), map.y(a));
  assert.equal(session.peekGrid().ownerOf(a), 1, "still seated on the same tile");
  assert.ok(
    !msgs.some((m) => m.type === "SERVER_RASTER_ACTION_REJECTED"),
    "clicking your own spawn is not rejected",
  );
});

test("auto-spawn (the default, used by bots) seats immediately", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, maxDurationTicks: 999 });
  session.subscribe("bot", () => {}); // default autoSpawn = true
  assert.equal(session.peekGrid().hasPlayer(1), true, "bots are placed on subscribe");
});

test("validateCommand parses CLIENT_RASTER_SELECT_SPAWN and rejects bad payloads", () => {
  const ok = validateCommand({ type: "CLIENT_RASTER_SELECT_SPAWN", payload: { x: 5, y: 7 } });
  assert.equal(ok.type, "CLIENT_RASTER_SELECT_SPAWN");
  if (ok.type === "CLIENT_RASTER_SELECT_SPAWN") {
    assert.equal(ok.payload.x, 5);
    assert.equal(ok.payload.y, 7);
  }
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_SELECT_SPAWN", payload: { x: -1, y: 7 } }));
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_SELECT_SPAWN", payload: { x: 1.5, y: 7 } }));
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_SELECT_SPAWN", payload: {} }));
});
