import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict, type SeaCrossing } from "../src/Core/RasterConflict.js";
import { SEA_CROSSING_SURCHARGE } from "../src/Core/rasterCombatConfig.js";

/** Single-row map from a mask: '#' = land, ' ' = water. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    if (mask[x] === "#") land[x] = 1;
  }
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

test("expansion lands across a narrow strait and records the crossing", () => {
  // land 0,1 | water 2,3,4 (3-tile strait) | land 5,6
  const grid = new TerritoryGrid(rowMap("##   ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  // The far bank is only reachable by sea — there is no land frontier.
  assert.ok(grid.hasFrontier(1, NEUTRAL_PLAYER), "sea link should expose a frontier");
  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 50 }), null);

  const crossings: SeaCrossing[] = [];
  for (let i = 0; i < 20; i += 1) {
    crossings.push(...conflict.processTick().crossings);
  }

  assert.equal(grid.ownerOf(5), 1, "far bank tile should be captured by sea");
  const landing = crossings.find((c) => c.to === 5);
  assert.ok(landing, "a crossing onto tile 5 should be recorded");
  assert.equal(landing?.attacker, 1);
  assert.ok([0, 1].includes(landing!.from), "crossing originates from the near coast");
});

test("crossing a river is costlier than a land push at the same commitment", () => {
  // A small commitment that comfortably conquers neutral land...
  const landGrid = new TerritoryGrid(rowMap("###"));
  landGrid.addPlayer(1, 50);
  landGrid.claim(0, 1);
  const landConflict = new RasterConflict(landGrid);
  landConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 8 });
  for (let i = 0; i < 20; i += 1) landConflict.processTick();
  assert.equal(landGrid.ownerOf(1), 1, "8 troops easily take adjacent land");

  // ...is not enough to pay the surcharge to land across a one-tile river.
  const seaGrid = new TerritoryGrid(rowMap("## ##"));
  seaGrid.addPlayer(1, 50);
  seaGrid.claim(0, 1);
  seaGrid.claim(1, 1);
  const seaConflict = new RasterConflict(seaGrid);
  seaConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 8 });
  for (let i = 0; i < 20; i += 1) seaConflict.processTick();
  assert.equal(seaGrid.ownerOf(3), NEUTRAL_PLAYER, "8 troops cannot pay the sea surcharge");
  assert.ok(SEA_CROSSING_SURCHARGE > 0);
});

test("a strait wider than the crossing range cannot be crossed", () => {
  // 8 water tiles exceeds MAX_SEA_CROSSING_TILES (6).
  const grid = new TerritoryGrid(rowMap("##        ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.ok(!grid.hasFrontier(1, NEUTRAL_PLAYER), "no frontier across too-wide water");
  assert.equal(
    conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 10 }),
    "NO_FRONTIER",
  );
});
