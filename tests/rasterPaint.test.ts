import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { encodeTile } from "../src/Core/terrainCodec.js";
import { createPixelBuffer, isBorderTile, paintRaster, paintTileInto } from "../src/Client/rasterPaint.js";
import { borderColor, terrainColor, tileColor } from "../src/Client/rasterPalette.js";

const land = (elevation: number): number =>
  encodeTile({ land: true, shoreline: false, ocean: false, magnitude: elevation });
const water = (depth: number): number =>
  encodeTile({ land: false, shoreline: false, ocean: true, magnitude: depth });

/** Read the RGBA at a tile ref out of a painted buffer. */
const pixelAt = (pixels: Uint8ClampedArray, ref: number) => ({
  r: pixels[ref * 4],
  g: pixels[ref * 4 + 1],
  b: pixels[ref * 4 + 2],
  a: pixels[ref * 4 + 3],
});

const expect = (color: { r: number; g: number; b: number; a: number }) => ({
  r: Math.round(color.r),
  g: Math.round(color.g),
  b: Math.round(color.b),
  a: color.a,
});

test("createPixelBuffer sizes the buffer to map.size * 4", () => {
  const map = new GameMap(5, 3);
  assert.equal(createPixelBuffer(map).length, 5 * 3 * 4);
});

test("paintRaster writes terrain and ownership in row-major order", () => {
  const terrain = new Uint8Array(3);
  terrain[0] = water(4);
  terrain[1] = land(0); // neutral grass
  terrain[2] = land(0); // owned by player 1
  const map = new GameMap(3, 1, terrain);
  const owner = new Uint16Array([0, 0, 1]);

  const pixels = createPixelBuffer(map);
  paintRaster(map, owner, pixels);

  assert.deepEqual(pixelAt(pixels, 0), expect(terrainColor(terrain[0])));
  assert.deepEqual(pixelAt(pixels, 1), expect(tileColor(terrain[1], 0)));
  // Tile 2 is owned and sits on its owner's edge (neutral neighbour), so it is
  // painted as a bright border rather than the interior ownership blend.
  assert.deepEqual(pixelAt(pixels, 2), expect(borderColor(1)));
  // Owned tile differs from the same neutral terrain.
  assert.notDeepEqual(pixelAt(pixels, 1), pixelAt(pixels, 2));
});

test("borders: interior tiles blend terrain, edge tiles get the outline", () => {
  // 5x1 line owned entirely by player 1, flanked by neutral land at both ends.
  // The two end tiles touch neutral ground -> borders; the middle tile is fully
  // enclosed by its own colour -> interior blend.
  const terrain = new Uint8Array(5).fill(land(0));
  const map = new GameMap(5, 1, terrain);
  const owner = new Uint16Array([0, 1, 1, 1, 0]);
  const pixels = createPixelBuffer(map);
  paintRaster(map, owner, pixels);

  assert.ok(!isBorderTile(map, owner, 2), "the enclosed middle tile is interior");
  assert.ok(isBorderTile(map, owner, 1) && isBorderTile(map, owner, 3), "the flanks are borders");
  assert.deepEqual(pixelAt(pixels, 2), expect(tileColor(land(0), 1)), "interior keeps the blend");
  assert.deepEqual(pixelAt(pixels, 1), expect(borderColor(1)), "edge gets the outline");
});

test("repainting a single tile via paintTileInto matches a full raster repaint", () => {
  // A delta repaint must reproduce what a from-scratch paint would draw, border
  // logic included, when the changed tile and its neighbours are all redrawn.
  const terrain = new Uint8Array(3).fill(land(0));
  const map = new GameMap(3, 1, terrain);
  const owner = new Uint16Array([1, 0, 0]);

  const full = createPixelBuffer(map);
  const incremental = createPixelBuffer(map);
  paintRaster(map, owner, incremental); // initial state

  // Tile 1 is captured by player 1; repaint it and its neighbours (0 and 2).
  owner[1] = 1;
  for (const ref of [0, 1, 2]) paintTileInto(map, owner, ref, incremental);
  paintRaster(map, owner, full);

  assert.deepEqual([...incremental], [...full]);
});

test("paintRaster rejects a mismatched pixel buffer or owner array", () => {
  const map = new GameMap(2, 2);
  const owner = new Uint16Array(map.size);
  assert.throws(() => paintRaster(map, owner, new Uint8ClampedArray(8)));
  assert.throws(() => paintRaster(map, new Uint16Array(2), createPixelBuffer(map)));
});

test("every painted pixel is fully opaque", () => {
  const terrain = new Uint8Array(4);
  terrain[0] = water(1);
  terrain[1] = water(10);
  terrain[2] = land(5);
  terrain[3] = land(30);
  const map = new GameMap(4, 1, terrain);
  const pixels = createPixelBuffer(map);
  paintRaster(map, new Uint16Array([0, 0, 1, 2]), pixels);
  for (let ref = 0; ref < map.size; ref += 1) {
    assert.equal(pixelAt(pixels, ref).a, 255);
  }
});
