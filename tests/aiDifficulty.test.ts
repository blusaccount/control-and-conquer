import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import {
  BOT_GROWTH_MULTIPLIER,
  BOT_START_MANPOWER,
  BOT_TROOP_CAP_MULTIPLIER,
  NATION_START_MANPOWER,
  NATION_TROOP_CAP_MULTIPLIER,
  NATION_GROWTH_MULTIPLIER,
} from "../src/Server/botField.js";

const noop = (): void => {};

test("an easy AI nation is seated with OpenFront's per-difficulty handicaps", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "easy" });
  // Subscribe a Nation AI: headless, auto-spawn (positional flags).
  session.subscribe("bot-1", noop, true, false, undefined, "nation");
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), NATION_START_MANPOWER.easy, "easy AI starts with fewer troops");
  const mods = grid.modifiersOf(1);
  assert.equal(mods.troopCapMultiplier, NATION_TROOP_CAP_MULTIPLIER.easy, "easy AI has a lower population ceiling");
  assert.equal(mods.income, NATION_GROWTH_MULTIPLIER.easy, "easy AI grows a touch slower");
});

test("a hard Nation plays at full strength (= a human)", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "hard" });
  session.subscribe("bot-1", noop, true, false, undefined, "nation");
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), NATION_START_MANPOWER.hard, "hard Nation starts at the full 25,000");
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, 1, "hard Nation has the full ceiling");
  assert.equal(grid.modifiersOf(1).income, 1, "hard Nation grows at full rate");
});

test("a human player is always full strength, regardless of difficulty", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "easy" });
  // A human auto-spawn caller (kind defaults to "human"): never handicapped.
  session.subscribe("human", noop, true, false);
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), 25_000, "the human starts at the full 25,000 even on easy");
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, 1, "the human keeps the full ceiling");
  assert.equal(grid.modifiersOf(1).income, 1, "the human grows at full rate");
});

test("a Bot filler is seated with OpenFront's flat, difficulty-independent Tribe numbers", () => {
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty });
    session.subscribe("bot-1", noop, true, false, undefined, "bot");
    const grid = session.peekGrid();

    assert.equal(grid.troopsOf(1), BOT_START_MANPOWER, `a Bot always starts with ${BOT_START_MANPOWER}, regardless of difficulty`);
    assert.equal(grid.modifiersOf(1).troopCapMultiplier, BOT_TROOP_CAP_MULTIPLIER, "a Bot's ceiling is always the flat filler multiplier");
    assert.equal(grid.modifiersOf(1).income, BOT_GROWTH_MULTIPLIER, "a Bot's growth is always the flat filler multiplier");
  }
});

test("a Bot filler gets a two-word tribal name, distinct from the curated Nation names", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "medium" });
  const messages: Array<{ type: string; payload?: { name?: string } }> = [];
  session.subscribe("bot-1", (m) => messages.push(m as { type: string; payload?: { name?: string } }), true, false, undefined, "bot");

  const assigned = messages.find((m) => m.type === "SERVER_RASTER_PLAYER_ASSIGNED");
  const name = assigned?.payload?.name;
  assert.ok(name && /^\w+ \w+$/.test(name), "the Bot's name is two words");
});
