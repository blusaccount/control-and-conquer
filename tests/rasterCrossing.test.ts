import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict, type SeaCrossing } from "../src/Core/RasterConflict.js";
import {
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  SEA_CROSSING_SURCHARGE,
} from "../src/Core/rasterCombatConfig.js";

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

test("findSeaPath takes the shortest water route from the nearest owned coast", () => {
  // owned 0 | water 1 | neutral 2 (dest) | water 3,4 | owned 5.
  // Coast 0 is one water tile away; coast 5 is two — the path must use coast 0.
  const grid = new TerritoryGrid(rowMap("# #  #"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(5, 1);

  const path = grid.findSeaPath(1, 2);
  assert.deepEqual(path, [0, 1, 2], "embarkation→water→dest along the shorter crossing");

  // A landlocked / unreachable target yields null.
  assert.equal(grid.findSeaPath(1, 0), null, "own tile has no sea path");
});

test("a transport ship sails the strait, lands, and captures the far bank", () => {
  // owned 0,1 | water 2,3,4 (3-tile strait) | neutral 5,6.
  const grid = new TerritoryGrid(rowMap("##   ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  // The far bank is unreachable on land but reachable by ship.
  assert.ok(!grid.hasLandBorderWith(1, NEUTRAL_PLAYER), "no land border across the strait");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 50 }), null);
  assert.equal(grid.troopsOf(1), 0, "loaded troops leave the pool immediately");
  assert.equal(conflict.shipCountOf(1), 1, "one ship now at sea");

  // The ship is in flight before it arrives — its position is a water tile.
  conflict.processTick();
  const inFlight = conflict.activeShips();
  assert.equal(inFlight.length, 1);
  assert.ok(grid.map.isWater(inFlight[0].tile), "a sailing ship sits on open water");

  const crossings: SeaCrossing[] = [];
  for (let i = 0; i < 20; i += 1) crossings.push(...conflict.processTick().crossings);

  assert.equal(grid.ownerOf(5), 1, "the ship captured its beachhead");
  assert.equal(conflict.shipCountOf(1), 0, "the ship is consumed on landing");
  const landing = crossings.find((c) => c.to === 5);
  assert.ok(landing, "a landing onto tile 5 should be recorded");
  assert.equal(landing?.attacker, 1);
  assert.ok(grid.map.isWater(landing!.from), "the landing sets out from open water");
});

test("troops left after the beachhead push inland from the landing", () => {
  // owned 0,1 | water 2,3,4 | neutral 5,6,7,8 — a generous lander should keep
  // expanding past its beachhead.
  const grid = new TerritoryGrid(rowMap("##   ####"));
  grid.addPlayer(1, 80);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 80 }), null);
  for (let i = 0; i < 40; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(5), 1, "beachhead taken");
  assert.ok(grid.ownerOf(6) === 1 && grid.ownerOf(7) === 1, "survivors expand inland from the beachhead");
});

test("a ship too small to pay the beachhead cost is repelled and refunds its troops", () => {
  // A one-tile river: beachhead cost = base(1) + SEA_CROSSING_SURCHARGE.
  const grid = new TerritoryGrid(rowMap("## ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  const tooFew = SEA_CROSSING_SURCHARGE - 1; // can't afford to land
  assert.equal(conflict.launchShip({ attacker: 1, dest: 3, troops: tooFew }), null);
  for (let i = 0; i < 10; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(3), NEUTRAL_PLAYER, "the assault is repelled");
  assert.equal(grid.troopsOf(1), 50, "repelled troops fall back into the pool");
  assert.ok(SEA_CROSSING_SURCHARGE > 0);
});

test("a player may have at most three transport ships at sea", () => {
  // owned 0,1 | water 2,3,4 | islet 5 | water 6,7,8 | islet 9. Tile 5 is a lone
  // islet (no land neighbours), so a landing there can't spread inland — keeping
  // the board stable while we exercise the fleet cap.
  const grid = new TerritoryGrid(rowMap("##   #   #"));
  grid.addPlayer(1, 200);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  for (let i = 0; i < MAX_TRANSPORT_SHIPS_PER_PLAYER; i += 1) {
    assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 20 }), null, `ship ${i + 1} launches`);
  }
  assert.equal(conflict.shipCountOf(1), MAX_TRANSPORT_SHIPS_PER_PLAYER);
  // The fourth simultaneous launch is rejected.
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 20 }), "TOO_MANY_SHIPS");

  // Once the ships land (taking islet 5), every slot frees up again. Islet 9 is
  // now reachable by sea from the freshly-held coast at 5.
  for (let i = 0; i < 20; i += 1) conflict.processTick();
  assert.equal(grid.ownerOf(5), 1, "the fleet took its beachhead");
  assert.equal(conflict.shipCountOf(1), 0, "ships eventually land and free their slots");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 9, troops: 20 }), null, "a freed slot accepts a new ship");
});

test("water wider than the ship range cannot be crossed", () => {
  // 8 water tiles exceeds MAX_SEA_CROSSING_TILES (6).
  const grid = new TerritoryGrid(rowMap("##        ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(grid.findSeaPath(1, 10), null, "no route across too-wide water");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 10, troops: 30 }), "NO_FRONTIER");
});

test("a land attack never crosses water", () => {
  // owned 0,1 | water 2 | neutral 3,4: a plain land attack must not leap the river.
  const grid = new TerritoryGrid(rowMap("## ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 10 }), "NO_FRONTIER");
});
