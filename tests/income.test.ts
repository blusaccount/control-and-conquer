import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { growthFactor, poolCap, MAX_POOL_PER_TILE } from "../src/Core/rasterCombatConfig.js";

test("growthFactor is 1 when empty, 0 at the cap, and eases in between", () => {
  const tiles = 4; // cap = 200
  assert.equal(growthFactor(0, tiles), 1);
  assert.equal(growthFactor(poolCap(tiles), tiles), 0);
  assert.equal(growthFactor(poolCap(tiles) / 2, tiles), 0.5);
  // Never negative past the cap.
  assert.equal(growthFactor(poolCap(tiles) * 2, tiles), 0);
});

test("income approaches the cap asymptotically and never exceeds it (soft cap)", () => {
  const width = 20;
  const map = buildTerrainFromMask({
    width,
    height: 1,
    land: new Uint8Array(width).fill(1),
    elevation: new Uint8Array(width),
  });
  const grid = new TerritoryGrid(map);
  grid.addPlayer(1, 0); // start empty so growth is visible
  // Own half, leave the rest neutral so the match isn't instantly "won" (which
  // would freeze the sim and stop income).
  for (let ref = 0; ref < 10; ref += 1) grid.claim(ref, 1);
  const tiles = grid.tileCountOf(1);
  const cap = tiles * MAX_POOL_PER_TILE;
  const conflict = new RasterConflict(grid);

  const sample = (ticks: number): number => {
    for (let i = 0; i < ticks; i += 1) conflict.processTick();
    return grid.troopsOf(1);
  };

  const early = sample(200);
  const earlyGain = early; // grew from 0
  const mid = sample(200);
  const lateStart = sample(4600); // advance well toward the cap
  const late = sample(200);
  const lateGain = late - lateStart;

  assert.ok(grid.troopsOf(1) <= cap, "pool never exceeds the cap");
  assert.ok(grid.troopsOf(1) > 0.8 * cap, "pool climbs most of the way to the cap");
  assert.ok(lateGain < earlyGain, "growth tapers: a late window gains less than an early one");
});
