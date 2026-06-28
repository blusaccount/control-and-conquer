import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { encodeTile, IMPASSABLE_MAGNITUDE } from "../src/Core/terrainCodec.js";

/** Build a flat all-land map of the given size (elevation 0). */
const flatLand = (width: number, height: number, elevation = 0): GameMap => {
  const terrain = new Uint8Array(width * height);
  const byte = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: elevation });
  terrain.fill(byte);
  return new GameMap(width, height, terrain);
};

const WATER = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: 3 });
const ROCK = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: IMPASSABLE_MAGNITUDE });

test("capturableCount counts only passable land", () => {
  const terrain = new Uint8Array(4);
  terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  terrain[1] = WATER;
  terrain[2] = ROCK;
  terrain[3] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 5 });
  const grid = new TerritoryGrid(new GameMap(4, 1, terrain));
  assert.equal(grid.capturableCount, 2);
  assert.ok(grid.isCapturable(0));
  assert.ok(!grid.isCapturable(1));
  assert.ok(!grid.isCapturable(2));
  assert.ok(grid.isCapturable(3));
});

test("addPlayer validates ids and rejects duplicates", () => {
  const grid = new TerritoryGrid(flatLand(2, 2));
  grid.addPlayer(1, 10);
  assert.ok(grid.hasPlayer(1));
  assert.throws(() => grid.addPlayer(1));
  assert.throws(() => grid.addPlayer(NEUTRAL_PLAYER));
  assert.throws(() => grid.addPlayer(-3));
  assert.throws(() => grid.addPlayer(2, -1));
});

test("claim transfers ownership and keeps tile counts in sync", () => {
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1);
  grid.addPlayer(2);

  grid.claim(0, 1);
  grid.claim(1, 1);
  assert.equal(grid.tileCountOf(1), 2);
  assert.equal(grid.ownerOf(0), 1);

  // Reassigning a tile moves the count from the old owner to the new one.
  grid.claim(1, 2);
  assert.equal(grid.tileCountOf(1), 1);
  assert.equal(grid.tileCountOf(2), 1);
  assert.equal(grid.ownerOf(1), 2);

  // Releasing back to neutral only decrements.
  grid.claim(0, NEUTRAL_PLAYER);
  assert.equal(grid.tileCountOf(1), 0);
  assert.equal(grid.ownerOf(0), NEUTRAL_PLAYER);
});

test("claim throws on non-capturable terrain", () => {
  const terrain = new Uint8Array(2);
  terrain[0] = WATER;
  terrain[1] = ROCK;
  const grid = new TerritoryGrid(new GameMap(2, 1, terrain));
  grid.addPlayer(1);
  assert.throws(() => grid.claim(0, 1));
  assert.throws(() => grid.claim(1, 1));
});

test("frontierOf / hasFrontier find capturable target tiles adjacent to the attacker", () => {
  // 3x1 land: player 1 owns tile 0, tiles 1 and 2 are neutral.
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1);
  grid.claim(0, 1);

  // Only tile 1 borders the attacker; tile 2 is one ring further out.
  assert.deepEqual(grid.frontierOf(1, NEUTRAL_PLAYER), [1]);
  assert.ok(grid.hasFrontier(1, NEUTRAL_PLAYER));

  // No frontier against a player that does not border the attacker.
  grid.addPlayer(2);
  grid.claim(2, 2);
  assert.ok(!grid.hasFrontier(1, 2));
  assert.deepEqual(grid.frontierOf(1, 2), []);
});
