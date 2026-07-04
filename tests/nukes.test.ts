import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import type { GameMap } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import {
  ATOM_BOMB_COST,
  ATOM_BOMB_INNER_RADIUS,
  HYDROGEN_BOMB_COST,
  MIRV_BASE_COST,
  MIRV_COST_PER_SILO,
  MIRV_SCATTER_RADIUS,
  MIRV_WARHEAD_COUNT,
  nukeBlast,
  nukeCost,
} from "../src/Core/nukes.js";
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

test("fallout is permanent, stays capturable, and is scrubbed only by conquest (OpenFront)", () => {
  // Focused grid-level test of OpenFront's fallout rule, independent of blast
  // geometry: player 1 owns a tile directly left of a hand-set fallout tile.
  // Fallout never decays on its own; the ground stays on the frontier (dearer
  // and slower via falloutCombatModifier), and conquering it lifts the mark —
  // OpenFront's `conquer(...) → setFallout(tile, false)`.
  const grid = landSquare(20);
  grid.addPlayer(1, 5_000);
  const owned = grid.map.ref(5, 5);
  const target = grid.map.ref(6, 5); // eastern neighbour of the owned tile
  grid.claim(owned, 1);
  grid.setFallout(target);

  assert.ok(
    grid.landFrontierOf(1, NEUTRAL_PLAYER).includes(target),
    "a radioactive neighbour stays on the land frontier (capturable at a penalty)",
  );

  const conflict = new RasterConflict(grid);
  for (let i = 0; i < 30; i += 1) conflict.processTick();
  assert.equal(grid.hasFallout(target), true, "fallout never decays on its own");

  conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 4_000 });
  for (let i = 0; i < 30 && grid.ownerOf(target) !== 1; i += 1) conflict.processTick();
  assert.equal(grid.ownerOf(target), 1, "the irradiated tile can be conquered");
  assert.equal(grid.hasFallout(target), false, "conquest scrubs the fallout mark");
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

// --- Hydrogen Bomb / MIRV: pure formulas ------------------------------------

test("nukeCost matches each warhead tier's documented formula", () => {
  assert.equal(nukeCost("atom", 0), ATOM_BOMB_COST);
  assert.equal(nukeCost("atom", 7), ATOM_BOMB_COST, "atom cost doesn't scale with silos owned");
  assert.equal(nukeCost("hydrogen", 3), HYDROGEN_BOMB_COST);
  assert.equal(nukeCost("mirv", 0), MIRV_BASE_COST);
  assert.equal(nukeCost("mirv", 1), MIRV_BASE_COST + MIRV_COST_PER_SILO);
  assert.equal(nukeCost("mirv", 4), MIRV_BASE_COST + 4 * MIRV_COST_PER_SILO);
});

test("nukeBlast gives the Hydrogen Bomb a bigger footprint than the Atom Bomb, and a MIRV warhead the Atom Bomb's own", () => {
  const atom = nukeBlast("atom");
  const hydrogen = nukeBlast("hydrogen");
  const mirv = nukeBlast("mirv");
  assert.ok(hydrogen.inner > atom.inner && hydrogen.outer > atom.outer, "Hydrogen Bomb blasts a larger area");
  assert.deepEqual(mirv, atom, "a MIRV's individual warheads are atom-sized");
});

// --- MIRV: engine-level warhead split ---------------------------------------

test("launchNuke with kind 'mirv' splits into MIRV_WARHEAD_COUNT independent, scattered warheads", () => {
  const grid = landSquare(200);
  grid.addPlayer(1, 1);
  claimBlock(grid, 1, 10, 10, 2);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 10, 10, 100, 100, "mirv");
  const warheads = conflict.activeNukes();
  assert.equal(warheads.length, MIRV_WARHEAD_COUNT, "the launch produced one flight per warhead");

  const seenIds = new Set<number>();
  for (const w of warheads) {
    assert.equal(w.kind, "mirv");
    assert.equal(w.attacker, 1);
    seenIds.add(w.id);
    const dx = w.toX - 100;
    const dy = w.toY - 100;
    assert.ok(
      Math.sqrt(dx * dx + dy * dy) <= MIRV_SCATTER_RADIUS + 0.001,
      "each warhead's aim point lands within the scatter radius of the target",
    );
  }
  assert.equal(seenIds.size, MIRV_WARHEAD_COUNT, "every warhead has a distinct id");
});

test("a MIRV's scattered warheads can detonate on separate ticks, each with the Atom Bomb's blast", () => {
  const grid = landSquare(220);
  grid.addPlayer(1, 1);
  grid.addPlayer(2, 1);
  claimBlock(grid, 2, 150, 150, 60);
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 0, 0, 150, 150, "mirv");
  let detonations = 0;
  for (let i = 0; i < 120 && detonations < MIRV_WARHEAD_COUNT; i += 1) {
    const result = conflict.processTick();
    for (const d of result.nukeDetonations) {
      assert.equal(d.kind, "mirv");
      detonations += 1;
    }
  }
  assert.equal(detonations, MIRV_WARHEAD_COUNT, "every scattered warhead eventually detonates");
});

// --- SAM Launcher: building + interception ----------------------------------

test("a SAM Launcher never intercepts its own owner's warhead", () => {
  const grid = landSquare(100);
  grid.addPlayer(1, 1);
  const samRef = grid.map.ref(50, 50);
  grid.claim(samRef, 1);
  grid.placeBuilding(samRef, "sam");
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 0, 0, 50, 50, "atom");
  let result;
  for (let i = 0; i < 60; i += 1) {
    result = conflict.processTick();
    if (result.nukeDetonations.length > 0 || result.nukeInterceptions.length > 0) break;
  }
  assert.equal(result!.nukeInterceptions.length, 0, "an own SAM never engages its owner's warhead");
  assert.equal(result!.nukeDetonations.length, 1, "the warhead detonates unimpeded");
});

test("a hostile SAM Launcher can intercept an incoming warhead before it detonates", () => {
  // Deterministic hashing means a single trial's hit/miss depends on the exact
  // (SAM tile, warhead id) pair; run several independent trials (varying the
  // SAM's position, which varies the hash) so the test isn't flaky on an
  // unlucky draw while still proving interception actually happens.
  let intercepted = 0;
  let resolved = 0;
  for (let trial = 0; trial < 10; trial += 1) {
    const grid = landSquare(100);
    grid.addPlayer(1, 1); // attacker
    grid.addPlayer(2, 1); // SAM owner
    const samX = 40 + trial;
    const samY = 50;
    const samRef = grid.map.ref(samX, samY);
    grid.claim(samRef, 2);
    grid.placeBuilding(samRef, "sam");
    const conflict = new RasterConflict(grid);

    conflict.launchNuke(1, 0, 0, samX, samY, "atom");
    for (let i = 0; i < 60; i += 1) {
      const result = conflict.processTick();
      if (result.nukeInterceptions.length > 0) {
        intercepted += 1;
        resolved += 1;
        break;
      }
      if (result.nukeDetonations.length > 0) {
        resolved += 1;
        break;
      }
    }
  }
  assert.equal(resolved, 10, "every trial resolved one way or the other");
  assert.ok(intercepted > 0, "at least one of 10 trials was shot down by the SAM");
});

test("a SAM Launcher's cooldown is consumed on its first attempt, letting a second warhead through unimpeded", () => {
  const grid = landSquare(100);
  grid.addPlayer(1, 1); // attacker
  grid.addPlayer(2, 1); // SAM owner
  const samRef = grid.map.ref(50, 50);
  grid.claim(samRef, 2);
  grid.placeBuilding(samRef, "sam");
  const conflict = new RasterConflict(grid);

  conflict.launchNuke(1, 0, 0, 50, 50, "atom");
  let firstResolved = false;
  for (let i = 0; i < 60 && !firstResolved; i += 1) {
    const result = conflict.processTick();
    firstResolved = result.nukeDetonations.length > 0 || result.nukeInterceptions.length > 0;
  }
  assert.ok(firstResolved, "the first warhead resolves (hit or miss)");

  conflict.launchNuke(1, 0, 0, 50, 50, "atom");
  let secondDetonated = false;
  for (let i = 0; i < 60 && !secondDetonated; i += 1) {
    const result = conflict.processTick();
    assert.equal(result.nukeInterceptions.length, 0, "the SAM is still reloading and can't engage the second warhead");
    if (result.nukeDetonations.length > 0) secondDetonated = true;
  }
  assert.ok(secondDetonated, "the second warhead detonates unimpeded while the SAM reloads");
});

// --- RasterGameSession: Hydrogen Bomb / MIRV launch flow --------------------

test("a Hydrogen Bomb launch spends HYDROGEN_BOMB_COST and is recorded by name", () => {
  const { session, messages, origin } = stageSiloSession(31);
  const grid = session.peekGrid();
  grid.setGold(1, 20_000_000);
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "silo" });
  session.tick();
  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();

  const goldBeforeLaunch = grid.goldOf(1);
  const targetX = Math.min(session.peekMap().width - 5, origin.x + 50);
  session.queueNuke("human", { targetX, targetY: origin.y, kind: "hydrogen" });
  session.tick();

  assert.ok(!rejections(messages).slice(-1).includes("NO_SILO_READY"));
  assert.ok(grid.goldOf(1) <= goldBeforeLaunch - HYDROGEN_BOMB_COST + 1000, "the Hydrogen Bomb's gold cost was spent");
  const snap = lastSnapshot(messages);
  assert.ok(snap.recentEvents.some((line) => line.includes("launched a Hydrogen Bomb")));
});

test("a MIRV launch's cost scales with how many silos the attacker owns", () => {
  const { session, messages, origin } = stageSiloSession(32);
  const grid = session.peekGrid();
  grid.setGold(1, 100_000_000);
  session.queueBuild("human", { targetX: origin.x, targetY: origin.y, building: "silo" });
  session.tick();
  for (let i = 0; i < SILO_READY_TICKS; i += 1) session.tick();

  // A second silo, for the cost formula's silo count: claimed and placed
  // directly (the human owns only their single spawn tile in this bare
  // session, with no expansion, so a second build order via the normal
  // click flow would have nowhere legal to land).
  const map = session.peekMap();
  const secondSiloX = Math.min(map.width - 2, origin.x + 30);
  const secondSiloRef = map.ref(secondSiloX, origin.y);
  grid.claim(secondSiloRef, 1);
  grid.placeBuilding(secondSiloRef, "silo");
  assert.equal(grid.buildingCountOf(1, "silo"), 2, "both silos are placed");

  const goldBeforeLaunch = grid.goldOf(1);
  const targetX = Math.min(session.peekMap().width - 5, origin.x + 60);
  session.queueNuke("human", { targetX, targetY: origin.y, kind: "mirv" });
  session.tick();

  assert.ok(!rejections(messages).slice(-1).includes("NO_SILO_READY"));
  const expectedCost = MIRV_BASE_COST + 2 * MIRV_COST_PER_SILO;
  assert.ok(
    grid.goldOf(1) <= goldBeforeLaunch - expectedCost + 1000,
    "the MIRV's gold cost reflects both owned silos",
  );
  const snap = lastSnapshot(messages);
  assert.ok(snap.recentEvents.some((line) => line.includes("launched a MIRV")));
});
