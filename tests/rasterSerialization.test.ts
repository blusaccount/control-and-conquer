import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateTerrain } from "../src/Core/terrainGenerator.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { encodeTerrain, encodeOwners, buildRasterSnapshot } from "../src/Server/rasterSerialization.js";

test("encodeTerrain returns a stable hash for identical terrain", () => {
  const map = generateTerrain({ width: 32, height: 24, seed: 7 });
  const a = encodeTerrain(map);
  const b = encodeTerrain(map);
  assert.equal(a.terrainHash, b.terrainHash);
  assert.equal(a.terrainBase64, b.terrainBase64);
});

test("encodeOwners roundtrips through base64 into the same Uint16 values", () => {
  const arr = new Uint16Array([0, 1, 2, 65535, 7, 42]);
  const b64 = encodeOwners(arr);
  const decoded = Buffer.from(b64, "base64");
  assert.equal(decoded.length, arr.length * 2);
  for (let i = 0; i < arr.length; i += 1) {
    assert.equal(decoded.readUInt16LE(i * 2), arr[i], `index ${i} differs`);
  }
});

test("buildRasterSnapshot only includes terrainBase64 when requested", () => {
  const map = generateTerrain({ width: 16, height: 12, seed: 2 });
  const grid = new TerritoryGrid(map);
  grid.addPlayer(1, 50);
  const playerMeta = new Map([[1, { name: "Blue", color: "#3b82f6" }]]);
  const { terrainHash, terrainBase64 } = encodeTerrain(map);

  const withTerrain = buildRasterSnapshot({
    tick: 0, mapName: "T", map, grid, playerMeta,
    includeTerrain: true, terrainHash, terrainBase64,
    winnerPlayerId: null, recentEvents: [],
  });
  const withoutTerrain = buildRasterSnapshot({
    tick: 1, mapName: "T", map, grid, playerMeta,
    includeTerrain: false, terrainHash, terrainBase64,
    winnerPlayerId: null, recentEvents: [],
  });

  assert.equal(withTerrain.terrainBase64, terrainBase64);
  assert.equal(withoutTerrain.terrainBase64, undefined);
  assert.equal(withTerrain.terrainHash, withoutTerrain.terrainHash);
  assert.equal(withTerrain.width, 16);
  assert.equal(withTerrain.height, 12);
  assert.equal(withTerrain.players.length, 1);
  assert.equal(withTerrain.players[0].playerId, 1);
});

test("buildRasterSnapshot reports troopsPerSecond proportional to tiles", () => {
  const map = generateTerrain({ width: 16, height: 12, seed: 2 });
  const grid = new TerritoryGrid(map);
  grid.addPlayer(1, 50);
  // Claim a handful of capturable tiles so the rate is non-zero and checkable.
  let claimed = 0;
  for (let ref = 0; ref < map.size && claimed < 4; ref += 1) {
    if (grid.isCapturable(ref)) {
      grid.claim(ref, 1);
      claimed += 1;
    }
  }
  const playerMeta = new Map([[1, { name: "Blue", color: "#3b82f6" }]]);
  const { terrainHash, terrainBase64 } = encodeTerrain(map);
  const snap = buildRasterSnapshot({
    tick: 0, mapName: "T", map, grid, playerMeta,
    includeTerrain: false, terrainHash, terrainBase64,
    winnerPlayerId: null, recentEvents: [],
  });
  const row = snap.players[0];
  assert.equal(row.tiles, claimed);
  // Rate must track the published per-tile constant (tiles * 0.05).
  assert.ok(Math.abs(row.troopsPerSecond - claimed * 0.05) < 1e-9, "rate should equal tiles * 0.05");
});
