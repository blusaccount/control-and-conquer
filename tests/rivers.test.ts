import test from "node:test";
import assert from "node:assert/strict";
import { carveRivers, riverHalfWidthFor, WORLD_RIVERS, type River } from "../src/Server/rivers.js";
import { buildHeightmapGameMap, getHeightmapMap } from "../src/Server/heightmapMaps.js";

test("riverHalfWidthFor scales the brush with grid width", () => {
  assert.equal(riverHalfWidthFor(256), 0);
  assert.equal(riverHalfWidthFor(1024), 1);
  assert.equal(riverHalfWidthFor(2048), 2);
});

test("carveRivers stamps a continuous water channel into a land mask", () => {
  const width = 360;
  const height = 180;
  const land = new Uint8Array(width * height).fill(1);
  const elevation = new Uint8Array(width * height).fill(10);
  // A single river crossing the equator, well inside the crop.
  const rivers: River[] = [{ name: "Test", points: [[-20, 10], [0, 0], [20, -10]] }];

  carveRivers({ width, height, land, elevation, latMax: 90, latMin: -90, rivers, halfWidth: 0 });

  // The endpoints map to known tiles; both must now be water with reset elevation.
  const tx = (lon: number) => Math.round(((lon + 180) / 360) * width);
  const ty = (lat: number) => Math.round(((90 - lat) / 180) * height);
  for (const [lon, lat] of [[-20, 10], [0, 0], [20, -10]] as const) {
    const i = ty(lat) * width + tx(lon);
    assert.equal(land[i], 0, `(${lon},${lat}) should be carved to water`);
    assert.equal(elevation[i], 0, `(${lon},${lat}) elevation should be reset`);
  }

  // The channel is connected: no land tile sits between consecutive carved
  // samples. Verify by checking the midpoint of the first segment is water too.
  const midI = ty(5) * width + tx(-10);
  assert.equal(land[midI], 0, "segment midpoint should be carved");
});

test("carveRivers only touches the carved channel, not the whole map", () => {
  const width = 360;
  const height = 180;
  const land = new Uint8Array(width * height).fill(1);
  const elevation = new Uint8Array(width * height).fill(10);
  // Pre-existing sea just east of the mouth so the mouth-extension stops there
  // instead of running to its cap.
  const tx = (lon: number) => Math.round(((lon + 180) / 360) * width);
  const ty = (lat: number) => Math.round(((90 - lat) / 180) * height);
  for (let x = tx(3); x < width; x += 1) land[ty(0) * width + x] = 0;
  const seaBefore = land.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);

  carveRivers({
    width,
    height,
    land,
    elevation,
    latMax: 90,
    latMin: -90,
    rivers: [{ name: "Tiny", points: [[0, 0], [1, 0]] }],
    halfWidth: 0,
  });
  const added = land.reduce((n, v) => n + (v === 0 ? 1 : 0), 0) - seaBefore;
  // A short channel that reaches the coast a few tiles away — not the whole map.
  assert.ok(added > 0 && added < 20, `only a short channel carved, got ${added} new water tiles`);
});

test("WORLD_RIVERS appear as ocean-connected water on the earth map", () => {
  const def = getHeightmapMap("earth")!;
  const withRivers = buildHeightmapGameMap(def, 1024);
  // Same map without rivers, to isolate their effect.
  const withoutRivers = buildHeightmapGameMap({ ...def, id: "earth-no-river", rivers: false }, 1024);

  let waterWith = 0;
  let waterWithout = 0;
  for (let i = 0; i < withRivers.size; i += 1) {
    if (withRivers.isWater(i)) waterWith += 1;
    if (withoutRivers.isWater(i)) waterWithout += 1;
  }
  // Carving rivers strictly adds water.
  assert.ok(waterWith > waterWithout, "rivers should add water tiles");

  // A mid-river tile of the Amazon (~60°W, 5°S) should be water and, because the
  // river is traced out into the Atlantic, classified as open ocean. (Rivers
  // ending in an enclosed basin like the Nile→Mediterranean stay lakes, which is
  // correct — at this resolution the Strait of Gibraltar is closed.)
  const lon2tx = (lon: number) => Math.round(((lon + 180) / 360) * withRivers.width);
  const lat2ty = (lat: number) =>
    Math.round(((def.latMax - lat) / (def.latMax - def.latMin)) * withRivers.height);
  const amazon = lat2ty(-5) * withRivers.width + lon2tx(-60);
  assert.ok(withRivers.isWater(amazon), "the Amazon channel should be water");
  assert.ok(withRivers.isOcean(amazon), "a sea-reaching river should be open ocean");
});

test("rivers are deterministic", () => {
  const def = getHeightmapMap("earth")!;
  const a = buildHeightmapGameMap(def, 512);
  const b = buildHeightmapGameMap(def, 512);
  for (let i = 0; i < a.terrain.length; i += 1) {
    if (a.terrain[i] !== b.terrain[i]) throw new Error(`terrain differs at ${i}`);
  }
});
