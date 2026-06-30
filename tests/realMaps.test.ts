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

  // Union-find over landmasses (by land-component id). Two landmasses are
  // amphibiously connected when they touch the same body of water — a boat can
  // sail between them — so we union every land component bordering a given water
  // component. The largest union is the reach of an amphibious empire.
  const parent = new Map<number, number>();
  const ensure = (x: number): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: number): number => {
    ensure(x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: number, b: number): void => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };

  // Per landmass: its tile count, so we can size unions later.
  const compTiles = new Map<number, number>();
  for (let ref = 0; ref < map.size; ref += 1) {
    const lc = grid.landComponentId(ref);
    if (lc < 0) continue;
    ensure(lc);
    compTiles.set(lc, (compTiles.get(lc) ?? 0) + 1);
  }

  // Per water body: the land components it touches. Union them, and flag any
  // water that bridges two distinct landmasses (amphibious play has a target).
  const waterToLand = new Map<number, number>();
  let crossLandmassWater = 0;
  for (let ref = 0; ref < map.size; ref += 1) {
    const wc = grid.waterComponentId(ref);
    if (wc < 0) continue;
    for (const n of map.neighbors(ref)) {
      const lc = grid.landComponentId(n);
      if (lc < 0) continue;
      const seen = waterToLand.get(wc);
      if (seen === undefined) {
        waterToLand.set(wc, lc);
      } else if (find(seen) !== find(lc)) {
        crossLandmassWater += 1;
        union(seen, lc);
      }
    }
  }

  // Largest amphibiously-connected group, by total tiles.
  const groupTiles = new Map<number, number>();
  let largest = 0;
  for (const [lc, tiles] of compTiles) {
    const root = find(lc);
    const total = (groupTiles.get(root) ?? 0) + tiles;
    groupTiles.set(root, total);
    if (total > largest) largest = total;
  }

  assert.ok(grid.capturableCount > 0, "map should have capturable tiles");
  assert.ok(
    largest >= grid.capturableCount * 0.8,
    `largest amphibious group (${largest}) should cover most of ${grid.capturableCount} capturable tiles`,
  );
  assert.ok(crossLandmassWater > 0, "map should have water bridging landmasses for amphibious play");
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
