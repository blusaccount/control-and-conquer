import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMap } from "../src/Core/mapLoader.js";
import { CONQUEROR_BASIN } from "../src/Core/maps/index.js";
import type { MapDefinition } from "../src/Core/types.js";

const twoTileMap = (): MapDefinition => ({
  name: "Pair",
  territories: [
    {
      id: "a",
      name: "Alpha",
      ownerId: "blue",
      troops: 5,
      neighbors: ["b"],
      polygon: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    },
    {
      id: "b",
      name: "Bravo",
      ownerId: "red",
      troops: 5,
      neighbors: ["a"],
      polygon: [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 10, y: 10 },
      ],
    },
  ],
});

test("loadMap accepts the built-in Conqueror Basin", () => {
  const map = loadMap(CONQUEROR_BASIN);
  assert.equal(map.name, "Conqueror Basin");
  assert.equal(map.territoryOrder.length, 8);
});

test("loadMap computes the centroid of each territory", () => {
  const map = loadMap(twoTileMap());
  assert.deepEqual(map.territories.a.center, { x: 5, y: 5 });
});

test("loadMap parses plain JSON (round-tripped) identically", () => {
  const fromJson = loadMap(JSON.parse(JSON.stringify(twoTileMap())));
  assert.equal(fromJson.territoryOrder.length, 2);
});

test("loadMap rejects a missing name", () => {
  const map = twoTileMap() as Record<string, unknown>;
  delete map.name;
  assert.throws(() => loadMap(map), /non-empty name/);
});

test("loadMap rejects duplicate territory ids", () => {
  const map = twoTileMap();
  map.territories[1].id = "a";
  assert.throws(() => loadMap(map), /duplicate territory id/);
});

test("loadMap rejects a neighbor that does not exist", () => {
  const map = twoTileMap();
  map.territories[0].neighbors = ["ghost"];
  assert.throws(() => loadMap(map), /unknown neighbor/);
});

test("loadMap rejects asymmetric adjacency", () => {
  const map = twoTileMap();
  map.territories[1].neighbors = []; // a -> b, but b no longer points back.
  assert.throws(() => loadMap(map), /not symmetric/);
});

test("loadMap rejects a self-referential neighbor", () => {
  const map = twoTileMap();
  map.territories[0].neighbors = ["a", "b"];
  assert.throws(() => loadMap(map), /lists itself/);
});

test("loadMap rejects polygons with fewer than three points", () => {
  const map = twoTileMap();
  map.territories[0].polygon = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
  assert.throws(() => loadMap(map), /at least 3 points/);
});

test("loadMap rejects an invalid ownerId", () => {
  const map = twoTileMap() as MapDefinition;
  (map.territories[0] as { ownerId: string }).ownerId = "green";
  assert.throws(() => loadMap(map), /invalid ownerId/);
});

test("loadMap rejects non-integer troop counts", () => {
  const map = twoTileMap();
  map.territories[0].troops = 3.5;
  assert.throws(() => loadMap(map), /integer troop count/);
});

test("loadMap rejects a map with fewer than two territories", () => {
  const map = twoTileMap();
  map.territories = [map.territories[0]];
  map.territories[0].neighbors = [];
  assert.throws(() => loadMap(map), /at least 2 territories/);
});
