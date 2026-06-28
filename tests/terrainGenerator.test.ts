import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { generateTerrain } from "../src/Core/terrainGenerator.js";
import { decodeTile } from "../src/Core/terrainCodec.js";

/**
 * Label the 4-connected components of `predicate`-matching tiles and return one
 * `{ size, touchesBorder }` record per component. Used to assert the generator's
 * speckle-cleanup invariants.
 */
const components = (
  map: GameMap,
  predicate: (ref: number) => boolean,
): Array<{ size: number; touchesBorder: boolean }> => {
  const labels = new Int32Array(map.size).fill(-1);
  const out: Array<{ size: number; touchesBorder: boolean }> = [];
  for (let start = 0; start < map.size; start += 1) {
    if (!predicate(start) || labels[start] >= 0) continue;
    const id = out.length;
    labels[start] = id;
    const stack = [start];
    let size = 0;
    let touchesBorder = false;
    while (stack.length > 0) {
      const ref = stack.pop() as number;
      size += 1;
      const x = map.x(ref);
      const y = map.y(ref);
      if (x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1) {
        touchesBorder = true;
      }
      for (const n of map.neighbors(ref)) {
        if (predicate(n) && labels[n] < 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    out.push({ size, touchesBorder });
  }
  return out;
};

test("same seed yields byte-for-byte identical terrain (determinism)", () => {
  const a = generateTerrain({ width: 48, height: 48, seed: 1234 });
  const b = generateTerrain({ width: 48, height: 48, seed: 1234 });
  assert.deepEqual(Array.from(a.terrain), Array.from(b.terrain));
});

test("different seeds produce different terrain", () => {
  const a = generateTerrain({ width: 48, height: 48, seed: 1 });
  const b = generateTerrain({ width: 48, height: 48, seed: 2 });
  assert.notDeepEqual(Array.from(a.terrain), Array.from(b.terrain));
});

test("produces a plausible mix of land and water", () => {
  const map = generateTerrain({ width: 64, height: 64, seed: 42 });
  let land = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (map.isLand(i)) land += 1;
  }
  const fraction = land / map.size;
  assert.ok(fraction > 0.02 && fraction < 0.98, `land fraction ${fraction} is implausible`);
});

test("coastline invariants: shore land borders water, shore water borders land", () => {
  const map = generateTerrain({ width: 64, height: 64, seed: 7 });
  for (let i = 0; i < map.size; i += 1) {
    if (!map.isShore(i)) continue;
    const neighbors = map.neighbors(i);
    if (map.isLand(i)) {
      assert.ok(neighbors.some((n) => map.isWater(n)), `shore land tile ${i} must border water`);
    } else {
      assert.ok(neighbors.some((n) => map.isLand(n)), `shore water tile ${i} must border land`);
    }
  }
});

test("water magnitude invariants: shore water depth is 1, all water depth >= 1 near coast", () => {
  const map = generateTerrain({ width: 64, height: 64, seed: 42 });
  let sawShoreWater = false;
  for (let i = 0; i < map.size; i += 1) {
    if (!map.isWater(i)) continue;
    const bordersLand = map.neighbors(i).some((n) => map.isLand(n));
    if (bordersLand) {
      sawShoreWater = true;
      assert.equal(map.magnitude(i), 1, `water tile ${i} adjacent to land must have depth 1`);
      assert.ok(map.isShore(i), `water tile ${i} adjacent to land must be marked shore`);
    }
  }
  assert.ok(sawShoreWater, "expected at least one shoreline water tile");
});

test("ocean reaches the border; enclosed water is classified as lake", () => {
  // seaLevel below 0.5 with no edge falloff yields plenty of land + lakes.
  const map = generateTerrain({ width: 96, height: 96, seed: 7, seaLevel: 0.42, edgeFalloff: false });
  for (let i = 0; i < map.size; i += 1) {
    const { land, ocean } = decodeTile(map.terrain[i]);
    if (!land && !ocean) {
      // A lake tile must not sit on the map border (border water is ocean).
      const x = map.x(i);
      const y = map.y(i);
      assert.ok(
        x !== 0 && y !== 0 && x !== map.width - 1 && y !== map.height - 1,
        `lake tile ${i} should not touch the border`,
      );
    }
  }
  // Sanity: this configuration is expected to contain at least one lake.
  const lakes = components(map, (ref) => map.isWater(ref) && !map.isOcean(ref));
  assert.ok(lakes.length > 0, "expected enclosed lakes for this configuration");
});

test("cleanup removes speckle: no tiny land islands and no tiny enclosed lakes", () => {
  const minIslandTiles = 12;
  const minLakeTiles = 6;
  const map = generateTerrain({
    width: 96,
    height: 96,
    seed: 7,
    seaLevel: 0.42,
    edgeFalloff: false,
    minIslandTiles,
    minLakeTiles,
  });

  for (const land of components(map, (ref) => map.isLand(ref))) {
    assert.ok(land.size >= minIslandTiles, `land island of size ${land.size} should have been sunk`);
  }
  for (const lake of components(map, (ref) => map.isWater(ref) && !map.isOcean(ref))) {
    // Enclosed lakes never touch the border by construction.
    assert.ok(!lake.touchesBorder);
    assert.ok(lake.size >= minLakeTiles, `enclosed lake of size ${lake.size} should have been filled`);
  }
});

test("rejects degenerate dimensions", () => {
  assert.throws(() => generateTerrain({ width: 0, height: 10, seed: 1 }));
  assert.throws(() => generateTerrain({ width: 10, height: -1, seed: 1 }));
});
