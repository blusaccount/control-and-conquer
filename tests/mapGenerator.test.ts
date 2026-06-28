import assert from "node:assert/strict";
import { test } from "node:test";
import { generateGridMap } from "../src/Core/mapGenerator.js";
import { loadMap } from "../src/Core/mapLoader.js";

test("generateGridMap produces rows * cols territories", () => {
  const map = generateGridMap({ name: "Grid", rows: 4, cols: 5, width: 500, height: 400 });
  assert.equal(map.territories.length, 20);
});

test("generated grids always pass map validation (symmetric, valid neighbors)", () => {
  const map = generateGridMap({ name: "Grid", rows: 6, cols: 6, width: 760, height: 460 });
  const loaded = loadMap(map);
  assert.equal(loaded.territoryOrder.length, 36);
});

test("ownership is split left=blue / right=red", () => {
  const map = generateGridMap({ name: "Grid", rows: 2, cols: 4, width: 400, height: 200 });
  const owners = Object.fromEntries(map.territories.map((t) => [t.id, t.ownerId]));
  assert.equal(owners["r0c0"], "blue");
  assert.equal(owners["r0c1"], "blue");
  assert.equal(owners["r0c2"], "red");
  assert.equal(owners["r0c3"], "red");
});

test("generateGridMap rejects degenerate dimensions", () => {
  assert.throws(() => generateGridMap({ name: "Bad", rows: 0, cols: 4, width: 100, height: 100 }));
  assert.throws(() => generateGridMap({ name: "Bad", rows: 2, cols: 1, width: 100, height: 100 }));
});
