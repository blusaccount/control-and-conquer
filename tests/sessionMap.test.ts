import test from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogSessionMap, resolveHeightmapSessionMap } from "../src/Server/sessionMap.js";
import { getMapChoice } from "../src/Core/mapCatalog.js";

const countLand = (map: { size: number; isLand: (i: number) => boolean }): number => {
  let land = 0;
  for (let i = 0; i < map.size; i += 1) if (map.isLand(i)) land += 1;
  return land;
};

test("resolveCatalogSessionMap builds the earth heightmap choice with land", () => {
  const choice = getMapChoice("earth-standard")!;
  const { map, name } = resolveCatalogSessionMap(choice.options, choice.name);
  assert.ok(map.width >= 64, "earth built at a sane width");
  assert.equal(map.size, map.width * map.height);
  assert.equal(name, "Earth", "name comes from the heightmap definition");
  assert.ok(countLand(map) > 0, "earth has land");
});

test("resolveHeightmapSessionMap returns null for non-heightmap ids", () => {
  assert.equal(resolveHeightmapSessionMap("world", undefined), null);
  assert.equal(resolveHeightmapSessionMap(undefined, undefined), null);
  assert.equal(resolveHeightmapSessionMap("not-a-map", 256), null);
});
