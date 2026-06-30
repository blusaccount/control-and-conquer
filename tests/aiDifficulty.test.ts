import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import {
  NATION_START_MANPOWER,
  NATION_TROOP_CAP_MULTIPLIER,
  NATION_GROWTH_MULTIPLIER,
} from "../src/Server/botField.js";

const noop = (): void => {};

test("an easy AI nation is seated with OpenFront's per-difficulty handicaps", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "easy" });
  // Subscribe a bot: headless, auto-spawn, isBot=true (positional flags).
  session.subscribe("bot-1", noop, true, false, undefined, true);
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), NATION_START_MANPOWER.easy, "easy AI starts with fewer troops");
  const mods = grid.modifiersOf(1);
  assert.equal(mods.troopCapMultiplier, NATION_TROOP_CAP_MULTIPLIER.easy, "easy AI has a lower population ceiling");
  assert.equal(mods.income, NATION_GROWTH_MULTIPLIER.easy, "easy AI grows a touch slower");
});

test("a hard AI nation plays at full strength (= a human)", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "hard" });
  session.subscribe("bot-1", noop, true, false, undefined, true);
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), NATION_START_MANPOWER.hard, "hard AI starts at the full 25,000");
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, 1, "hard AI has the full ceiling");
  assert.equal(grid.modifiersOf(1).income, 1, "hard AI grows at full rate");
});

test("a non-bot player is always full strength, regardless of difficulty", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "easy" });
  // A non-bot auto-spawn caller (isBot defaults to false): the human is never handicapped.
  session.subscribe("human", noop, true, false);
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), 25_000, "the human starts at the full 25,000 even on easy");
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, 1, "the human keeps the full ceiling");
  assert.equal(grid.modifiersOf(1).income, 1, "the human grows at full rate");
});
