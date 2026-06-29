import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";

/** Build a TerritoryGrid from rows of '#' (land) / '.' (water). */
const gridFromRows = (rows: string[]): TerritoryGrid => {
  const height = rows.length;
  const width = rows[0].length;
  const land = new Uint8Array(width * height);
  const elevation = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rows[y][x] === "#") land[y * width + x] = 1;
    }
  }
  return new TerritoryGrid(buildTerrainFromMask({ width, height, land, elevation }));
};

test("a click on a far landmass's interior resolves to its nearest reachable shore", () => {
  // x0 owned | x1 water | x2,x3 a 2-wide neutral landmass.
  const grid = gridFromRows(["#.##", "#.##", "#.##", "#.##", "#.##"]);
  grid.addPlayer(1, 50);
  for (let y = 0; y < 5; y += 1) grid.claim(grid.map.ref(0, y), 1);

  const interior = grid.map.ref(3, 2);
  // The interior tile is not itself sea-reachable (no bordering water)...
  assert.equal(grid.findSeaPath(1, interior), null, "interior tile has no direct sea path");
  // ...but clicking it still lands the boat on the landmass's near shore.
  const landing = grid.resolveSeaLanding(1, interior);
  assert.equal(landing, grid.map.ref(2, 2), "boat routes to the nearest reachable shore");
  assert.notEqual(grid.findSeaPath(1, landing!), null, "the chosen landing is a valid sea destination");
});

test("the landing is the reachable shore nearest the click", () => {
  // x0 owned | x1 water | x2 a 1-wide neutral coast (every cell a shore).
  const grid = gridFromRows(["#.#", "#.#", "#.#", "#.#", "#.#"]);
  grid.addPlayer(1, 50);
  for (let y = 0; y < 5; y += 1) grid.claim(grid.map.ref(0, y), 1);

  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(2, 0)), grid.map.ref(2, 0), "click near top → top shore");
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(2, 4)), grid.map.ref(2, 4), "click near bottom → bottom shore");
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(2, 2)), grid.map.ref(2, 2), "click in the middle → middle shore");
});

test("a wide ocean is still crossable — there is no maximum width", () => {
  // 8 open-water tiles separate the coasts; like OpenFront's transport ships, a
  // boat sails the whole span rather than hitting a hard reachability wall.
  const grid = gridFromRows(["#........#"]);
  grid.addPlayer(1, 50);
  grid.claim(grid.map.ref(0, 0), 1);

  const landing = grid.resolveSeaLanding(1, grid.map.ref(9, 0));
  assert.equal(landing, grid.map.ref(9, 0), "the far shore across 8 water tiles is reachable");
  assert.notEqual(grid.findSeaPath(1, landing!), null, "and a concrete water route exists to it");
});

test("a coast with no sea route to any other land yields null", () => {
  // The player's island sits alone in open water — a boat has nowhere to land
  // however far it sails, so no landing resolves.
  const grid = gridFromRows([".....", ".###.", ".###.", ".###.", "....."]);
  grid.addPlayer(1, 50);
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) grid.claim(grid.map.ref(x, y), 1);
  }
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(0, 0)), null, "no other shore exists to land on");
});
