import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { PlayerId } from "../src/Core/TerritoryGrid.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";
import {
  buildingCost,
  goldPerSecond,
  BUILDING_DEFS,
  GOLD_PER_TILE_PER_TICK,
  CITY_GOLD_PER_TICK,
  FORT_DEFENSE_STRENGTH,
} from "../src/Core/buildings.js";
import { MAX_POOL_PER_TILE } from "../src/Core/rasterCombatConfig.js";

/** A flat all-land strip of `width` tiles — deterministic ground to own/build on. */
const landStrip = (width: number): TerritoryGrid => {
  const map = buildTerrainFromMask({
    width,
    height: 1,
    land: new Uint8Array(width).fill(1),
    elevation: new Uint8Array(width),
  });
  return new TerritoryGrid(map);
};

/** Claim the first `count` capturable tiles to `player`, returning their refs. */
const claimRun = (grid: TerritoryGrid, player: PlayerId, count: number): number[] => {
  const refs: number[] = [];
  for (let ref = 0; ref < grid.map.size && refs.length < count; ref += 1) {
    if (grid.isCapturable(ref)) {
      grid.claim(ref, player);
      refs.push(ref);
    }
  }
  return refs;
};

// --- buildings.ts pure maths -----------------------------------------------

test("buildingCost ramps geometrically with how many you already own", () => {
  assert.equal(buildingCost("city", 0), 100);
  assert.equal(buildingCost("city", 1), 160); // 100 * 1.6
  assert.equal(buildingCost("city", 2), 256); // 100 * 1.6^2
  assert.equal(buildingCost("port", 0), 80);
  assert.equal(buildingCost("fort", 0), 120);
  // Each successive structure of a type costs strictly more.
  assert.ok(buildingCost("port", 3) > buildingCost("port", 0));
});

test("goldPerSecond folds in territory and city dividends", () => {
  assert.equal(goldPerSecond(10, 0, 20), 10 * GOLD_PER_TILE_PER_TICK * 20);
  assert.equal(goldPerSecond(10, 2, 20), (10 * GOLD_PER_TILE_PER_TICK + 2 * CITY_GOLD_PER_TICK) * 20);
});

// --- TerritoryGrid: gold + buildings ---------------------------------------

test("gold pool can be set and adjusted, clamped at zero", () => {
  const grid = landStrip(4);
  grid.addPlayer(1, 0);
  assert.equal(grid.goldOf(1), 0);
  grid.setGold(1, 50);
  grid.addGold(1, 25);
  assert.equal(grid.goldOf(1), 75);
  grid.addGold(1, -1000);
  assert.equal(grid.goldOf(1), 0, "gold never goes negative");
});

test("placeBuilding records the structure and bumps the owner's count", () => {
  const grid = landStrip(4);
  grid.addPlayer(1, 0);
  const [ref] = claimRun(grid, 1, 1);
  grid.placeBuilding(ref, "city");
  assert.equal(grid.buildingAt(ref), "city");
  assert.equal(grid.buildingCountOf(1, "city"), 1);
  assert.equal(grid.buildingCount, 1);
  // One structure per tile; a second placement throws.
  assert.throws(() => grid.placeBuilding(ref, "port"));
});

test("placeBuilding rejects neutral / unowned tiles", () => {
  const grid = landStrip(4);
  grid.addPlayer(1, 0);
  // Tile 0 is neutral (unclaimed) — nothing can be built there.
  assert.throws(() => grid.placeBuilding(0, "city"));
});

test("a building is razed when its tile changes hands", () => {
  const grid = landStrip(4);
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  const [ref] = claimRun(grid, 1, 1);
  grid.placeBuilding(ref, "city");
  assert.equal(grid.buildingCountOf(1, "city"), 1);

  grid.claim(ref, 2); // player 2 captures the tile
  assert.equal(grid.buildingAt(ref), undefined, "the structure is destroyed on capture");
  assert.equal(grid.buildingCountOf(1, "city"), 0, "the former owner's count drops");
  assert.equal(grid.buildingCountOf(2, "city"), 0, "the captor does not inherit it");
});

test("a fort raises a defense aura that vanishes when the fort is lost", () => {
  const grid = landStrip(6);
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  const refs = claimRun(grid, 1, 3);
  const fortRef = refs[1];
  assert.equal(grid.defenseFactorAt(fortRef), 1, "no aura before the fort exists");

  grid.placeBuilding(fortRef, "fort");
  assert.ok(grid.hasDefensePost(fortRef), "fort registers a defense post");
  assert.ok(Math.abs(grid.defenseFactorAt(fortRef) - FORT_DEFENSE_STRENGTH) < 1e-9);

  grid.claim(fortRef, 2); // lose the fort tile
  assert.equal(grid.hasDefensePost(fortRef), false, "the aura is gone with the fort");
  assert.equal(grid.defenseFactorAt(fortRef), 1);
});

test("ports widen a player's sea-crossing range, bounded by the cap", () => {
  const grid = landStrip(8);
  grid.addPlayer(1, 0);
  const refs = claimRun(grid, 1, 6);
  const base = grid.seaRangeOf(1);
  grid.placeBuilding(refs[0], "port");
  assert.ok(grid.seaRangeOf(1) > base, "one port extends reach beyond the baseline");
  // Stacking ports keeps growing reach but never past the hard cap (2x base).
  grid.placeBuilding(refs[1], "port");
  grid.placeBuilding(refs[2], "port");
  grid.placeBuilding(refs[3], "port");
  assert.ok(grid.seaRangeOf(1) <= base * 2, "reach is bounded even with many ports");
});

// --- RasterConflict: gold + city income ------------------------------------

test("gold accrues each tick in proportion to tiles held", () => {
  const grid = landStrip(20);
  grid.addPlayer(1, 0);
  claimRun(grid, 1, 10); // own 10 of 20 tiles (rest neutral so the match continues)
  const conflict = new RasterConflict(grid);
  for (let i = 0; i < 100; i += 1) conflict.processTick();
  // 10 tiles * 0.01 gold/tile/tick * 100 ticks ≈ 10 gold (a sub-1 fractional
  // remainder may still be sitting in the accumulator, so allow ±1).
  assert.ok(grid.goldOf(1) >= 9 && grid.goldOf(1) <= 10, `expected ~10 gold, got ${grid.goldOf(1)}`);
});

test("a city boosts both gold income and troop growth", () => {
  const makeGrid = (withCity: boolean): TerritoryGrid => {
    const grid = landStrip(20);
    grid.addPlayer(1, 0);
    const refs = claimRun(grid, 1, 10);
    if (withCity) grid.placeBuilding(refs[0], "city");
    return grid;
  };
  const plain = makeGrid(false);
  const withCity = makeGrid(true);
  const cPlain = new RasterConflict(plain);
  const cCity = new RasterConflict(withCity);
  for (let i = 0; i < 200; i += 1) {
    cPlain.processTick();
    cCity.processTick();
  }
  assert.ok(withCity.goldOf(1) > plain.goldOf(1), "the city earns extra gold");
  assert.ok(withCity.troopsOf(1) > plain.troopsOf(1), "the city earns extra troops");
});

test("cities never push the troop pool past its territory soft cap", () => {
  const grid = landStrip(20);
  grid.addPlayer(1, 0);
  const refs = claimRun(grid, 1, 10);
  // Stack several cities, then run long enough to saturate.
  for (let i = 0; i < 4; i += 1) grid.placeBuilding(refs[i], "city");
  const conflict = new RasterConflict(grid);
  for (let i = 0; i < 8000; i += 1) conflict.processTick();
  const cap = grid.tileCountOf(1) * MAX_POOL_PER_TILE;
  assert.ok(grid.troopsOf(1) <= cap, "the soft cap still bounds the pool with cities");
});

// --- RasterGameSession: end-to-end build flow ------------------------------

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

const rejections = (messages: RasterServerMessage[]): string[] =>
  messages
    .filter((m) => m.type === "SERVER_RASTER_ACTION_REJECTED")
    .map((m) => (m.type === "SERVER_RASTER_ACTION_REJECTED" ? m.payload.reason : ""));

/**
 * Seat a human on a procedural session and hand them a non-capital owned tile to
 * build on (a neutral neighbour of the capital, claimed to them). Returns the
 * collected messages, the build tile, and the capital tile.
 */
const stageBuilder = (
  seed: number,
): { session: RasterGameSession; messages: RasterServerMessage[]; build: { x: number; y: number }; capital: { x: number; y: number } } => {
  const session = new RasterGameSession({ width: 40, height: 28, seed });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  const map = session.peekMap();
  let capitalRef = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) if (grid.ownerOf(ref) === 1) { capitalRef = ref; break; }
  assert.ok(capitalRef >= 0, "the human must be seated");
  // Find a neutral, capturable neighbour of the capital and give it to player 1.
  let buildRef = -1;
  for (const n of map.neighbors(capitalRef)) {
    if (grid.isCapturable(n) && grid.ownerOf(n) === 0) { buildRef = n; break; }
  }
  assert.ok(buildRef >= 0, "the capital must have an open neighbour to claim");
  grid.claim(buildRef, 1);
  return {
    session,
    messages,
    build: { x: map.x(buildRef), y: map.y(buildRef) },
    capital: { x: map.x(capitalRef), y: map.y(capitalRef) },
  };
};

test("a player with gold can build a city, spending the gold", () => {
  const { session, messages, build } = stageBuilder(11);
  session.peekGrid().setGold(1, 500);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "city" });
  session.tick();

  const grid = session.peekGrid();
  assert.equal(grid.buildingCountOf(1, "city"), 1, "the city is placed");
  // Build spends the base cost before income is applied; a 2-tile territory's
  // per-tick gold income floors to 0, so the pool is exactly 500 - 100.
  assert.equal(grid.goldOf(1), 500 - BUILDING_DEFS.city.baseCost);

  const snap = lastSnapshot(messages);
  const me = snap.players.find((p) => p.playerId === 1);
  assert.equal(me?.cities, 1, "the snapshot reports the city count");
  assert.equal(snap.buildings.length, 1, "the snapshot lists the structure");
  assert.equal(snap.buildings[0].type, "city");
  assert.equal(snap.buildings[0].playerId, 1);
});

test("building without enough gold is rejected and places nothing", () => {
  const { session, messages, build } = stageBuilder(12);
  session.peekGrid().setGold(1, 0);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "city" });
  session.tick();
  assert.ok(rejections(messages).includes("INSUFFICIENT_GOLD"));
  assert.equal(session.peekGrid().buildingCount, 0, "no structure was placed");
});

test("building on a tile you don't own is rejected", () => {
  const { session, messages } = stageBuilder(13);
  session.peekGrid().setGold(1, 500);
  // (0,0)-ish neutral water/land the player almost certainly doesn't own; pick a
  // far corner tile that isn't theirs.
  const map = session.peekMap();
  const grid = session.peekGrid();
  let foreign = { x: 0, y: 0 };
  for (let ref = grid.owner.length - 1; ref >= 0; ref -= 1) {
    if (grid.isCapturable(ref) && grid.ownerOf(ref) !== 1) { foreign = { x: map.x(ref), y: map.y(ref) }; break; }
  }
  session.queueBuild("human", { targetX: foreign.x, targetY: foreign.y, building: "fort" });
  session.tick();
  assert.ok(rejections(messages).includes("NOT_BUILDABLE"));
});

test("building on the capital seat is rejected", () => {
  const { session, messages, capital } = stageBuilder(14);
  session.peekGrid().setGold(1, 500);
  session.queueBuild("human", { targetX: capital.x, targetY: capital.y, building: "fort" });
  session.tick();
  assert.ok(rejections(messages).includes("NOT_BUILDABLE"));
});

test("a second building on the same tile is rejected as occupied", () => {
  const { session, messages, build } = stageBuilder(15);
  session.peekGrid().setGold(1, 1000);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "city" });
  session.tick();
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "port" });
  session.tick();
  assert.ok(rejections(messages).includes("TILE_OCCUPIED"));
  assert.equal(session.peekGrid().buildingCount, 1);
});
