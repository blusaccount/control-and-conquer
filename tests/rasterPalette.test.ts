import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PLAYER_PALETTE,
  playerColor,
  terrainColor,
  tileColor,
} from "../src/Client/rasterPalette.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import { encodeTile, IMPASSABLE_MAGNITUDE } from "../src/Core/terrainCodec.js";

const land = (elevation: number, shoreline = false): number =>
  encodeTile({ land: true, shoreline, ocean: false, magnitude: elevation });
const water = (depth: number, ocean: boolean): number =>
  encodeTile({ land: false, shoreline: false, ocean, magnitude: depth });

test("water is bluish and gets darker with depth", () => {
  const shallow = terrainColor(water(1, true));
  const deep = terrainColor(water(12, true));
  assert.ok(shallow.b > shallow.r, "water should be blue-dominant");
  // Deeper water is darker (lower blue channel here) than shallow water.
  assert.ok(deep.b < shallow.b, "deep water should be darker than shallow");
  assert.equal(shallow.a, 255);
});

test("land runs green plains → tan highland → pale mountain with elevation", () => {
  const plains = terrainColor(land(2));
  const highland = terrainColor(land(15));
  const mountain = terrainColor(land(28));
  assert.ok(plains.g > plains.r && plains.g > plains.b, "plains should be green-dominant");
  // Highland is a brighter tan than plains (all channels lift toward sand).
  assert.ok(highland.r > plains.r, "highland should be lighter/tanner than plains");
  // Mountains brighten toward a near-grey-white snowcap.
  assert.ok(mountain.r > highland.r && mountain.g > 200 && mountain.b > 200, "mountains pale toward white");
});

test("impassable rock is grey regardless of elevation bits", () => {
  const rock = terrainColor(land(IMPASSABLE_MAGNITUDE));
  assert.ok(Math.abs(rock.r - rock.g) < 12 && Math.abs(rock.g - rock.b) < 12, "rock should be near-grey");
});

test("ocean and lake of equal depth render identically (water colour ignores type)", () => {
  // OpenFront colours water purely by shore distance and the shoreline flag, not
  // by the ocean/lake bit, so an inland lake and the open sea look the same.
  const ocean = terrainColor(water(6, true));
  const lake = terrainColor(water(6, false));
  assert.deepEqual(ocean, lake);
});

const shoreWater = (ocean: boolean): number =>
  encodeTile({ land: false, shoreline: true, ocean, magnitude: 1 });

test("shoreline water is a light coastal blue; open water darkens with depth", () => {
  const shore = terrainColor(shoreWater(true));
  const deep = terrainColor(water(12, true));
  assert.ok(
    shore.r > deep.r && shore.g > deep.g && shore.b > deep.b,
    "shoreline water is lighter than deep water",
  );
  assert.ok(shore.b > shore.r, "shoreline water is still blue-dominant");
});

test("a 1-tile river (shoreline water) shares the coastal colour, ocean or lake", () => {
  // A carved river is a single tile of water touching land on every side, so it
  // is shoreline water and reads as the same light coastal blue as the sea edge
  // — no separate, glaring river colour.
  const riverTile = terrainColor(shoreWater(false));
  const seaEdge = terrainColor(shoreWater(true));
  assert.deepEqual(riverTile, seaEdge);
});

test("playerColor wraps the palette for ids beyond its length", () => {
  assert.deepEqual(playerColor(1), { ...DEFAULT_PLAYER_PALETTE[0] });
  const wrapped = DEFAULT_PLAYER_PALETTE.length + 1;
  assert.deepEqual(playerColor(wrapped), { ...DEFAULT_PLAYER_PALETTE[0] });
});

test("tileColor washes owner colour over land but leaves neutral terrain and water alone", () => {
  const grassByte = land(0);
  const neutral = tileColor(grassByte, NEUTRAL_PLAYER);
  assert.deepEqual(neutral, terrainColor(grassByte));

  const owned = tileColor(grassByte, 2); // red player
  assert.notDeepEqual(owned, neutral);
  assert.ok(owned.r > neutral.r, "red owner should raise the red channel over grass");

  // Owning water is meaningless; it must keep its natural colour.
  const waterByte = water(3, true);
  assert.deepEqual(tileColor(waterByte, 2), terrainColor(waterByte));
});
