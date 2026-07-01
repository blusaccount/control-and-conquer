import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";

test("every player starts with a single capital tile", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  session.subscribe("a", () => {});
  session.subscribe("b", () => {});
  const grid = session.peekGrid();
  assert.equal(grid.tileCountOf(1), 1, "player 1: just the capital");
  assert.equal(grid.tileCountOf(2), 1, "player 2: just the capital");
});

test("every player joins with identity modifiers (no classes or perks)", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  session.subscribe("p", () => {});
  assert.deepEqual(session.peekGrid().modifiersOf(1), IDENTITY_MODIFIERS);
});

test("a full session rejects a further subscribe without throwing", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const MAX_PLAYERS = 48;
  for (let i = 0; i < MAX_PLAYERS; i += 1) {
    assert.notEqual(session.subscribe(`p${i}`, () => {}), null, `seat ${i + 1} is free`);
  }
  assert.equal(session.subscribe("overflow", () => {}), null, "the 49th subscriber finds no seat");
});

test("validateCommand accepts a CLIENT_RASTER_JOIN with no fields", () => {
  const ok = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: {} });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  // A non-object payload is still rejected.
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: null }));
});

test("validateCommand accepts an optional map id and rejects an unknown one", () => {
  const ok = validateCommand({
    type: "CLIENT_RASTER_JOIN",
    payload: { mapId: "earth-huge" },
  });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  if (ok.type === "CLIENT_RASTER_JOIN") assert.equal(ok.payload.mapId, "earth-huge");
  // Unknown / removed maps are refused so the server never builds a bogus map.
  assert.throws(() =>
    validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { mapId: "mediterranean" } }),
  );
});
