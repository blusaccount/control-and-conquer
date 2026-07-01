import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap, type TileRef } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { encodeTile, IMPASSABLE_MAGNITUDE } from "../src/Core/terrainCodec.js";
import { generateTerrain } from "../src/Core/terrainGenerator.js";

/** Build a flat all-land map of the given size (elevation 0). */
const flatLand = (width: number, height: number, elevation = 0): GameMap => {
  const terrain = new Uint8Array(width * height);
  const byte = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: elevation });
  terrain.fill(byte);
  return new GameMap(width, height, terrain);
};

const WATER = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: 3 });
const ROCK = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: IMPASSABLE_MAGNITUDE });

test("capturableCount counts only passable land", () => {
  const terrain = new Uint8Array(4);
  terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  terrain[1] = WATER;
  terrain[2] = ROCK;
  terrain[3] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 5 });
  const grid = new TerritoryGrid(new GameMap(4, 1, terrain));
  assert.equal(grid.capturableCount, 2);
  assert.ok(grid.isCapturable(0));
  assert.ok(!grid.isCapturable(1));
  assert.ok(!grid.isCapturable(2));
  assert.ok(grid.isCapturable(3));
});

test("addPlayer validates ids and rejects duplicates", () => {
  const grid = new TerritoryGrid(flatLand(2, 2));
  grid.addPlayer(1, 10);
  assert.ok(grid.hasPlayer(1));
  assert.throws(() => grid.addPlayer(1));
  assert.throws(() => grid.addPlayer(NEUTRAL_PLAYER));
  assert.throws(() => grid.addPlayer(-3));
  assert.throws(() => grid.addPlayer(2, -1));
});

test("claim transfers ownership and keeps tile counts in sync", () => {
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1);
  grid.addPlayer(2);

  grid.claim(0, 1);
  grid.claim(1, 1);
  assert.equal(grid.tileCountOf(1), 2);
  assert.equal(grid.ownerOf(0), 1);

  // Reassigning a tile moves the count from the old owner to the new one.
  grid.claim(1, 2);
  assert.equal(grid.tileCountOf(1), 1);
  assert.equal(grid.tileCountOf(2), 1);
  assert.equal(grid.ownerOf(1), 2);

  // Releasing back to neutral only decrements.
  grid.claim(0, NEUTRAL_PLAYER);
  assert.equal(grid.tileCountOf(1), 0);
  assert.equal(grid.ownerOf(0), NEUTRAL_PLAYER);
});

test("claim throws on non-capturable terrain", () => {
  const terrain = new Uint8Array(2);
  terrain[0] = WATER;
  terrain[1] = ROCK;
  const grid = new TerritoryGrid(new GameMap(2, 1, terrain));
  grid.addPlayer(1);
  assert.throws(() => grid.claim(0, 1));
  assert.throws(() => grid.claim(1, 1));
});

test("nearestCapturable snaps an off-target click to the land it meant", () => {
  // 5x1: land | water | water | rock | land. Tiles 1,2 (water) and 3 (rock) are
  // un-ownable; tiles 0 and 4 are capturable land.
  const terrain = new Uint8Array(5);
  terrain[0] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 0 });
  terrain[1] = WATER;
  terrain[2] = WATER;
  terrain[3] = ROCK;
  terrain[4] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 0 });
  const grid = new TerritoryGrid(new GameMap(5, 1, terrain));

  // A capturable click is returned unchanged.
  assert.equal(grid.nearestCapturable(0), 0);
  assert.equal(grid.nearestCapturable(4), 4);
  // Water/rock clicks snap to the nearest land within radius.
  assert.equal(grid.nearestCapturable(1), 0, "water by the left shore snaps left");
  assert.equal(grid.nearestCapturable(3), 4, "rock by the right shore snaps right");
  // A tie (tile 2 is equidistant from both shores) breaks to the lower TileRef.
  assert.equal(grid.nearestCapturable(2), 0);
});

test("nearestCapturable returns null when no land is within range", () => {
  // A lone land tile surrounded by a wide ocean: a click far out at sea finds
  // nothing inside the snap radius.
  const width = 12;
  const terrain = new Uint8Array(width).fill(WATER);
  terrain[0] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 0 });
  const grid = new TerritoryGrid(new GameMap(width, 1, terrain));
  assert.equal(grid.nearestCapturable(grid.map.ref(11, 0)), null, "deep ocean snaps to nothing");
  assert.equal(grid.nearestCapturable(grid.map.ref(2, 0)), 0, "near the coast still snaps");
});

test("frontierOf / hasFrontier find capturable target tiles adjacent to the attacker", () => {
  // 3x1 land: player 1 owns tile 0, tiles 1 and 2 are neutral.
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1);
  grid.claim(0, 1);

  // Only tile 1 borders the attacker; tile 2 is one ring further out.
  assert.deepEqual(grid.frontierOf(1, NEUTRAL_PLAYER), [1]);
  assert.ok(grid.hasFrontier(1, NEUTRAL_PLAYER));

  // No frontier against a player that does not border the attacker.
  grid.addPlayer(2);
  grid.claim(2, 2);
  assert.ok(!grid.hasFrontier(1, 2));
  assert.deepEqual(grid.frontierOf(1, 2), []);
});

test("frontierTargets summarises every reachable owner in one pass", () => {
  // 5x1 land. Player 1 owns tile 2 (middle); tile 1 neutral, tile 3 owned by
  // player 2, tiles 0 and 4 are out of reach (one ring further out).
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1);
  grid.addPlayer(2);
  grid.claim(2, 1);
  grid.claim(3, 2);

  const targets = grid.frontierTargets(1);
  // Neutral (id 0) first, then player 2; each touched by exactly one frontier tile.
  assert.deepEqual(targets, [
    { target: NEUTRAL_PLAYER, tiles: 1, sample: 1 },
    { target: 2, tiles: 1, sample: 3 },
  ]);

  // A player with no neighbours reports no targets.
  grid.addPlayer(3);
  assert.deepEqual(grid.frontierTargets(3), []);
});

test("frontierTargets agrees with per-target frontierOf on a real map", () => {
  const map = generateTerrain({ width: 40, height: 28, seed: 11 });
  const grid = new TerritoryGrid(map);
  const players: PlayerId[] = [1, 2, 3];
  for (const id of players) grid.addPlayer(id);

  let salt = 99887766;
  const nextInt = (n: number): number => {
    salt = (Math.imul(salt, 1103515245) + 12345) & 0x7fffffff;
    return salt % n;
  };
  for (let ref = 0; ref < map.size; ref += 1) {
    if (!grid.isCapturable(ref)) continue;
    const roll = nextInt(5);
    if (roll < players.length) grid.claim(ref, players[roll]);
  }

  for (const attacker of players) {
    const summary = grid.frontierTargets(attacker);
    const byTarget = new Map(summary.map((s) => [s.target, s]));

    // Every target frontierOf reports must appear with a matching tile count and
    // a sample that is the lowest TileRef of that frontier.
    for (const target of [NEUTRAL_PLAYER, ...players]) {
      if (target === attacker) continue;
      const frontier = grid.frontierOf(attacker, target);
      const entry = byTarget.get(target);
      if (frontier.length === 0) {
        assert.equal(entry, undefined, `no entry expected for target ${target}`);
        continue;
      }
      assert.ok(entry, `expected an entry for target ${target}`);
      assert.equal(entry!.tiles, frontier.length, `tile count for target ${target}`);
      assert.equal(entry!.sample, frontier[0], `sample for target ${target}`);
    }

    // Targets are returned in ascending id order.
    const ids = summary.map((s) => s.target);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  }
});

test("frontierOf matches a brute-force scan over a real generated map", () => {
  // The owned-set-driven frontier must be byte-identical to a naive full-raster
  // scan that asks, per capturable target tile, whether the attacker can reach
  // it across a land border or by boat. (The map is well under the sea-scan
  // budget, so a boat target is exactly a tile findSeaPath can route to.)
  const map = generateTerrain({ width: 40, height: 28, seed: 7 });
  const grid = new TerritoryGrid(map);
  const players: PlayerId[] = [1, 2, 3];
  for (const id of players) grid.addPlayer(id);

  // Deterministically scatter ownership across capturable land.
  let salt = 1234567;
  const nextInt = (n: number): number => {
    salt = (Math.imul(salt, 1103515245) + 12345) & 0x7fffffff;
    return salt % n;
  };
  for (let ref = 0; ref < map.size; ref += 1) {
    if (!grid.isCapturable(ref)) continue;
    const roll = nextInt(5); // ~60% of land claimed, spread over 3 players
    if (roll < players.length) grid.claim(ref, players[roll]);
  }

  const bruteForce = (attacker: PlayerId, target: PlayerId): TileRef[] => {
    const out: TileRef[] = [];
    for (let ref = 0; ref < map.size; ref += 1) {
      if (grid.ownerOf(ref) !== target || !grid.isCapturable(ref)) continue;
      // Reachable iff the attacker borders it by land, or a transport could be
      // routed to it (findSeaPath is the same connectivity the frontier uses).
      const reaches =
        map.neighbors(ref).some((n) => grid.ownerOf(n) === attacker) ||
        grid.findSeaPath(attacker, ref) !== null;
      if (reaches) out.push(ref);
    }
    return out;
  };

  const targets: PlayerId[] = [NEUTRAL_PLAYER, 1, 2, 3];
  for (const attacker of players) {
    for (const target of targets) {
      if (attacker === target) continue;
      const expected = bruteForce(attacker, target);
      assert.deepEqual(grid.frontierOf(attacker, target), expected, `frontierOf(${attacker}, ${target})`);
      assert.equal(grid.hasFrontier(attacker, target), expected.length > 0, `hasFrontier(${attacker}, ${target})`);
    }
  }
});

test("defenseFactorAt applies the full strength binary in-range (OpenFront), then nothing beyond", () => {
  // 11x1 flat land; a post at tile 5 with radius 4, strength 3. OpenFront's
  // defense post is binary: every tile within the radius pays the full strength,
  // with no linear falloff, and nothing outside it.
  const grid = new TerritoryGrid(flatLand(11, 1));
  grid.addDefensePost(5, 4, 3);
  assert.equal(grid.defensePostCount, 1);

  assert.equal(grid.defenseFactorAt(5), 3, "full strength on the post itself");
  assert.equal(grid.defenseFactorAt(7), 3, "still full strength partway out (in range)");
  assert.equal(grid.defenseFactorAt(9), 3, "full strength right at the radius edge");
  assert.equal(grid.defenseFactorAt(10), 1, "one tile beyond the radius: no effect");
  assert.equal(grid.defenseFactorAt(0), 1, "well beyond the radius there is no effect");

  assert.ok(grid.hasDefensePost(5));
  assert.ok(grid.removeDefensePost(5));
  assert.equal(grid.defenseFactorAt(5), 1, "removing the post clears its aura");
  assert.equal(grid.defensePostCount, 0);
});

test("the strongest covering post wins where auras overlap (no stacking)", () => {
  const grid = new TerritoryGrid(flatLand(11, 1));
  grid.addDefensePost(4, 4, 2);
  grid.addDefensePost(6, 4, 3);
  // Tile 5 sits in both auras (both in range): the stronger post (strength 3)
  // wins; auras do not add up.
  assert.equal(grid.defenseFactorAt(5), 3);
});

test("addDefensePost rejects non-capturable terrain and bad parameters", () => {
  const grid = new TerritoryGrid(new GameMap(2, 1, new Uint8Array([WATER, ROCK])));
  assert.throws(() => grid.addDefensePost(0), /cannot hold a defense post/);
  const land = new TerritoryGrid(flatLand(3, 1));
  assert.throws(() => land.addDefensePost(1, -1), /radius/);
  assert.throws(() => land.addDefensePost(1, 2, 0.5), /strength/);
});
