import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMapById } from "../src/Server/mapRepository.js";

test("loadMapById loads the frontline-grid JSON file from disk", () => {
  const map = loadMapById("frontline-grid");
  assert.equal(map.name, "Frontline Grid");
  assert.equal(map.territoryOrder.length, 36);
});

test("loadMapById falls back to a built-in map when no JSON file exists", () => {
  const map = loadMapById("conqueror-basin");
  assert.equal(map.name, "Conqueror Basin");
  assert.equal(map.territoryOrder.length, 8);
});

test("loadMapById throws for an unknown map id", () => {
  assert.throws(() => loadMapById("no-such-map"), /Unknown map id/);
});
