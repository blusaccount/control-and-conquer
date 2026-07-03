import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterDifficulty } from "../src/Core/messages.js";
import {
  BOT_GROWTH_MULTIPLIER,
  BOT_START_MANPOWER,
  BOT_TROOP_CAP_MULTIPLIER,
  NATION_START_MANPOWER,
  NATION_TROOP_CAP_MULTIPLIER,
  NATION_GROWTH_MULTIPLIER,
  NATION_CONFUSION_CHANCE,
  NATION_DECISION_TICKS,
  botDecisionCadence,
  buildFieldConfigs,
  nationDecisionCadence,
  scalePersonality,
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

test("an Impossible Nation is seated stronger than a human (OpenFront's 4th tier)", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "impossible" });
  session.subscribe("bot-1", noop, true, false, undefined, "nation");
  const grid = session.peekGrid();

  assert.equal(grid.troopsOf(1), 31_250, "Impossible starts a quarter above the human's 25,000");
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, 1.25, "Impossible outgrows the human ceiling");
  assert.equal(grid.modifiersOf(1).income, 1.05, "Impossible grows faster than full rate");
});

test("an Impossible Bot filler keeps its flat Tribe numbers (only Nations scale)", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9, difficulty: "impossible" });
  session.subscribe("bot-1", noop, true, false, undefined, "bot");
  const grid = session.peekGrid();
  assert.equal(grid.troopsOf(1), BOT_START_MANPOWER);
  assert.equal(grid.modifiersOf(1).troopCapMultiplier, BOT_TROOP_CAP_MULTIPLIER);
});

test("nation confusion shrinks with difficulty and vanishes on Impossible", () => {
  assert.equal(NATION_CONFUSION_CHANCE.easy, 0.1);
  assert.equal(NATION_CONFUSION_CHANCE.medium, 0.05);
  assert.equal(NATION_CONFUSION_CHANCE.hard, 0.025);
  assert.equal(NATION_CONFUSION_CHANCE.impossible, 0, "Impossible never misdirects");
});

test("nation decision cadence follows OpenFront's per-difficulty ranges", () => {
  // Every seat's cadence lands inside the difficulty's NationExecution range.
  for (const [difficulty, [lo, hi]] of Object.entries(NATION_DECISION_TICKS) as [RasterDifficulty, readonly [number, number]][]) {
    for (let seat = 0; seat < 50; seat += 1) {
      const c = nationDecisionCadence(difficulty, seat);
      assert.ok(c >= lo && c <= hi, `${difficulty} seat ${seat} cadence ${c} in [${lo},${hi}]`);
    }
  }
  // Impossible acts about twice as often as Easy (30–50 vs 65–100 ticks).
  assert.ok(NATION_DECISION_TICKS.impossible[1] < NATION_DECISION_TICKS.hard[1]);
  assert.ok(NATION_DECISION_TICKS.hard[1] < NATION_DECISION_TICKS.easy[0] + 1);
  assert.ok(NATION_DECISION_TICKS.impossible[1] * 2 <= NATION_DECISION_TICKS.easy[1]);
});

test("bot decision cadence follows OpenFront's nextInt(40, 80)", () => {
  for (let seat = 0; seat < 80; seat += 1) {
    const c = botDecisionCadence(seat);
    assert.ok(c >= 40 && c <= 80, `bot seat ${seat} cadence ${c} in [40,80]`);
  }
});

test("scalePersonality scales aggression by difficulty (cadence now comes from the seat)", () => {
  const base = { id: "t", decisionCooldownTicks: 60, minPool: 0, reserveFraction: 0, expandCommit: 1, attackCommit: 1, attackPoolRatio: 1, aggression: 0.5 };
  assert.ok(scalePersonality(base, "easy").aggression < base.aggression, "easy nations pick fewer fights");
  assert.ok(scalePersonality(base, "impossible").aggression > scalePersonality(base, "hard").aggression, "impossible presses hardest");
});

test("buildFieldConfigs is bot-heavy with per-seat cadence, phase and handicaps", () => {
  const configs = buildFieldConfigs(30, "hard", "m1");
  assert.equal(configs.length, 30);
  const nations = configs.filter((c) => c.kind === "nation");
  const bots = configs.filter((c) => c.kind === "bot");
  assert.ok(bots.length > nations.length * 3, "far more tribe fillers than nations");
  // Nations lead the seat order (they take the most-spread spawns).
  assert.equal(configs[0].kind, "nation");
  assert.equal(configs.at(-1)!.kind, "bot");
  for (const c of configs) {
    assert.ok((c.phaseOffset ?? 0) >= 0, "every seat gets a phase offset");
    if (c.kind === "nation") {
      assert.ok(c.personality.decisionCooldownTicks >= 45 && c.personality.decisionCooldownTicks <= 60, "hard nation cadence 45–60");
      assert.equal(c.confusionChance, NATION_CONFUSION_CHANCE.hard);
    } else {
      assert.ok(c.personality.decisionCooldownTicks >= 40 && c.personality.decisionCooldownTicks <= 80, "bot cadence 40–80");
      assert.equal(c.personality.attackCommit, 0.05, "bot attackAmount = troops/20");
      assert.equal(c.confusionChance, 0);
    }
  }
});
