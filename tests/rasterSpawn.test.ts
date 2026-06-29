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
  assert.equal(grid.tileCountOf(1), 1, "starts on the single chosen tile");
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

test("a spawn can only be chosen once", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9, maxDurationTicks: 999 });
  session.subscribe("human", () => {}, false);
  const map = session.peekMap();
  const a = firstNeutralLand(session);
  session.selectSpawn("human", map.x(a), map.y(a));
  const tiles = session.peekGrid().tileCountOf(1);
  // A second pick is ignored (already spawned).
  session.selectSpawn("human", map.x(a) + 1, map.y(a));
  assert.equal(session.peekGrid().tileCountOf(1), tiles, "second spawn pick is ignored");
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
