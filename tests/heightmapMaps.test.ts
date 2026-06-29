import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeightmapGameMap,
  getHeightmapMap,
  resolveHeightmapSize,
  HEIGHTMAP_MAP_IDS,
} from "../src/Server/heightmapMaps.js";

test("the earth heightmap map is registered", () => {
  assert.ok(HEIGHTMAP_MAP_IDS.includes("earth"));
  const def = getHeightmapMap("earth");
  assert.ok(def);
  assert.equal(getHeightmapMap("nope"), undefined);
});

test("resolveHeightmapSize derives an even, geographically-proportioned size", () => {
  const def = getHeightmapMap("earth")!;
  const a = resolveHeightmapSize(def, 1000);
  assert.equal(a.width % 2, 0);
  assert.equal(a.height % 2, 0);
  // Latitude band is narrower than 180°, so height is well under half the width.
  assert.ok(a.height < a.width / 2);
  // Clamping keeps absurd requests in range.
  assert.ok(resolveHeightmapSize(def, 99999).width <= 4096);
  assert.ok(resolveHeightmapSize(def, 1).width >= 64);
});

test("buildHeightmapGameMap produces real land, ocean and impassable mountains", () => {
  const def = getHeightmapMap("earth")!;
  const map = buildHeightmapGameMap(def, 256);

  let land = 0;
  let ocean = 0;
  let impassable = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (map.isLand(i)) {
      land += 1;
      if (map.isImpassable(i)) impassable += 1;
    } else if (map.isOcean(i)) {
      ocean += 1;
    }
  }
  // A real world map is mostly ocean with a substantial minority of land.
  assert.ok(land > map.size * 0.15, "should have plenty of land");
  assert.ok(ocean > map.size * 0.4, "should be ocean-dominated");
  assert.ok(impassable > 0, "high ground becomes impassable mountains");
});

test("buildHeightmapGameMap is deterministic for a given size", () => {
  const def = getHeightmapMap("earth")!;
  const a = buildHeightmapGameMap(def, 200);
  const b = buildHeightmapGameMap(def, 200);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  for (let i = 0; i < a.terrain.length; i += 1) {
    if (a.terrain[i] !== b.terrain[i]) throw new Error(`terrain differs at ${i}`);
  }
});

test("a RasterGameSession runs on the earth heightmap map", async () => {
  const { RasterGameSession } = await import("../src/Server/RasterGameSession.js");
  const session = new RasterGameSession({ realMapId: "earth", mapSize: 128 });
  session.subscribe("human", () => {});
  session.tick();
  const map = session.peekMap();
  assert.ok(map.width >= 64, "earth map built at the requested size");
  assert.equal(session.peekGrid().owner.length, map.size);
});
