import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PLAYER_CLASS_IDS,
  classBonusStartingTiles,
  classModifiers,
  isPlayerClassId,
} from "../src/Core/playerClasses.js";
import { IDENTITY_MODIFIERS } from "../src/Core/perks.js";
import { MAX_SEA_CROSSING_TILES } from "../src/Core/rasterCombatConfig.js";

test("class modifiers match each class's design", () => {
  assert.deepEqual(classModifiers("imperialist"), IDENTITY_MODIFIERS);

  const admiral = classModifiers("admiral");
  assert.equal(admiral.seaSpeed, 2);
  // +2 tiles of range: round(base * seaRange) === base + 2.
  assert.equal(Math.round(MAX_SEA_CROSSING_TILES * admiral.seaRange), MAX_SEA_CROSSING_TILES + 2);

  const partisan = classModifiers("partisan");
  assert.equal(partisan.income, 1.4);
  assert.equal(partisan.expansionSpeed, 0.8);
});

test("only the Imperialist gets bonus starting tiles", () => {
  assert.equal(classBonusStartingTiles("imperialist"), 2);
  assert.equal(classBonusStartingTiles("admiral"), 0);
  assert.equal(classBonusStartingTiles("partisan"), 0);
});

test("no class (bots) yields identity modifiers and no bonus tiles", () => {
  assert.deepEqual(classModifiers(null), IDENTITY_MODIFIERS);
  assert.equal(classBonusStartingTiles(null), 0);
});

test("isPlayerClassId guards correctly", () => {
  assert.ok(ALL_PLAYER_CLASS_IDS.every(isPlayerClassId));
  assert.ok(!isPlayerClassId("warlord"));
  assert.ok(!isPlayerClassId(undefined));
});
