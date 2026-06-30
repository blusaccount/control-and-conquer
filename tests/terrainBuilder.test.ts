import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask, cleanupMask } from "../src/Core/terrainBuilder.js";

/** Count the land tiles in a mask. */
const landCount = (mask: Uint8Array): number => mask.reduce((n, v) => n + v, 0);

test("cleanupMask sinks islands below the threshold but keeps larger ones", () => {
  const width = 8;
  const height = 8;
  const mask = new Uint8Array(width * height); // all water

  // A lone 1-tile islet (should be sunk) ...
  mask[2 * width + 2] = 1;
  // ... and a solid 3x3 block of land = 9 tiles (should survive at threshold 4).
  for (let y = 4; y <= 6; y += 1) {
    for (let x = 4; x <= 6; x += 1) mask[y * width + x] = 1;
  }

  cleanupMask(width, height, mask, /*minIslandTiles*/ 4, /*minLakeTiles*/ 1);

  assert.equal(mask[2 * width + 2], 0, "the lone islet is sunk to water");
  assert.equal(landCount(mask), 9, "the 3x3 landmass is untouched");
});

test("cleanupMask fills tiny enclosed lakes but never open-ocean water", () => {
  const width = 7;
  const height = 7;
  const mask = new Uint8Array(width * height).fill(1); // all land
  // A single enclosed water tile in the middle (a pinprick lake).
  mask[3 * width + 3] = 0;

  cleanupMask(width, height, mask, /*minIslandTiles*/ 1, /*minLakeTiles*/ 2);
  assert.equal(mask[3 * width + 3], 1, "the enclosed pinprick lake is filled to land");

  // Border-touching water is open ocean and must never be filled, however small.
  const coastal = new Uint8Array(width * height).fill(1);
  coastal[0] = 0; // a corner water tile touches the border
  cleanupMask(width, height, coastal, 1, 999);
  assert.equal(coastal[0], 0, "border (ocean) water is preserved regardless of size");
});

test("buildTerrainFromMask still classifies a cleaned mask into coast/ocean", () => {
  const width = 6;
  const height = 6;
  const mask = new Uint8Array(width * height); // all water
  // One solid landmass so there is a coastline to classify.
  for (let y = 2; y <= 3; y += 1) {
    for (let x = 2; x <= 3; x += 1) mask[y * width + x] = 1;
  }
  const elevation = new Uint8Array(width * height).fill(5);
  const map = buildTerrainFromMask({ width, height, land: mask, elevation });

  let ocean = 0;
  let shore = 0;
  for (let i = 0; i < map.size; i += 1) {
    if (map.isOcean(i)) ocean += 1;
    if (map.isShore(i)) shore += 1;
  }
  assert.ok(ocean > 0, "border water floods to ocean");
  assert.ok(shore > 0, "the land/water boundary is marked as shoreline");
});
