import test from "node:test";
import assert from "node:assert/strict";
import { EARTH_STRAITS } from "../src/Server/straits.js";
import { buildHeightmapGameMap, getHeightmapMap } from "../src/Server/heightmapMaps.js";
import type { GameMap } from "../src/Core/GameMap.js";

const def = getHeightmapMap("earth")!;

/**
 * Walk a polyline over the map grid exactly the way `carveRivers` rasterises
 * it (continuous lon/lat → tile mapping, ≤0.5-tile steps, rounded stamp
 * centres), yielding the tile refs the carve is guaranteed to have stamped.
 */
const channelTiles = (
  map: GameMap,
  points: ReadonlyArray<readonly [number, number]>,
): number[] => {
  const lonToTx = (lon: number): number => ((lon + 180) / 360) * map.width;
  const latToTy = (lat: number): number => ((def.latMax - lat) / (def.latMax - def.latMin)) * map.height;
  const tiles: number[] = [];
  for (let s = 0; s < points.length - 1; s += 1) {
    const ax = lonToTx(points[s][0]);
    const ay = latToTy(points[s][1]);
    const bx = lonToTx(points[s + 1][0]);
    const by = latToTy(points[s + 1][1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const x = Math.min(map.width - 1, Math.max(0, Math.round(ax + (bx - ax) * t)));
      const y = Math.min(map.height - 1, Math.max(0, Math.round(ay + (by - ay) * t)));
      tiles.push(y * map.width + x);
    }
  }
  return tiles;
};

const tileAt = (map: GameMap, lon: number, lat: number): number => {
  const x = Math.min(map.width - 1, Math.max(0, Math.round(((lon + 180) / 360) * map.width)));
  const y = Math.min(
    map.height - 1,
    Math.max(0, Math.round(((def.latMax - lat) / (def.latMax - def.latMin)) * map.height)),
  );
  return y * map.width + x;
};

test("strait data is well-formed and inside the map's latitude crop", () => {
  const names = new Set<string>();
  for (const s of EARTH_STRAITS) {
    assert.ok(s.name && !names.has(s.name), `unique name, got duplicate/empty ${s.name}`);
    names.add(s.name!);
    assert.ok(s.points.length >= 2, `${s.name} has at least two points`);
    for (const [lon, lat] of s.points) {
      assert.ok(lon >= -180 && lon <= 180, `${s.name} lon in range`);
      assert.ok(lat > def.latMin && lat < def.latMax, `${s.name} lat inside the earth crop`);
    }
  }
});

test("every strait is a fully ocean-connected channel, even on the coarsest map", () => {
  // 640 is the smallest catalogue tier and the worst case for downsampling:
  // Gibraltar, the Bosporus and the canals are all narrower than one tile.
  const map = buildHeightmapGameMap(def, 640);
  for (const s of EARTH_STRAITS) {
    for (const tile of channelTiles(map, s.points)) {
      assert.ok(map.isWater(tile), `${s.name}: carved tile should be water`);
      assert.ok(map.isOcean(tile), `${s.name}: channel should connect to the open sea`);
    }
  }
});

test("the inland seas the straits guard are reachable from the open ocean", () => {
  const map = buildHeightmapGameMap(def, 640);
  const seas: ReadonlyArray<[string, number, number]> = [
    ["Mediterranean", 18.0, 34.5], // via Gibraltar
    ["Black Sea", 34.0, 43.0], // via the Turkish Straits
    ["Baltic", 19.5, 58.0], // via the Danish Straits
    ["Persian Gulf", 51.0, 27.0], // via Hormuz
    ["Red Sea", 38.0, 20.0], // via Bab-el-Mandeb / Suez
  ];
  for (const [name, lon, lat] of seas) {
    const tile = tileAt(map, lon, lat);
    assert.ok(map.isWater(tile), `${name} should be water`);
    assert.ok(map.isOcean(tile), `${name} should be ocean-classified (navigable from open sea)`);
  }
});

test("without the strait carve the Mediterranean is landlocked — the reason straits.ts exists", () => {
  const map = buildHeightmapGameMap({ ...def, id: "earth-no-straits", straits: false }, 640);
  const med = tileAt(map, 18.0, 34.5);
  assert.ok(map.isWater(med), "the Mediterranean basin itself survives downsampling");
  assert.ok(
    !map.isOcean(med),
    "downsampling squeezes Gibraltar shut, so the Med reads as an inland lake",
  );
});
