import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REAL_MAPS,
  buildRealMap,
  getRealMap,
  DEFAULT_REAL_MAP_ID,
} from "../src/Core/realMaps.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";

test("every real map builds into valid terrain with land and water", () => {
  for (const [id, def] of REAL_MAPS) {
    const map = buildRealMap(def);
    assert.equal(map.width, def.width);
    assert.equal(map.height, def.height);
    let land = 0;
    let water = 0;
    for (let i = 0; i < map.size; i += 1) {
      if (map.isLand(i)) land += 1;
      else water += 1;
    }
    assert.ok(land > 0, `map ${id} should have land`);
    assert.ok(water > 0, `map ${id} should have water`);
  }
});

test("getRealMap resolves known ids and rejects unknown ones", () => {
  assert.ok(getRealMap(DEFAULT_REAL_MAP_ID));
  assert.equal(getRealMap("does-not-exist"), undefined);
});

test("the default map is fully connected under land + sea adjacency", () => {
  // Every capturable tile must be reachable from any other by land borders or
  // amphibious crossings — otherwise a solo match could never produce a winner.
  const map = buildRealMap(getRealMap(DEFAULT_REAL_MAP_ID)!);
  const grid = new TerritoryGrid(map);

  let start = -1;
  for (let i = 0; i < map.size; i += 1) {
    if (grid.isCapturable(i)) {
      start = i;
      break;
    }
  }
  assert.ok(start >= 0, "map should have at least one capturable tile");

  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const ref = stack.pop() as number;
    for (const n of [...map.neighbors(ref), ...grid.seaLinks.neighborsOf(ref)]) {
      if (grid.isCapturable(n) && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  assert.equal(seen.size, grid.capturableCount, "all capturable tiles must be reachable");
});

test("the Mediterranean has impassable mountains and crossable inland water", () => {
  const map = buildRealMap(getRealMap("mediterranean")!);
  let rock = 0;
  let shoreWater = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (map.isImpassable(i)) rock += 1;
    if (map.isWater(i) && map.isShore(i)) shoreWater += 1;
  }
  assert.ok(rock > 0, "expected impassable mountain tiles (Alps/Atlas)");
  // Rivers carve narrow shoreline water through the continents.
  assert.ok(shoreWater > 0, "expected shoreline/river water tiles");
});
