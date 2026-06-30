import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";

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

test("a wide but connected sea still lands (no distance cap)", () => {
  // 8 open-water tiles — far past the old cap, but one connected body, so the
  // far shore is a valid landing.
  const grid = gridFromRows(["#........#"]);
  grid.addPlayer(1, 50);
  grid.claim(grid.map.ref(0, 0), 1);
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(9, 0)), grid.map.ref(9, 0));
});

test("a click toward a disconnected body routes to the nearest reachable shore", () => {
  // land0 | seaA(1) | land2 | seaB(3) | land4. The attacker on land0 touches only
  // seaA. land4 sits on the separate seaB, so a boat can't reach it directly
  // (findSeaPath is null); a click out there instead lands on seaA's reachable
  // shore (land2), the nearest one a boat can actually make.
  const grid = gridFromRows(["#.#.#"]);
  grid.addPlayer(1, 50);
  grid.claim(grid.map.ref(0, 0), 1);
  assert.equal(grid.findSeaPath(1, grid.map.ref(4, 0)), null, "land4 on seaB is directly unreachable");
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(4, 0)), grid.map.ref(2, 0), "routes to the reachable seaA shore");
});

test("a target across water is frontier (a boat target), never a land hop", () => {
  // col0 owned | col1 water | col2 neutral land — a separate landmass reachable
  // only by boat. Going fully OpenFront, the land frontier never crosses water,
  // but the boat target still surfaces so the AI can choose to sail there.
  const grid = gridFromRows(["#.#", "#.#", "#.#"]);
  grid.addPlayer(1, 50);
  for (let y = 0; y < 3; y += 1) grid.claim(grid.map.ref(0, y), 1);

  const here = grid.map.ref(0, 1);
  const farLand = grid.map.ref(2, 1);
  // Different landmasses: no land route exists between them.
  assert.notEqual(grid.landComponentId(here), grid.landComponentId(farLand));
  // The far coast is on the frontier as a boat target, and surfaces in the
  // per-owner summary the bots read.
  assert.ok(grid.frontierOf(1, NEUTRAL_PLAYER).includes(farLand), "boat target is on the frontier");
  const target = grid.frontierTargets(1).find((t) => t.target === NEUTRAL_PLAYER);
  assert.ok(target, "frontierTargets surfaces the neutral coast across the water");
  assert.equal(
    grid.landComponentId(target!.sample),
    grid.landComponentId(farLand),
    "its sample sits on the far landmass, reachable only by boat",
  );
});

test("a fully landlocked player can launch no boats", () => {
  // A 3x3 block of land with no water at all: no launch component exists.
  const grid = gridFromRows(["###", "###", "###"]);
  grid.addPlayer(1, 50);
  grid.claim(grid.map.ref(0, 0), 1);
  assert.equal(grid.resolveSeaLanding(1, grid.map.ref(2, 2)), null, "no water, no landing");
  assert.equal(grid.findSeaPath(1, grid.map.ref(2, 2)), null, "no water, no sea path");
});

test("a boat routes across a sea and up a river to an inland shore", () => {
  // col0 is the attacker's coast; col1 is a sea strip joined to a river that runs
  // inland along row 1 (cols 1..8). The far shore (9,1) sits at the river's head,
  // 8 water tiles away — well past the old cap. The path must sail the sea and
  // continue up the river to land there.
  const grid = gridFromRows([
    "#.########",
    "#........#",
    "#.########",
  ]);
  grid.addPlayer(1, 50);
  for (let y = 0; y < 3; y += 1) grid.claim(grid.map.ref(0, y), 1);

  const head = grid.map.ref(9, 1);
  const path = grid.findSeaPath(1, head);
  assert.ok(path, "a route exists up the river");
  assert.equal(path![0], grid.map.ref(0, 1), "embarks from the owned coast");
  assert.equal(path![path!.length - 1], head, "lands at the river head");
  // The route runs through mid-river water (proof it travelled up the river, not
  // a short hop), crossing more than the old 6-tile cap.
  assert.ok(path!.includes(grid.map.ref(5, 1)), "the path goes up the river");
  assert.ok(path!.length - 2 > 6, "more than 6 water tiles are crossed");
  // Clicking the river head resolves a boat landing straight to it.
  assert.equal(grid.resolveSeaLanding(1, head), head);
});
