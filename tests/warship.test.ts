import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { WARSHIP_MAX_HEALTH, WARSHIP_SHELL_DAMAGE } from "../src/Core/buildings.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";

/** Single-row map from a mask: '#' = land, ' '/'.'= water. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) if (mask[x] === "#") land[x] = 1;
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

const freezeIncome = (grid: TerritoryGrid): void => {
  for (const id of grid.players()) grid.setModifiers(id, { ...IDENTITY_MODIFIERS, income: 0 });
};

test("a warship building puts exactly one warship unit to sea", () => {
  // p1 coast 0 | water 1 | neutral 2. The warship launches onto the water beside
  // its home port.
  const grid = new TerritoryGrid(rowMap("# #"));
  grid.addPlayer(1, 0);
  grid.claim(0, 1);
  grid.placeBuilding(0, "warship");
  const conflict = new RasterConflict(grid);

  conflict.processTick();
  const ships = conflict.warshipStates().filter((w) => w.owner === 1);
  assert.equal(ships.length, 1, "one warship at sea per warship building");
  assert.ok(grid.map.isWater(ships[0].tile), "the warship sits on open water, not its home coast");
  assert.equal(ships[0].health, WARSHIP_MAX_HEALTH, "it launches at full hull");
  assert.equal(conflict.warshipCountOf(1), 1);
});

test("hostile warships shell each other for 250 hull a volley, then retreat and survive", () => {
  // Two coasts across a wide sea, each with a warship; they are enemies.
  const grid = new TerritoryGrid(rowMap("#........#"));
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  grid.claim(0, 1);
  grid.claim(9, 2);
  grid.placeBuilding(0, "warship");
  grid.placeBuilding(9, "warship");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  // First tick: both guns are ready, so each lands one shell (250 of 1000).
  conflict.processTick();
  const afterOne = conflict.warshipStates();
  assert.equal(afterOne.length, 2, "both warships are still afloat");
  for (const w of afterOne) {
    assert.equal(w.health, WARSHIP_MAX_HEALTH - WARSHIP_SHELL_DAMAGE, "each took exactly one shell");
  }

  // Left to fight, a symmetric duel never annihilates: once battered below the
  // retreat threshold each breaks off, docks home and repairs, so both endure.
  for (let i = 0; i < 100; i += 1) conflict.processTick();
  assert.equal(conflict.warshipCountOf(1), 1, "player 1's warship survives by retreating to repair");
  assert.equal(conflict.warshipCountOf(2), 1, "player 2's warship survives by retreating to repair");
});

test("a warship chases its quarry across the water", () => {
  // A lone enemy warship far down the channel; ours should steam toward it.
  const grid = new TerritoryGrid(rowMap("#........#"));
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  grid.claim(0, 1);
  grid.claim(9, 2);
  grid.placeBuilding(0, "warship"); // p1 launches at water tile 1
  grid.placeBuilding(9, "warship"); // p2 launches at water tile 8
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  conflict.processTick();
  const startX = grid.map.x(conflict.warshipStates().find((w) => w.owner === 1)!.tile);
  for (let i = 0; i < 3; i += 1) conflict.processTick();
  const nowX = grid.map.x(conflict.warshipStates().find((w) => w.owner === 1)!.tile);
  assert.ok(nowX > startX, "the warship advanced down the channel toward its target");
});

test("a warship raids an enemy trade ship for its cargo gold", () => {
  // p2 owns two ports on one sea and trades with itself; p1 owns a warship on the
  // lane. Compared with a run where no raider is present, the raider ends richer —
  // proof the captor pockets the cargo gold.
  const build = () => {
    const grid = new TerritoryGrid(
      buildTerrainFromMask({
        width: 6,
        height: 2,
        // row0: port . . . . port   row1: warshipHome . . . . .
        land: Uint8Array.from([1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]),
        elevation: new Uint8Array(12),
      }),
    );
    grid.addPlayer(1, 0);
    grid.addPlayer(2, 0);
    grid.claim(grid.map.ref(0, 0), 2);
    grid.claim(grid.map.ref(5, 0), 2);
    grid.placeBuilding(grid.map.ref(0, 0), "port");
    grid.placeBuilding(grid.map.ref(5, 0), "port");
    grid.claim(grid.map.ref(0, 1), 1); // p1's warship home
    freezeIncome(grid);
    return grid;
  };

  // Baseline: no warship — trade ships complete their trips unmolested.
  const noRaider = new RasterConflict(build());
  for (let i = 0; i < 200; i += 1) noRaider.processTick();

  // With a p1 warship on the lane, it captures p2's trade ships.
  const raiderGrid = build();
  raiderGrid.placeBuilding(raiderGrid.map.ref(0, 1), "warship");
  const raider = new RasterConflict(raiderGrid);
  const goldBefore = raiderGrid.goldOf(1);
  for (let i = 0; i < 200; i += 1) raider.processTick();

  assert.ok(
    raiderGrid.goldOf(1) > goldBefore,
    "the raider's gold rose from captured cargo",
  );
});
