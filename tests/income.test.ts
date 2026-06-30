import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { troopGrowth, maxTroops } from "../src/Core/rasterCombatConfig.js";

test("troopGrowth is a bell curve: grows from empty, fastest mid-range, zero at the cap", () => {
  const max = maxTroops(10); // some territory-scaled ceiling
  assert.equal(troopGrowth(max, max), 0, "no growth once the pool is at the cap");
  assert.equal(troopGrowth(max * 2, max), 0, "never negative past the cap");
  assert.ok(troopGrowth(0, max) > 0, "grows from an empty pool");
  // A mid-range pool adds more per tick than one nearly full (the (1 - t/max) term).
  assert.ok(
    troopGrowth(max * 0.4, max) > troopGrowth(max * 0.95, max),
    "growth tapers as the pool fills",
  );
});

test("maxTroops rises sub-linearly with land and flatly with cities", () => {
  // Doubling land lifts the ceiling by less than double (sub-linear land term).
  assert.ok(maxTroops(200) < maxTroops(100) * 2, "land term is sub-linear");
  // Each city adds a flat, fixed 250 000 on top. Use the tiles=0 cases so the
  // land term is the exact integer 2·50 000 and the city delta is exact.
  assert.equal(maxTroops(0, 1) - maxTroops(0, 0), 250_000, "one city adds a flat 250k");
  assert.equal(maxTroops(0, 2) - maxTroops(0, 0), 500_000, "cities stack linearly");
});

test("income approaches the cap asymptotically and never exceeds it", () => {
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
  const cap = maxTroops(tiles, 0);
  const conflict = new RasterConflict(grid);

  const sample = (ticks: number): number => {
    for (let i = 0; i < ticks; i += 1) conflict.processTick();
    return grid.troopsOf(1);
  };

  const earlyGain = sample(200); // grew from 0
  sample(200);
  const lateStart = sample(40_000); // advance well into saturation
  const late = sample(200);
  const lateGain = late - lateStart;

  assert.ok(grid.troopsOf(1) <= cap, "pool never exceeds the cap");
  assert.ok(grid.troopsOf(1) > 0.8 * cap, "pool climbs most of the way to the cap");
  assert.ok(lateGain < earlyGain, "growth tapers: a late window gains less than an early one");
});
