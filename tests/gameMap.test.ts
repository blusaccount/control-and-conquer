import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { encodeTile } from "../src/Core/terrainCodec.js";

test("ref <-> (x, y) is a bijection across the whole grid", () => {
  const map = new GameMap(7, 5);
  const seen = new Set<number>();
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const ref = map.ref(x, y);
      assert.ok(!seen.has(ref), "refs must be unique");
      seen.add(ref);
      assert.equal(map.x(ref), x);
      assert.equal(map.y(ref), y);
    }
  }
  assert.equal(seen.size, map.size);
  assert.equal(map.size, 35);
});

test("neighbors are 4-connected and clamped at corners and edges", () => {
  const map = new GameMap(4, 3);

  // Corner: top-left has exactly 2 neighbours.
  const topLeft = map.neighbors(map.ref(0, 0)).sort((a, b) => a - b);
  assert.deepEqual(topLeft, [map.ref(1, 0), map.ref(0, 1)].sort((a, b) => a - b));

  // Corner: bottom-right has exactly 2 neighbours.
  assert.equal(map.neighbors(map.ref(3, 2)).length, 2);

  // Edge (non-corner): 3 neighbours.
  assert.equal(map.neighbors(map.ref(1, 0)).length, 3);

  // Interior: 4 neighbours.
  const interior = map.neighbors(map.ref(1, 1)).sort((a, b) => a - b);
  assert.deepEqual(
    interior,
    [map.ref(0, 1), map.ref(2, 1), map.ref(1, 0), map.ref(1, 2)].sort((a, b) => a - b),
  );
});

test("inBounds guards the rectangle", () => {
  const map = new GameMap(3, 2);
  assert.ok(map.inBounds(0, 0));
  assert.ok(map.inBounds(2, 1));
  assert.ok(!map.inBounds(-1, 0));
  assert.ok(!map.inBounds(3, 0));
  assert.ok(!map.inBounds(0, 2));
});

test("terrain predicates read through to the codec", () => {
  const terrain = new Uint8Array(2);
  terrain[0] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 12 });
  terrain[1] = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: 3 });
  const map = new GameMap(2, 1, terrain);

  const a = map.ref(0, 0);
  assert.ok(map.isLand(a));
  assert.ok(map.isShore(a));
  assert.equal(map.magnitude(a), 12);

  const b = map.ref(1, 0);
  assert.ok(map.isWater(b));
  assert.ok(map.isOcean(b));
  assert.equal(map.magnitude(b), 3);
});

test("constructor rejects bad dimensions and mismatched terrain length", () => {
  assert.throws(() => new GameMap(0, 4));
  assert.throws(() => new GameMap(4, 2.5));
  assert.throws(() => new GameMap(3, 3, new Uint8Array(8)));
});
