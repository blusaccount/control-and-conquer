import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { SeaLinks } from "../src/Core/seaLinks.js";

/**
 * Build a single-row map from a land mask string: '#' = land, ' ' = water.
 * Coast/depth flags are computed by the shared finishing pipeline.
 */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    if (mask[x] === "#") {
      land[x] = 1;
      elevation[x] = 0;
    }
  }
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

test("links two coasts separated by water within range", () => {
  // land 0,1 ; water 2..6 (5 tiles) ; land 7,8.
  const m = rowMap("##     ##");
  const links6 = SeaLinks.build(m, 6);
  assert.ok(links6.areLinked(1, 7), "x1 should link to x7 across 5 water tiles at range 6");
  assert.ok(links6.areLinked(7, 1), "links are symmetric");
  assert.ok(links6.neighborsOf(1).includes(7));
  // Interior, non-shore land has no crossings.
  assert.deepEqual(links6.neighborsOf(0), []);
});

test("does not link coasts beyond the crossing range", () => {
  const m = rowMap("##     ##"); // 5 water tiles between banks
  const links4 = SeaLinks.build(m, 4);
  assert.ok(!links4.areLinked(1, 7), "5-tile gap is too wide for range 4");
  assert.deepEqual(links4.neighborsOf(1), []);
});

test("range 0 disables all crossings", () => {
  const m = rowMap("## ##");
  const links = SeaLinks.build(m, 0);
  assert.deepEqual(links.neighborsOf(1), []);
  assert.ok(!links.areLinked(1, 3));
});

test("adjacent banks across a one-tile river are linked", () => {
  const m = rowMap("## ##"); // single water tile (a river) between x1 and x3
  const links = SeaLinks.build(m, 6);
  assert.ok(links.areLinked(1, 3), "a one-tile river should be crossable");
});
