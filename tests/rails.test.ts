import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid, type PlayerId } from "../src/Core/TerritoryGrid.js";
import { RailSystem } from "../src/Core/railSystem.js";
import { computeRailNetwork, type RailStation } from "../src/Core/railNetwork.js";
import {
  RAIL_STATION_MAX_RANGE,
  TRAIN_GOLD_SELF_BASE,
  TRAIN_GOLD_FLOOR,
  trainGold,
  trainSpawnRate,
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
  const grid = landGrid(80, 60, 1);
  // Two cities (>=15 tiles apart, OpenFront's station spacing), but no factory:
  // OpenFront lays no rail without the factory catalyst.
  const noFactory = computeRailNetwork(grid.map, [
    stationAt(grid, 20, 20, 1, "city"),
    stationAt(grid, 45, 20, 1, "city"),
  ]);
  assert.equal(noFactory.edges.length, 0);

  // Add a factory near them and the network wires them together.
  const withFactory = computeRailNetwork(grid.map, [
    stationAt(grid, 20, 20, 1, "city"),
    stationAt(grid, 45, 20, 1, "city"),
    stationAt(grid, 20, 45, 1, "factory"),
  ]);
  assert.ok(withFactory.edges.length >= 2, "the factory catalyses links to the cities");
});

test("track is a cardinal A* path over land between linked stations", () => {
  const grid = landGrid(80, 60, 1);
  const network = computeRailNetwork(grid.map, [
    stationAt(grid, 10, 5, 1, "factory"),
    stationAt(grid, 30, 25, 1, "city"),
  ]);
  assert.equal(network.edges.length, 1);
  const edge = network.edges[0];
  // Over open land the A* route (direction-change penalty) is a single-bend L:
  // 3 corners, each leg a single cardinal direction.
  assert.equal(edge.corners.length, 3);
  const aligned = (p: number, q: number): boolean =>
    grid.map.x(p) === grid.map.x(q) || grid.map.y(p) === grid.map.y(q);
  for (let i = 1; i < edge.corners.length; i += 1) {
    assert.ok(aligned(edge.corners[i - 1], edge.corners[i]), "each leg is cardinal");
  }
});

test("A* routes track around impassable rock (a straight L-path would fail)", () => {
  // 40x13 land with a vertical wall of impassable rock at x=20 blocking the
  // direct line between two aligned stations, except for a gap at the bottom.
  const W = 40;
  const H = 13;
  const land = new Uint8Array(W * H).fill(1);
  const elevation = new Uint8Array(W * H);
  for (let y = 0; y < H - 1; y += 1) elevation[y * W + 20] = 31; // rock wall, gap at y=H-1
  const map = buildTerrainFromMask({ width: W, height: H, land, elevation });
  const grid = new TerritoryGrid(map);
  grid.addPlayer(1);
  for (let ref = 0; ref < map.size; ref += 1) if (!map.isImpassable(ref)) grid.claim(ref, 1);

  const network = computeRailNetwork(map, [
    stationAt(grid, 5, 3, 1, "factory"),
    stationAt(grid, 35, 3, 1, "city"),
  ]);
  assert.equal(network.edges.length, 1, "A* finds a detour around the wall");
  const edge = network.edges[0];
  // The detour bends more than a single L, and no corner sits on rock.
  assert.ok(edge.corners.length > 3, "the route bends around the wall");
  for (const ref of edge.corners) assert.equal(map.isImpassable(ref), false, "track never crosses rock");
});

test("links respect OpenFront's station range (min and max)", () => {
  const grid = landGrid(RAIL_STATION_MAX_RANGE + 40, 20, 1);
  // Factory and city aligned but farther apart than the max station range.
  const tooFar = computeRailNetwork(grid.map, [
    stationAt(grid, 2, 10, 1, "factory"),
    stationAt(grid, 2 + RAIL_STATION_MAX_RANGE + 5, 10, 1, "city"),
  ]);
  assert.equal(tooFar.edges.length, 0, "beyond the max range = no link");

  // Comfortably within range they link.
  const inRange = computeRailNetwork(grid.map, [
    stationAt(grid, 2, 10, 1, "factory"),
    stationAt(grid, 2 + RAIL_STATION_MAX_RANGE - 10, 10, 1, "city"),
  ]);
  assert.equal(inRange.edges.length, 1, "within the max range they link");
});

test("the network is a spanning tree (with junctions), not a dense mesh", () => {
  const grid = landGrid(120, 120, 1);
  // A factory hub ringed by 8 cities, all within range of the hub AND of their
  // ring neighbours. A full mesh would lay a link for every in-range pair (well
  // over a dozen criss-crossing tracks). OpenFront instead grows a spanning tree,
  // tapping existing track at junctions — so the graph over all nodes (stations
  // plus any junctions) is connected and acyclic (edges == nodes − 1), and every
  // station is reachable from the hub, with no redundant parallel track.
  const stations: RailStation[] = [stationAt(grid, 60, 60, 1, "factory")];
  const ring: Array<[number, number]> = [
    [60, 40], [60, 80], [40, 60], [80, 60], [42, 42], [78, 78], [42, 78], [78, 42],
  ];
  for (const [x, y] of ring) stations.push(stationAt(grid, x, y, 1, "city"));

  const network = computeRailNetwork(grid.map, stations);

  // Collect every node (stations + grafted junctions) and confirm a tree: a
  // connected graph with exactly nodes − 1 edges has no redundant links.
  const nodeSet = new Set<number>();
  for (const e of network.edges) {
    nodeSet.add(e.a);
    nodeSet.add(e.b);
  }
  assert.equal(network.edges.length, nodeSet.size - 1, "connected & acyclic: a spanning tree");
  assert.ok(network.edges.length < 20, "far fewer links than a full every-pair mesh");

  // Every station is reachable from the hub through the network.
  const hub = grid.map.ref(60, 60);
  const seen = new Set<number>([hub]);
  const queue: number[] = [hub];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const nb of network.adjacency.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  for (const s of stations) assert.ok(seen.has(s.ref), "every station reachable from the hub");
});

test("a station taps existing track at a T-junction, not a long parallel line", () => {
  const grid = landGrid(100, 40, 1);
  // A long straight track between a factory and a city (processed first, lower
  // refs), then a city sitting just off the *middle* of that track. Rather than
  // run a long line all the way back to the factory or the far city, it should
  // tap the existing track at the nearest point — a T-junction — like OpenFront.
  const factory = grid.map.ref(5, 10);
  const farCity = grid.map.ref(95, 10);
  const midCity = grid.map.ref(50, 25); // 15 tiles below the track's midpoint
  const network = computeRailNetwork(grid.map, [
    stationAt(grid, 5, 10, 1, "factory"),
    stationAt(grid, 95, 10, 1, "city"),
    stationAt(grid, 50, 25, 1, "city"),
  ]);

  // Splitting the trunk at the tap point yields three edges over four nodes.
  assert.equal(network.edges.length, 3, "trunk split in two + the tap = 3 edges");
  const nodeSet = new Set<number>();
  for (const e of network.edges) {
    nodeSet.add(e.a);
    nodeSet.add(e.b);
  }
  assert.equal(nodeSet.size, 4, "three stations + one junction node");

  // The extra node is a junction on the trunk (here the tile directly above the
  // mid city), and the mid city connects straight to it — a short cardinal tap.
  const junction = grid.map.ref(50, 10);
  assert.ok(nodeSet.has(junction) && ![factory, farCity, midCity].includes(junction), "a junction was grafted");
  assert.ok(
    (network.adjacency.get(midCity) ?? []).includes(junction),
    "the mid city taps the trunk at the junction, not the distant stations",
  );
  assert.ok(!(network.adjacency.get(midCity) ?? []).some((n) => n === factory || n === farCity),
    "no long parallel track back to a distant station");
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
    // A single factory launches a train every trainSpawnRate(1) = 165 ticks, so
    // run well past the first spawn to bank at least one city payout.
    for (let tick = 0; tick < 400; tick += 1) rails.advance(tick);
    return grid.goldOf(1);
  };

  const goldA = runGold();
  assert.ok(goldA > 0, "a train paid out at the city");
  assert.equal(goldA % TRAIN_GOLD_SELF_BASE, 0, "payouts come in whole-station units");
  // Same setup, same ticks → identical gold (no RNG anywhere).
  assert.equal(runGold(), goldA);
});

test("a factory with no reachable station spawns no paying trains", () => {
  const grid = landGrid(40, 10, 1);
  grid.setGold(1, 0);
  // Lone factory: nothing within range to link to.
  grid.placeBuilding(grid.map.ref(20, 5), "factory");
  const rails = new RailSystem(grid);
  for (let tick = 0; tick < 200; tick += 1) rails.advance(tick);
  assert.equal(rails.edgeCount, 0);
  assert.equal(rails.trainCount, 0);
  assert.equal(grid.goldOf(1), 0);
});

test("trainGold pays the self base, then decays per stop to a floor (OpenFront)", () => {
  // First ~10 stops pay full; each stop beyond drops 5000, floored at 5000.
  assert.equal(trainGold(0), TRAIN_GOLD_SELF_BASE, "the first stop pays the full self base");
  assert.equal(trainGold(9), TRAIN_GOLD_SELF_BASE, "still full at the last free stop");
  assert.equal(trainGold(10), TRAIN_GOLD_SELF_BASE - 5_000, "one stop past free costs 5000");
  assert.equal(trainGold(11), TRAIN_GOLD_FLOOR, "and it bottoms out at the floor");
  assert.equal(trainGold(50), TRAIN_GOLD_FLOOR, "never below the floor");
});

test("trainSpawnRate: more factories means each launches less often (OpenFront)", () => {
  assert.equal(trainSpawnRate(1), (1 + 10) * 15, "one factory → (1+10)·15 = 165");
  assert.equal(trainSpawnRate(0), 150);
  assert.ok(trainSpawnRate(5) > trainSpawnRate(1), "the shared spawn budget slows each factory");
});
