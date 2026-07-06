import test from "node:test";
import assert from "node:assert/strict";
import { carveRivers, riverHalfWidthFor, type River } from "../src/Server/rivers.js";
import { loadEarthRivers } from "../src/Server/riverData.js";
import { buildHeightmapGameMap, getHeightmapMap } from "../src/Server/heightmapMaps.js";

test("riverHalfWidthFor keeps rivers single-tile until very high resolution", () => {
  // Like OpenFront, rivers stay thin (single-tile) at every normal grid size;
  // only very wide grids widen to a 3-tile channel so they don't sub-pixel away.
  assert.equal(riverHalfWidthFor(256), 0);
  assert.equal(riverHalfWidthFor(1024), 0);
  assert.equal(riverHalfWidthFor(2048), 0);
  assert.equal(riverHalfWidthFor(2400), 1);
  assert.equal(riverHalfWidthFor(4096), 1);
});

test("carveRivers stamps a continuous water channel into a land mask", () => {
  const width = 360;
  const height = 180;
  const land = new Uint8Array(width * height).fill(1);
  const elevation = new Uint8Array(width * height).fill(10);
  const rivers: River[] = [{ points: [[-20, 10], [0, 0], [20, -10]] }];

  carveRivers({ width, height, land, elevation, latMax: 90, latMin: -90, rivers, halfWidth: 0 });

  const tx = (lon: number) => Math.round(((lon + 180) / 360) * width);
  const ty = (lat: number) => Math.round(((90 - lat) / 180) * height);
  for (const [lon, lat] of [[-20, 10], [0, 0], [20, -10]] as const) {
    const i = ty(lat) * width + tx(lon);
    assert.equal(land[i], 0, `(${lon},${lat}) should be carved to water`);
    assert.equal(elevation[i], 0, `(${lon},${lat}) elevation should be reset`);
  }
  // The midpoint of the first segment is carved too — no gaps.
  assert.equal(land[ty(5) * width + tx(-10)], 0, "segment midpoint should be carved");
});

test("carveRivers does not extend mouths by default", () => {
  const width = 360;
  const height = 180;
  const land = new Uint8Array(width * height).fill(1);
  const elevation = new Uint8Array(width * height).fill(10);
  carveRivers({
    width,
    height,
    land,
    elevation,
    latMax: 90,
    latMin: -90,
    rivers: [{ points: [[0, 0], [1, 0]] }],
    halfWidth: 0,
  });
  const water = land.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
  // Just the two-tile channel, with no offshore extension toward a far coast.
  assert.ok(water > 0 && water <= 3, `single short channel, got ${water} water tiles`);
});

test("carveRivers extends mouths to the sea when asked", () => {
  const width = 360;
  const height = 180;
  const land = new Uint8Array(width * height).fill(1);
  const elevation = new Uint8Array(width * height).fill(10);
  // Pre-existing sea a few tiles east of the mouth.
  const tx = (lon: number) => Math.round(((lon + 180) / 360) * width);
  const ty = (lat: number) => Math.round(((90 - lat) / 180) * height);
  for (let x = tx(3); x < width; x += 1) land[ty(0) * width + x] = 0;
  const before = land.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);

  carveRivers({
    width,
    height,
    land,
    elevation,
    latMax: 90,
    latMin: -90,
    rivers: [{ points: [[0, 0], [1, 0]] }],
    halfWidth: 0,
    extendMouths: true,
  });
  const added = land.reduce((n, v) => n + (v === 0 ? 1 : 0), 0) - before;
  // Channel bridged the short gap to the coast: a few tiles, not the whole map.
  assert.ok(added > 1 && added < 20, `mouth bridged to coast, got ${added} new tiles`);
});

test("the committed earth river asset is the curated strategic set", () => {
  const rivers = loadEarthRivers();
  // A curated whitelist of strategic river systems — not the full Natural
  // Earth dump (~900 polylines), which made rivers read as noise.
  assert.ok(
    rivers.length >= 100 && rivers.length <= 400,
    `curated polyline count, got ${rivers.length}`,
  );
  for (const r of rivers) {
    assert.ok(r.name && r.name.length > 0, "every polyline carries its system name");
    assert.ok(r.points.length >= 2, "every river has at least two points");
  }
  const systems = new Set(rivers.map((r) => r.name));
  assert.ok(systems.size >= 15 && systems.size <= 40, `strategic system count, got ${systems.size}`);
  for (const expected of [
    "Nile",
    "Rhine",
    "Danube",
    "Volga",
    "Mississippi",
    "Amazon",
    "Yangtze",
    "Ganges",
    "Great Lakes",
  ]) {
    assert.ok(systems.has(expected), `curated set should include the ${expected}`);
  }
});

test("real rivers appear as mostly ocean-connected water on the earth map", () => {
  const def = getHeightmapMap("earth")!;
  const withRivers = buildHeightmapGameMap(def, 1024);
  const withoutRivers = buildHeightmapGameMap({ ...def, id: "earth-no-river", rivers: false }, 1024);

  let added = 0;
  let addedOcean = 0;
  for (let i = 0; i < withRivers.size; i += 1) {
    if (withRivers.isWater(i) && !withoutRivers.isWater(i)) {
      added += 1;
      if (withRivers.isOcean(i)) addedOcean += 1;
    }
  }
  // Carving rivers adds a substantial amount of water...
  assert.ok(added > 2000, `rivers should add plenty of water, got ${added}`);
  // ...and because Natural Earth centerlines reach the coast, most of it
  // connects to the open sea rather than forming isolated lakes.
  assert.ok(addedOcean > added * 0.7, `most river water should be ocean, got ${addedOcean}/${added}`);
});

test("rivers are deterministic", () => {
  const def = getHeightmapMap("earth")!;
  const a = buildHeightmapGameMap(def, 512);
  const b = buildHeightmapGameMap(def, 512);
  for (let i = 0; i < a.terrain.length; i += 1) {
    if (a.terrain[i] !== b.terrain[i]) throw new Error(`terrain differs at ${i}`);
  }
});
