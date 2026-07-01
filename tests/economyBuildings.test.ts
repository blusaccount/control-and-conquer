import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { PlayerId } from "../src/Core/TerritoryGrid.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";
import {
  buildingCost,
  costCounterTypes,
  goldPerSecond,
  BUILDING_DEFS,
  GOLD_BASE_PER_TICK,
  FORT_DEFENSE_STRENGTH,
} from "../src/Core/buildings.js";
import { maxTroops } from "../src/Core/rasterCombatConfig.js";

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

test("buildingCost follows OpenFront's capped ramps (geometric ×2, linear fort)", () => {
  // City/port/factory double each time, capped at 1,000,000.
  assert.equal(buildingCost("city", 0), 125_000);
  assert.equal(buildingCost("city", 1), 250_000); // 125k * 2
  assert.equal(buildingCost("city", 2), 500_000); // 125k * 2^2
  assert.equal(buildingCost("city", 4), 1_000_000); // capped (would be 2,000,000)
  assert.equal(buildingCost("port", 0), 125_000);
  assert.equal(buildingCost("factory", 0), 125_000);
  // Fort (defense post) grows linearly, capped at 250,000.
  assert.equal(buildingCost("fort", 0), 50_000); // (0+1) * 50k
  assert.equal(buildingCost("fort", 1), 100_000);
  assert.equal(buildingCost("fort", 9), 250_000); // capped (would be 500,000)
  assert.ok(buildingCost("port", 3) > buildingCost("port", 0));
});

test("ports and factories share a cost counter (OpenFront)", () => {
  assert.deepEqual([...costCounterTypes("port")].sort(), ["factory", "port"]);
  assert.deepEqual([...costCounterTypes("factory")].sort(), ["factory", "port"]);
  assert.deepEqual(costCounterTypes("city"), ["city"], "a city counts only itself");
  assert.deepEqual(costCounterTypes("fort"), ["fort"], "a fort counts only itself");
  // So once one of the group is built (owned = 1), the next costs the 2nd step.
  assert.equal(buildingCost("port", 1), 250_000, "a port after a factory costs the 2nd-of-group price");
});

test("goldPerSecond is the flat base rate, independent of territory or buildings (OpenFront)", () => {
  // OpenFront's passive gold is a flat per-tick rate that does not scale with
  // tiles, cities or ports — so the displayed +N/s is just base × tick rate.
  assert.equal(goldPerSecond(20), GOLD_BASE_PER_TICK * 20);
  assert.equal(goldPerSecond(10), GOLD_BASE_PER_TICK * 10);
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

test("passive gold is flat — a port adds no per-tick dividend (gold comes from trade)", () => {
  // Two single-tile players; one builds a port. With OpenFront's flat passive
  // gold the port pays NO standing dividend (a lone port has no trade partner),
  // so both earn exactly the same flat base.
  const grid = landStrip(2);
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  grid.claim(0, 1);
  grid.claim(1, 2);
  grid.placeBuilding(0, "port");
  const conflict = new RasterConflict(grid);

  const ticks = 200;
  for (let i = 0; i < ticks; i += 1) conflict.processTick();

  assert.equal(grid.goldOf(1), grid.goldOf(2), "a port adds no flat gold dividend");
  assert.equal(grid.goldOf(1), GOLD_BASE_PER_TICK * ticks, "gold is just the flat base rate");
});

// --- RasterConflict: gold + city income ------------------------------------

test("gold accrues at the flat base rate each tick, regardless of territory (OpenFront)", () => {
  const grid = landStrip(20);
  grid.addPlayer(1, 0);
  claimRun(grid, 1, 10); // own 10 of 20 tiles (rest neutral so the match continues)
  const conflict = new RasterConflict(grid);
  for (let i = 0; i < 100; i += 1) conflict.processTick();
  // Flat 100/tick × 100 ticks = 10,000 — independent of the 10 tiles held.
  assert.equal(grid.goldOf(1), GOLD_BASE_PER_TICK * 100, `expected ${GOLD_BASE_PER_TICK * 100} gold, got ${grid.goldOf(1)}`);
});

test("a building under construction counts for cost but not effect until it finishes", () => {
  const grid = landStrip(20);
  grid.addPlayer(1, 0);
  const refs = claimRun(grid, 1, 10);
  // Built at tick 0, ready at tick 5.
  grid.placeBuilding(refs[0], "city", 0, 5);
  assert.equal(grid.buildingCountOf(1, "city"), 1, "counts toward the cost ramp at once");
  assert.equal(grid.activeBuildingCountOf(1, "city"), 0, "but does not lift the cap yet");
  assert.equal(grid.isUnderConstruction(refs[0]), true);

  grid.activateDue(4);
  assert.equal(grid.activeBuildingCountOf(1, "city"), 0, "still building at tick 4");
  grid.activateDue(5);
  assert.equal(grid.activeBuildingCountOf(1, "city"), 1, "active once the window elapses");
  assert.equal(grid.isUnderConstruction(refs[0]), false);
});

test("a fort's defense aura only switches on once it finishes building", () => {
  const grid = landStrip(6);
  grid.addPlayer(1, 0);
  const refs = claimRun(grid, 1, 3);
  grid.placeBuilding(refs[1], "fort", 0, 4); // under construction
  assert.equal(grid.defenseFactorAt(refs[1]), 1, "no aura while building");
  grid.activateDue(4);
  assert.ok(grid.defenseFactorAt(refs[1]) > 1, "aura is up once the fort finishes");
});

test("a city raises the troop ceiling but pays no gold (OpenFront)", () => {
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
  for (let i = 0; i < 600; i += 1) {
    cPlain.processTick();
    cCity.processTick();
  }
  // A city pays no gold — both empires bank the identical flat passive gold.
  assert.equal(withCity.goldOf(1), plain.goldOf(1), "a city pays no gold dividend");
  // But it raises the population ceiling, so the bell-curve growth has more
  // headroom and the pool climbs faster than the city-less empire's.
  assert.ok(withCity.troopsOf(1) > plain.troopsOf(1), "the city's higher ceiling grows troops faster");
});

test("cities never push the troop pool past its territory soft cap", () => {
  const grid = landStrip(20);
  grid.addPlayer(1, 0);
  const refs = claimRun(grid, 1, 10);
  // Stack several cities, then run long enough to saturate.
  for (let i = 0; i < 4; i += 1) grid.placeBuilding(refs[i], "city");
  const conflict = new RasterConflict(grid);
  for (let i = 0; i < 8000; i += 1) conflict.processTick();
  const cap = maxTroops(grid.tileCountOf(1), grid.buildingCountOf(1, "city"));
  assert.ok(grid.troopsOf(1) <= cap, "the territory-scaled ceiling still bounds the pool with cities");
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
 * Seat a human on a procedural session and hand them a second owned tile to
 * build on (a neutral neighbour of their founding tile, claimed to them).
 * Returns the collected messages, the build tile, and the founding tile.
 */
const stageBuilder = (
  seed: number,
): { session: RasterGameSession; messages: RasterServerMessage[]; build: { x: number; y: number }; origin: { x: number; y: number } } => {
  const session = new RasterGameSession({ width: 40, height: 28, seed });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  const map = session.peekMap();
  let originRef = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) if (grid.ownerOf(ref) === 1) { originRef = ref; break; }
  assert.ok(originRef >= 0, "the human must be seated");
  // Find a neutral, capturable neighbour of the founding tile and give it to player 1.
  let buildRef = -1;
  for (const n of map.neighbors(originRef)) {
    if (grid.isCapturable(n) && grid.ownerOf(n) === 0) { buildRef = n; break; }
  }
  assert.ok(buildRef >= 0, "the founding tile must have an open neighbour to claim");
  grid.claim(buildRef, 1);
  return {
    session,
    messages,
    build: { x: map.x(buildRef), y: map.y(buildRef) },
    origin: { x: map.x(originRef), y: map.y(originRef) },
  };
};

test("a player with gold can build a city, spending the gold", () => {
  const { session, messages, build } = stageBuilder(11);
  session.peekGrid().setGold(1, 1_000_000);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "city" });
  session.tick();

  const grid = session.peekGrid();
  assert.equal(grid.buildingCountOf(1, "city"), 1, "the city is placed");
  // Build spends the base cost; one tick of gold income then accrues on top, so
  // the pool sits just above (start - cost).
  const afterCost = 1_000_000 - BUILDING_DEFS.city.baseCost;
  assert.ok(
    grid.goldOf(1) >= afterCost && grid.goldOf(1) < afterCost + 1000,
    `expected ~${afterCost} gold after the build, got ${grid.goldOf(1)}`,
  );

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

test("building on the founding tile is allowed (no capital restriction)", () => {
  const { session, messages, origin } = stageBuilder(14);
  session.peekGrid().setGold(1, 100_000);
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "fort" });
  session.tick();
  assert.ok(!rejections(messages).includes("NOT_BUILDABLE"), "the founding tile is just normal owned land now");
  assert.equal(session.peekGrid().buildingCountOf(1, "fort"), 1, "the fort is placed on the founding tile");
});

test("a second building too close to the first is rejected (minimum spacing)", () => {
  // `build` and `origin` are adjacent tiles, well inside the 15-tile minimum
  // spacing, so a structure on one blocks a structure on the other.
  const { session, messages, build, origin } = stageBuilder(21);
  session.peekGrid().setGold(1, 1_000_000);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "fort" });
  session.tick();
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "fort" });
  session.tick();
  assert.ok(rejections(messages).includes("TILE_OCCUPIED"), "the second, too-close build is rejected");
  assert.equal(session.peekGrid().buildingCount, 1, "only the first structure stands");
});

test("a port click on owned non-shore land snaps to the nearest owned coast", () => {
  // Coastlines are one tile wide, so a port click rarely lands exactly on shore.
  // The build should snap to the nearest owned shore tile instead of rejecting.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 31 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  const map = session.peekMap();

  // Find a land shore tile with a non-shore land neighbour; give both to the human.
  let shoreRef = -1;
  let inlandRef = -1;
  outer: for (let ref = 0; ref < grid.owner.length; ref += 1) {
    if (!map.isLand(ref) || !map.isShore(ref) || !grid.isCapturable(ref)) continue;
    for (const n of map.neighbors(ref)) {
      if (map.isLand(n) && !map.isShore(n) && grid.isCapturable(n)) {
        shoreRef = ref;
        inlandRef = n;
        break outer;
      }
    }
  }
  assert.ok(shoreRef >= 0 && inlandRef >= 0, "the map needs a coast with an inland neighbour");
  grid.claim(shoreRef, 1);
  grid.claim(inlandRef, 1);
  grid.setGold(1, 1_000_000);

  // Click the inland (non-shore) tile — the port must snap onto the shore tile.
  session.queueBuild("human", { targetX: map.x(inlandRef), targetY: map.y(inlandRef), building: "port" });
  session.tick();

  assert.ok(!rejections(messages).includes("NOT_BUILDABLE"), "an owned coast is within reach — not rejected");
  assert.equal(grid.buildingCountOf(1, "port"), 1, "the port is placed");
  assert.equal(grid.hasBuilding(shoreRef), true, "it snapped onto the shore tile, not the clicked inland tile");
  assert.equal(grid.hasBuilding(inlandRef), false, "the clicked inland tile stays empty");
});

test("a port with no coast within reach is rejected (no snap target)", () => {
  // A fully landlocked map: every tile is land, so no shore tile exists anywhere
  // and the snap has nothing to find — a port can't be placed.
  const W = 30;
  const H = 30;
  const map = buildTerrainFromMask({
    width: W,
    height: H,
    land: new Uint8Array(W * H).fill(1),
    elevation: new Uint8Array(W * H),
  });
  const session = new RasterGameSession({ prebuiltMap: map, spawnPhaseTicks: 0 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  let owned = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) if (grid.ownerOf(ref) === 1) { owned = ref; break; }
  assert.ok(owned >= 0, "the human is seated on the all-land map");
  grid.setGold(1, 1_000_000);

  session.queueBuild("human", { targetX: map.x(owned), targetY: map.y(owned), building: "port" });
  session.tick();
  assert.ok(rejections(messages).includes("NOT_BUILDABLE"), "no coast within reach — rejected");
  assert.equal(grid.buildingCountOf(1, "port"), 0, "no port placed");
});

test("a second building on the same tile is rejected as occupied", () => {
  const { session, messages, build } = stageBuilder(15);
  session.peekGrid().setGold(1, 1_000_000);
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "city" });
  session.tick();
  session.queueBuild("human", { targetX: build.x, targetY: build.y, building: "port" });
  session.tick();
  assert.ok(rejections(messages).includes("TILE_OCCUPIED"));
  assert.equal(session.peekGrid().buildingCount, 1);
});
