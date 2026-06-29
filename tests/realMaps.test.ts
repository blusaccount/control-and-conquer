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

test("the default map is largely connected under land + sea adjacency", () => {
  // A solo match needs most of the map reachable by land borders or amphibious
  // crossings so a winner can actually emerge; a few isolated micro-islands are
  // fine. Assert the largest reachable component covers a strong majority of the
  // capturable tiles, and that cross-landmass sea links exist at all (so the
  // amphibious mechanic has somewhere to fire).
  const map = buildRealMap(getRealMap(DEFAULT_REAL_MAP_ID)!);
  const grid = new TerritoryGrid(map);

  const seen = new Set<number>();
  let largest = 0;
  let crossLandmassSeaLinks = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (!grid.isCapturable(i) || seen.has(i)) continue;
    let count = 0;
    const stack = [i];
    seen.add(i);
    while (stack.length > 0) {
      const ref = stack.pop() as number;
      count += 1;
      for (const n of [...map.neighbors(ref), ...grid.seaLinks.neighborsOf(ref)]) {
        if (grid.isCapturable(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    if (count > largest) largest = count;
  }
  for (let a = 0; a < map.size; a += 1) {
    const compA = grid.landComponentId(a);
    if (compA < 0) continue;
    for (const b of grid.seaLinks.neighborsOf(a)) {
      if (grid.landComponentId(b) >= 0 && grid.landComponentId(b) !== compA) crossLandmassSeaLinks += 1;
    }
  }

  assert.ok(grid.capturableCount > 0, "map should have capturable tiles");
  assert.ok(
    largest >= grid.capturableCount * 0.8,
    `largest reachable component (${largest}) should cover most of ${grid.capturableCount} capturable tiles`,
  );
  assert.ok(crossLandmassSeaLinks > 0, "map should have cross-landmass sea links for amphibious play");
});

test("the World map has impassable mountains and crossable inland water", () => {
  const map = buildRealMap(getRealMap("world")!);
  let rock = 0;
  let shoreWater = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (map.isImpassable(i)) rock += 1;
    if (map.isWater(i) && map.isShore(i)) shoreWater += 1;
  }
  assert.ok(rock > 0, "expected impassable mountain tiles (Andes/Rockies/Himalaya)");
  // Rivers carve narrow shoreline water through the continents.
  assert.ok(shoreWater > 0, "expected shoreline/river water tiles");
});
