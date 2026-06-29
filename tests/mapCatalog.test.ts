import test from "node:test";
import assert from "node:assert/strict";
import {
  MAP_CHOICES,
  DEFAULT_MAP_CHOICE_ID,
  DEFAULT_MAP_CHOICE,
  getMapChoice,
  isMapChoiceId,
} from "../src/Core/mapCatalog.js";
import { getHeightmapMap } from "../src/Server/heightmapMaps.js";
import { getRealMap } from "../src/Core/realMaps.js";

test("map-choice ids are unique and the default resolves", () => {
  const ids = MAP_CHOICES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "choice ids must be unique");
  assert.ok(getMapChoice(DEFAULT_MAP_CHOICE_ID), "default choice id must resolve");
  assert.equal(DEFAULT_MAP_CHOICE.id, DEFAULT_MAP_CHOICE_ID);
});

test("isMapChoiceId accepts catalogue ids and rejects everything else", () => {
  for (const choice of MAP_CHOICES) assert.ok(isMapChoiceId(choice.id));
  assert.equal(isMapChoiceId("mediterranean"), false, "the removed map is no longer selectable");
  assert.equal(isMapChoiceId("not-a-map"), false);
  assert.equal(isMapChoiceId(undefined), false);
  assert.equal(isMapChoiceId(42), false);
});

test("every choice resolves to a buildable map (real id known, or procedural dims)", () => {
  for (const choice of MAP_CHOICES) {
    const { realMapId, mapSize, width, height } = choice.options;
    if (realMapId) {
      const known = Boolean(getHeightmapMap(realMapId) ?? getRealMap(realMapId));
      assert.ok(known, `choice "${choice.id}" references unknown map id "${realMapId}"`);
      // Heightmap maps must carry a positive target size; ASCII maps must not
      // (their dimensions are fixed by the art).
      if (getHeightmapMap(realMapId)) {
        assert.ok(typeof mapSize === "number" && mapSize > 0, `heightmap choice "${choice.id}" needs a mapSize`);
      }
    } else {
      assert.ok(
        typeof width === "number" && width > 0 && typeof height === "number" && height > 0,
        `procedural choice "${choice.id}" needs positive width/height`,
      );
    }
  }
});
