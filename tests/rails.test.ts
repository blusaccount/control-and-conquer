import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid, type PlayerId } from "../src/Core/TerritoryGrid.js";
import { RailSystem } from "../src/Core/railSystem.js";
import { computeRailNetwork, type RailStation } from "../src/Core/railNetwork.js";
import {
  RAIL_CONNECT_DISTANCE,
  RAIL_MAX_CONNECTIONS,
  TRAIN_GOLD_PER_STATION,
  TRAIN_SPAWN_INTERVAL_TICKS,
} from "../src/Core/buildings.js";

/** An all-land `width`×`height` grid with every tile owned by `player`. */
const landGrid = (width: number, height: number, player: PlayerId): TerritoryGrid => {
  const map = buildTerrainFromMask({
    width,
    height,
    land: new Uint8Array(width * height).fill(1),
    elevation: new Uint8Array(width * height),
  });
  const grid = new TerritoryGrid(map);
  grid.addPlayer(player);
  for (let ref = 0; ref < map.size; ref += 1) grid.claim(ref, player);
  return grid;
};

const stationAt = (
  grid: TerritoryGrid,
  x: number,
  y: number,
  owner: PlayerId,
  type: RailStation["type"],
): RailStation => ({ ref: grid.map.ref(x, y), owner, type });

// --- network routing -------------------------------------------------------

test("a factory is required before any track is laid", () => {
  const grid = landGrid(60, 10, 1);
  // Two cities side by side, but no factory: OpenFront lays no rail.
  const noFactory = computeRailNetwork(grid.map, [
    stationAt(grid, 5, 5, 1, "city"),
    stationAt(grid, 15, 5, 1, "city"),
  ]);
  assert.equal(noFactory.edges.length, 0);

  // Add a factory near them and the network wires all three together.
  const withFactory = computeRailNetwork(grid.map, [
    stationAt(grid, 5, 5, 1, "city"),
    stationAt(grid, 15, 5, 1, "city"),
    stationAt(grid, 10, 5, 1, "factory"),
  ]);
  assert.ok(withFactory.edges.length >= 2, "factory links to both cities");
});

test("track is cardinal L-paths over land between linked stations", () => {
  const grid = landGrid(60, 30, 1);
  const network = computeRailNetwork(grid.map, [
    stationAt(grid, 10, 5, 1, "factory"),
    stationAt(grid, 25, 20, 1, "city"),
  ]);
  assert.equal(network.edges.length, 1);
  const edge = network.edges[0];
  // An L-path between non-aligned stations has exactly one bend (3 corners),
  // and each leg runs in a single cardinal direction.
  assert.equal(edge.corners.length, 3);
  const [a, corner, b] = edge.corners;
  const aligned = (p: number, q: number): boolean =>
    grid.map.x(p) === grid.map.x(q) || grid.map.y(p) === grid.map.y(q);
  assert.ok(aligned(a, corner) && aligned(corner, b), "both legs are cardinal");
});

test("links respect the maximum connection distance", () => {
  const grid = landGrid(RAIL_CONNECT_DISTANCE + 40, 10, 1);
  // Factory and city aligned but farther apart than the connect distance.
  const tooFar = computeRailNetwork(grid.map, [
    stationAt(grid, 2, 5, 1, "factory"),
    stationAt(grid, 2 + RAIL_CONNECT_DISTANCE + 5, 5, 1, "city"),
  ]);
  assert.equal(tooFar.edges.length, 0, "beyond range = no link");
});

test("each station anchors at most RAIL_MAX_CONNECTIONS links", () => {
  const grid = landGrid(40, 40, 1);
  // A factory hub ringed by more cities than it may connect to.
  const stations: RailStation[] = [stationAt(grid, 20, 20, 1, "factory")];
  const ring: Array<[number, number]> = [
    [20, 14], [20, 26], [14, 20], [26, 20], [16, 16], [24, 24], [16, 24], [24, 16],
  ];
  for (const [x, y] of ring) stations.push(stationAt(grid, x, y, 1, "city"));

  const network = computeRailNetwork(grid.map, stations);
  const hub = grid.map.ref(20, 20);
  const hubLinks = network.adjacency.get(hub)?.length ?? 0;
  assert.ok(hubLinks <= RAIL_MAX_CONNECTIONS, `hub has ${hubLinks} links`);
});

test("rails never link stations of different owners", () => {
  const grid = landGrid(40, 10, 1);
  const network = computeRailNetwork(grid.map, [
    stationAt(grid, 5, 5, 1, "factory"),
    stationAt(grid, 12, 5, 2, "city"), // a different player's city
  ]);
  assert.equal(network.edges.length, 0);
});

// --- train economy ---------------------------------------------------------

test("trains earn gold at cities and the run is deterministic", () => {
  const runGold = (): number => {
    const grid = landGrid(60, 10, 1);
    grid.setGold(1, 0);
    grid.placeBuilding(grid.map.ref(10, 5), "factory");
    grid.placeBuilding(grid.map.ref(25, 5), "city");
    const rails = new RailSystem(grid);
    assert.equal(rails.edgeCount, 0, "no network until first advance syncs stations");
    for (let tick = 0; tick < 200; tick += 1) rails.advance(tick);
    return grid.goldOf(1);
  };

  const goldA = runGold();
  assert.ok(goldA > 0, "a train paid out at the city");
  assert.equal(goldA % TRAIN_GOLD_PER_STATION, 0, "payouts come in whole-station units");
  // Same setup, same ticks → identical gold (no RNG anywhere).
  assert.equal(runGold(), goldA);
});

test("a factory with no reachable station spawns no paying trains", () => {
  const grid = landGrid(40, 10, 1);
  grid.setGold(1, 0);
  // Lone factory: nothing within range to link to.
  grid.placeBuilding(grid.map.ref(20, 5), "factory");
  const rails = new RailSystem(grid);
  for (let tick = 0; tick < TRAIN_SPAWN_INTERVAL_TICKS * 3; tick += 1) rails.advance(tick);
  assert.equal(rails.edgeCount, 0);
  assert.equal(rails.trainCount, 0);
  assert.equal(grid.goldOf(1), 0);
});
