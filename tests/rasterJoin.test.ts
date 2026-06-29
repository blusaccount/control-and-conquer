import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { modifiersForPerks, IDENTITY_MODIFIERS } from "../src/Core/perks.js";
import { classModifiers } from "../src/Core/playerClasses.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

type Snap = Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }>;

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  const snaps = messages.filter((m): m is Snap => m.type === "SERVER_RASTER_SNAPSHOT");
  return snaps[snaps.length - 1].payload;
};

test("the Imperialist starts with three tiles, the others with one", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  session.subscribe("imp", () => {}, "imperialist");
  session.subscribe("adm", () => {}, "admiral");
  const grid = session.peekGrid();
  assert.equal(grid.tileCountOf(1), 3, "imperialist: capital + 2 bonus tiles");
  assert.equal(grid.tileCountOf(2), 1, "admiral: just the capital");
});

test("class base modifiers are applied on join", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  session.subscribe("partisan", () => {}, "partisan");
  assert.deepEqual(session.peekGrid().modifiersOf(1), classModifiers("partisan"));
});

test("a bot (no class) joins with identity modifiers", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  session.subscribe("bot", () => {});
  assert.deepEqual(session.peekGrid().modifiersOf(1), IDENTITY_MODIFIERS);
});

test("perks fold on top of the class base", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3, perkIntervalTicks: 2 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("p", (m) => messages.push(m), "partisan");
  // Reach a round that offers growth-driver, then choose it.
  session.tick();
  session.tick();
  session.tick();
  session.tick();
  const offers = messages.filter((m) => m.type === "SERVER_PERK_OFFER");
  assert.ok(offers.length > 0);
  session.choosePerk("p", "growth-driver");

  const expected = modifiersForPerks(["growth-driver"], classModifiers("partisan"));
  assert.deepEqual(session.peekGrid().modifiersOf(1), expected);
  // Partisan 1.4 * growth 1.3 = 1.82.
  assert.ok(Math.abs(session.peekGrid().modifiersOf(1).income - 1.82) < 1e-9);
});

test("validateCommand accepts a well-formed CLIENT_RASTER_JOIN and rejects bad classes", () => {
  const ok = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { playerClass: "admiral" } });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { playerClass: "warlord" } }));
  assert.throws(() => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: {} }));
});

test("validateCommand accepts an optional map id and rejects an unknown one", () => {
  const ok = validateCommand({
    type: "CLIENT_RASTER_JOIN",
    payload: { playerClass: "admiral", mapId: "earth-huge" },
  });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  if (ok.type === "CLIENT_RASTER_JOIN") assert.equal(ok.payload.mapId, "earth-huge");
  // Unknown / removed maps are refused so the server never builds a bogus map.
  assert.throws(() =>
    validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { playerClass: "admiral", mapId: "mediterranean" } }),
  );
});
