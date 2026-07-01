import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import type { GameMap } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { ATOM_BOMB_COST, ATOM_BOMB_INNER_RADIUS } from "../src/Core/nukes.js";
import { BUILDING_CONSTRUCTION_TICKS, BUILDING_DEFS } from "../src/Core/buildings.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

/** A large flat all-land square GameMap — no water, so any tile is a legal nuke target. */
const landSquareMap = (size: number): GameMap =>
  buildTerrainFromMask({
    width: size,
    height: size,
    land: new Uint8Array(size * size).fill(1),
    elevation: new Uint8Array(size * size),
  });

const landSquare = (size: number): TerritoryGrid => new TerritoryGrid(landSquareMap(size));

/** Claim every tile within `radius` (Chebyshev) of the square's centre to `player`. */
const claimBlock = (grid: TerritoryGrid, player: number, cx: number, cy: number, radius: number): void => {
  const map = grid.map;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (!map.inBounds(x, y)) continue;
      const ref = map.ref(x, y);
      if (grid.isCapturable(ref)) grid.claim(ref, player);
    }
  }
};

// --- RasterConflict: flight + detonation -----------------------------------

test("launchNuke enqueues a nuke that travels toward its target", () => {
  const grid = landSquare(120);
  grid.addPlayer(1, 1);
  claimBlock(grid, 1, 10, 10, 2);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 10, 10, 100, 100);
  const [nuke] = conflict.activeNukes();
  assert.ok(nuke, "the nuke is in flight");
  assert.equal(nuke.attacker, 1);
  assert.equal(nuke.toX, 100);
  assert.equal(nuke.toY, 100);

  conflict.processTick();
  const [afterOneTick] = conflict.activeNukes();
  assert.ok(afterOneTick, "still in flight after one tick");
  const movedCloser =
    Math.abs(afterOneTick.x - 100) < Math.abs(nuke.x - 100) ||
    Math.abs(afterOneTick.y - 100) < Math.abs(nuke.y - 100);
  assert.ok(movedCloser, "the nuke advances toward its target each tick");
});

test("an Atom Bomb clears its inner-radius blast to neutral and bleeds the victim's troops", () => {
  const grid = landSquare(200);
  grid.addPlayer(1, 1); // attacker (irrelevant territory-wise)
  grid.addPlayer(2, 1);
  // Player 2 owns a big block centred on the target — well beyond the outer
  // blast radius on every side, so a margin of owned land always survives and
  // the "proportional to land taken" fraction is meaningfully < 1.
  claimBlock(grid, 2, 100, 100, 65);
  grid.setTroops(2, 100_000);
  // Freeze income so the only thing that moves the pool is the blast itself —
  // otherwise growth over the nuke's ~35-tick flight could outrun the loss.
  grid.setModifiers(2, { ...IDENTITY_MODIFIERS, income: 0 });
  const tilesBefore = grid.tileCountOf(2);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 0, 0, 100, 100);
  let result;
  for (let i = 0; i < 200; i += 1) {
    result = conflict.processTick();
    if (result.nukeDetonations.length > 0) break;
  }
  assert.ok(result && result.nukeDetonations.length > 0, "the nuke detonates within a generous tick budget");
  const detonation = result!.nukeDetonations[0];
  assert.equal(detonation.attacker, 1);
  assert.deepEqual(detonation.victims, [2]);

  // Ground zero and its immediate surroundings (well inside the inner radius)
  // must be fully cleared to neutral.
  const groundZero = grid.map.ref(100, 100);
  assert.equal(grid.ownerOf(groundZero), NEUTRAL_PLAYER, "ground zero is irradiated");
  const nearInner = grid.map.ref(100 + Math.floor(ATOM_BOMB_INNER_RADIUS / 2), 100);
  assert.equal(grid.ownerOf(nearInner), NEUTRAL_PLAYER, "well within the inner radius is fully cleared");

  const tilesAfter = grid.tileCountOf(2);
  assert.ok(tilesAfter < tilesBefore, "the victim lost territory");
  assert.ok(grid.troopsOf(2) < 100_000, "the victim's troop pool bled proportionally to the land lost");
  // Well outside the outer radius (40 tiles) but still inside the owned block
  // (65 tiles), the player's land at the far edge must be untouched.
  const farAway = grid.map.ref(100, 40);
  assert.equal(grid.ownerOf(farAway), 2, "land far from ground zero survives the blast");
});

test("a nuke that hits nobody (neutral land) reports no victims", () => {
  const grid = landSquare(80);
  grid.addPlayer(1, 1);
  claimBlock(grid, 1, 5, 5, 1);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 5, 5, 60, 60); // far neutral land
  let result;
  for (let i = 0; i < 100; i += 1) {
    result = conflict.processTick();
    if (result.nukeDetonations.length > 0) break;
  }
  assert.ok(result && result.nukeDetonations.length > 0);
  assert.deepEqual(result!.nukeDetonations[0].victims, []);
});

test("a real Atom Bomb blast marks its cleared ground as fallout", () => {
  const grid = landSquare(120);
  grid.addPlayer(1, 1);
  grid.addPlayer(2, 1);
  claimBlock(grid, 2, 60, 50, 20);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 0, 0, 60, 50);
  let detonated = false;
  for (let i = 0; i < 60 && !detonated; i += 1) {
    detonated = conflict.processTick().nukeDetonations.length > 0;
  }
  assert.ok(detonated, "the nuke detonates");
  const groundZero = grid.map.ref(60, 50);
  assert.equal(grid.hasFallout(groundZero), true, "ground zero is radioactive fallout");
  assert.equal(grid.ownerOf(groundZero), NEUTRAL_PLAYER, "and cleared to neutral");
  assert.ok(grid.falloutTiles().length > 0, "fallout tiles are exposed for the snapshot");
});

test("fallout blocks an advance onto the tile until it decays, then reopens", () => {
  // Focused grid-level test of the fallout gate + decay, independent of blast
  // geometry: player 1 owns a tile directly left of a hand-set fallout tile.
  const grid = landSquare(20);
  grid.addPlayer(1, 5_000);
  const owned = grid.map.ref(5, 5);
  const target = grid.map.ref(6, 5); // eastern neighbour of the owned tile
  grid.claim(owned, 1);
  grid.setFallout(target, 3);

  assert.ok(
    !grid.landFrontierOf(1, NEUTRAL_PLAYER).includes(target),
    "a radioactive neighbour is excluded from the land frontier",
  );

  const conflict = new RasterConflict(grid);
  conflict.processTick(); // fallout 3 → 2
  conflict.processTick(); // 2 → 1
  assert.equal(grid.hasFallout(target), true, "still radioactive mid-decay");
  conflict.processTick(); // 1 → 0, cleared
  assert.equal(grid.hasFallout(target), false, "fallout has decayed");
  assert.ok(
    grid.landFrontierOf(1, NEUTRAL_PLAYER).includes(target),
    "the recovered tile is back on the frontier",
  );
});

// --- RasterGameSession: end-to-end silo + launch flow ----------------------

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

/** Seat a human on an all-land map — any tile is a legal nuke target, avoiding water flakiness. */
const stageSiloSession = (
  seed: number,
): { session: RasterGameSession; messages: RasterServerMessage[]; origin: { x: number; y: number } } => {
  const session = new RasterGameSession({ prebuiltMap: landSquareMap(160), seed });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  const map = session.peekMap();
  let originRef = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) {
    if (grid.ownerOf(ref) === 1) { originRef = ref; break; }
  }
  assert.ok(originRef >= 0, "the human must be seated");
  return { session, messages, origin: { x: map.x(originRef), y: map.y(originRef) } };
};

/** Ticks a fresh structure needs before it's off the construction window. */
const SILO_READY_TICKS = BUILDING_CONSTRUCTION_TICKS.silo + 1;

test("building a silo then launching an Atom Bomb spends gold, reloads the silo, and hits the target", () => {
  const { session, messages, origin } = stageSiloSession(21);
  const grid = session.peekGrid();
  grid.setGold(1, 10_000_000);

  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "silo" });
  session.tick();
  assert.equal(grid.buildingCountOf(1, "silo"), 1, "the silo is placed");
  const afterSiloCost = 10_000_000 - BUILDING_DEFS.silo.baseCost;
  assert.ok(grid.goldOf(1) <= afterSiloCost + 1000, "the silo's gold cost was spent");

  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();

  const goldBeforeLaunch = grid.goldOf(1);
  const targetX = Math.min(session.peekMap().width - 5, origin.x + 50);
  const targetY = origin.y;
  session.queueNuke("human", { targetX, targetY });
  session.tick();

  assert.ok(!rejections(messages).slice(-1).includes("NO_SILO_READY"), "the finished silo is ready to fire");
  assert.ok(grid.goldOf(1) <= goldBeforeLaunch - ATOM_BOMB_COST + 1000, "the Atom Bomb's gold cost was spent");

  const snap = lastSnapshot(messages);
  assert.ok(
    snap.recentEvents.some((line) => line.includes("launched an Atom Bomb")),
    "the launch is recorded in the event log",
  );
});

test("a silo on cooldown refuses a second launch", () => {
  const { session, messages, origin } = stageSiloSession(22);
  const grid = session.peekGrid();
  grid.setGold(1, 10_000_000);
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "silo" });
  session.tick();
  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();

  const targetX = Math.min(session.peekMap().width - 5, origin.x + 50);
  session.queueNuke("human", { targetX, targetY: origin.y });
  session.tick();
  assert.ok(!rejections(messages).slice(-1).includes("NO_SILO_READY"), "the first launch succeeds");
  session.queueNuke("human", { targetX, targetY: origin.y });
  session.tick();
  assert.ok(rejections(messages).slice(-1).includes("NO_SILO_READY"), "the second launch is rejected while reloading");
});

test("launching without a silo is rejected", () => {
  const { session, messages, origin } = stageSiloSession(23);
  session.peekGrid().setGold(1, 10_000_000);
  const targetX = Math.min(session.peekMap().width - 5, origin.x + 50);
  session.queueNuke("human", { targetX, targetY: origin.y });
  session.tick();
  assert.ok(rejections(messages).includes("NO_SILO_READY"));
});

test("launching without enough gold is rejected", () => {
  const { session, messages, origin } = stageSiloSession(24);
  const grid = session.peekGrid();
  grid.setGold(1, BUILDING_DEFS.silo.baseCost); // just enough for the silo, none left for a bomb
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "silo" });
  session.tick();
  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();
  const targetX = Math.min(session.peekMap().width - 5, origin.x + 50);
  session.queueNuke("human", { targetX, targetY: origin.y });
  session.tick();
  assert.ok(rejections(messages).includes("INSUFFICIENT_GOLD"));
});

test("targeting open water is rejected", () => {
  // Land everywhere except a known water strip on the map's right edge, so a
  // water target can be picked by coordinate instead of an uncertain search.
  const width = 100;
  const height = 50;
  const land = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y += 1) {
    for (let x = width - 10; x < width; x += 1) land[y * width + x] = 0;
  }
  const map = buildTerrainFromMask({ width, height, land, elevation: new Uint8Array(width * height) });
  const session = new RasterGameSession({ prebuiltMap: map, seed: 25 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const grid = session.peekGrid();
  let originRef = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) {
    if (grid.ownerOf(ref) === 1) { originRef = ref; break; }
  }
  assert.ok(originRef >= 0 && map.isLand(originRef), "the human spawns on the land majority");
  grid.setGold(1, 10_000_000);
  session.queueBuild("human", { targetX: map.x(originRef), targetY: map.y(originRef), building: "silo" });
  session.tick();

  assert.ok(map.isWater(map.ref(width - 5, height / 2)), "the target tile is really water");
  session.queueNuke("human", { targetX: width - 5, targetY: height / 2 });
  session.tick();
  assert.ok(rejections(messages).includes("INVALID_TILE"));
});

test("nuking an ally severs the alliance and marks the nuker a traitor", () => {
  const session = new RasterGameSession({ prebuiltMap: landSquareMap(160), seed: 26 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  session.subscribe("rival", () => {});
  const grid = session.peekGrid();
  const map = session.peekMap();

  let humanOrigin = -1;
  let rivalOrigin = -1;
  for (let ref = 0; ref < grid.owner.length; ref += 1) {
    if (grid.ownerOf(ref) === 1) humanOrigin = ref;
    if (grid.ownerOf(ref) === 2) rivalOrigin = ref;
  }
  assert.ok(humanOrigin >= 0 && rivalOrigin >= 0);

  // Ally the two, then give the rival a big block right where the human will nuke.
  session.proposeAlliance("human", 2);
  session.respondAlliance("rival", 1, true);
  claimBlock(grid, 2, map.x(rivalOrigin), map.y(rivalOrigin), 10);
  grid.setGold(1, 10_000_000);

  session.queueBuild("human", { targetX: map.x(humanOrigin), targetY: map.y(humanOrigin), building: "silo" });
  session.tick();
  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();
  session.queueNuke("human", { targetX: map.x(rivalOrigin), targetY: map.y(rivalOrigin) });

  let allied = true;
  for (let i = 0; i < 200 && allied; i += 1) {
    session.tick();
    allied = session.peekAlliances().areAllied(1, 2);
  }
  assert.equal(allied, false, "nuking an ally breaks the alliance");
  const snap = lastSnapshot(messages);
  assert.ok(
    snap.recentEvents.some((line) => line.includes("nuked their ally")),
    "the betrayal is recorded in the event log",
  );
});
