import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeTile,
  encodeTile,
  IMPASSABLE_MAGNITUDE,
  isImpassable,
  isLand,
  isOcean,
  isShore,
  isWater,
  LAND_BIT,
  magnitude,
  MAGNITUDE_MASK,
  MAX_MAGNITUDE,
  OCEAN_BIT,
  SHORELINE_BIT,
  type TileProps,
} from "../src/Core/terrainCodec.js";

test("encode/decode round-trips for every flag combination and magnitude", () => {
  for (const land of [false, true]) {
    for (const shoreline of [false, true]) {
      for (const ocean of [false, true]) {
        for (let mag = 0; mag <= MAX_MAGNITUDE; mag += 1) {
          const props: TileProps = { land, shoreline, ocean, magnitude: mag };
          const decoded = decodeTile(encodeTile(props));
          assert.equal(decoded.land, land);
          assert.equal(decoded.shoreline, shoreline);
          // The ocean bit is only meaningful for water; land always decodes ocean=false.
          assert.equal(decoded.ocean, land ? false : ocean);
          assert.equal(decoded.magnitude, mag);
        }
      }
    }
  }
});

test("encodeTile produces a single byte and forces the ocean bit clear on land", () => {
  const byte = encodeTile({ land: true, shoreline: true, ocean: true, magnitude: 30 });
  assert.ok(byte >= 0 && byte <= 0xff);
  assert.equal(byte & OCEAN_BIT, 0, "land tiles must not set the ocean bit");
  assert.equal(byte & LAND_BIT, LAND_BIT);
  assert.equal(byte & SHORELINE_BIT, SHORELINE_BIT);
  assert.equal(byte & MAGNITUDE_MASK, 30);
});

test("bit masks occupy the documented positions and do not overlap", () => {
  assert.equal(LAND_BIT, 0x80);
  assert.equal(SHORELINE_BIT, 0x40);
  assert.equal(OCEAN_BIT, 0x20);
  assert.equal(MAGNITUDE_MASK, 0x1f);
  assert.equal(LAND_BIT | SHORELINE_BIT | OCEAN_BIT | MAGNITUDE_MASK, 0xff);
  assert.equal(LAND_BIT & MAGNITUDE_MASK, 0);
});

test("magnitude boundaries: 0 and 31 round-trip and out-of-range throws", () => {
  assert.equal(decodeTile(encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 })).magnitude, 0);
  assert.equal(magnitude(encodeTile({ land: true, shoreline: false, ocean: false, magnitude: MAX_MAGNITUDE })), MAX_MAGNITUDE);
  assert.throws(() => encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 32 }));
  assert.throws(() => encodeTile({ land: true, shoreline: false, ocean: false, magnitude: -1 }));
  assert.throws(() => encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 1.5 }));
});

test("IMPASSABLE: land magnitude 31 is impassable; water magnitude 31 is not", () => {
  const rock = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: IMPASSABLE_MAGNITUDE });
  assert.ok(isImpassable(rock));
  assert.ok(isLand(rock));

  const deepWater = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: IMPASSABLE_MAGNITUDE });
  assert.ok(!isImpassable(deepWater), "deep water is not impassable rock");
  assert.ok(isWater(deepWater));
  assert.equal(magnitude(deepWater), IMPASSABLE_MAGNITUDE);
});

test("predicates classify land vs water tiles", () => {
  const land = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 5 });
  assert.ok(isLand(land));
  assert.ok(!isWater(land));
  assert.ok(isShore(land));
  assert.ok(!isOcean(land));

  const lake = encodeTile({ land: false, shoreline: true, ocean: false, magnitude: 1 });
  assert.ok(isWater(lake));
  assert.ok(!isLand(lake));
  assert.ok(isShore(lake));
  assert.ok(!isOcean(lake), "a lake is water but not ocean");

  const ocean = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: 4 });
  assert.ok(isOcean(ocean));
  assert.ok(isWater(ocean));
});
