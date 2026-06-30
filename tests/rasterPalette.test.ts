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

test("land is greenish at low elevation and shifts toward brown when higher", () => {
  const low = terrainColor(land(0));
  const high = terrainColor(land(30));
  assert.ok(low.g > low.r && low.g > low.b, "lowland should be green-dominant");
  assert.ok(high.r > low.r, "highland should be redder/browner than lowland");
});

test("impassable rock is grey regardless of elevation bits", () => {
  const rock = terrainColor(land(IMPASSABLE_MAGNITUDE));
  assert.ok(Math.abs(rock.r - rock.g) < 12 && Math.abs(rock.g - rock.b) < 12, "rock should be near-grey");
});

test("ocean and lake of equal depth render differently", () => {
  const ocean = terrainColor(water(6, true));
  const lake = terrainColor(water(6, false));
  assert.notDeepEqual(ocean, lake);
});

test("shallow inland water (rivers/lakes) is muted, not a bright glow", () => {
  // A 1-tile carved river is shoreline water: depth 1, non-ocean. It must read
  // far darker than the ocean's bright shallow colour so a single-tile channel
  // does not glow and look bloated on the relief.
  const river = terrainColor(water(1, false));
  const oceanShallow = terrainColor(water(1, true));
  assert.ok(river.b < oceanShallow.b, "inland shallow water should be darker than ocean shallow");
  assert.ok(
    river.r + river.g + river.b < oceanShallow.r + oceanShallow.g + oceanShallow.b - 120,
    "inland shallow water should be substantially dimmer overall than ocean shallow",
  );
  assert.ok(river.b > river.r, "inland water should still be blue-dominant");
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
