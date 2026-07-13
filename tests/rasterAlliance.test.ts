import test from "node:test";
import assert from "node:assert/strict";
import { GameMap, type TileRef } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { ALLIANCE_DURATION_TICKS, AllianceRegistry } from "../src/Core/alliances.js";
import { encodeTile } from "../src/Core/terrainCodec.js";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController } from "../src/Server/RasterBotController.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

const flatLand = (width: number, height: number): GameMap => {
  const terrain = new Uint8Array(width * height);
  terrain.fill(encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 }));
  return new GameMap(width, height, terrain);
};

const allianceOf = (a: number, b: number): AllianceRegistry => {
  const reg = new AllianceRegistry();
  reg.propose(a, b);
  reg.accept(b, a);
  return reg;
};

// ---- Engine: allied players can't attack each other ----------------------

test("launchAttack refuses to attack an ally, leaving the pool untouched", () => {
  const grid = new TerritoryGrid(flatLand(4, 1));
  grid.addPlayer(1, 20);
  grid.addPlayer(2, 20);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(2, 2);
  grid.claim(3, 2);
  const allies = allianceOf(1, 2);
  const conflict = new RasterConflict(grid, allies);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 10 }), "ALLIED");
  assert.equal(grid.troopsOf(1), 20, "no troops are committed against an ally");
  assert.equal(conflict.activeAttackCount, 0);

  // Breaking the pact reopens the assault.
  allies.breakAlliance(1, 2);
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 10 }), null);
  assert.equal(grid.troopsOf(1), 10, "with the pact gone the attack commits normally");
});

test("an alliance forged mid-attack stands the front down and refunds in full", () => {
  const grid = new TerritoryGrid(flatLand(4, 1));
  grid.addPlayer(1, 20);
  grid.addPlayer(2, 100); // dense enough that the assault doesn't instantly win
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(2, 2);
  grid.claim(3, 2);
  const allies = new AllianceRegistry();
  const conflict = new RasterConflict(grid, allies);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 20 }), null);
  assert.equal(grid.troopsOf(1), 0, "committed troops leave the pool");

  // Peace breaks out before the front resolves.
  allies.propose(1, 2);
  allies.accept(2, 1);
  conflict.processTick();

  assert.equal(grid.tileCountOf(2), 2, "the ally keeps every tile");
  assert.equal(conflict.activeAttackCount, 0, "the attack is dropped");
  assert.ok(grid.troopsOf(1) >= 20, "the troops come home in full (a peace, not a defeat)");
});

test("launchShip refuses an amphibious assault on an ally's shore", () => {
  // Two 1-tile islands separated by a single water tile, bridged by a sea link.
  const terrain = new Uint8Array(3);
  terrain[0] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 0 });
  terrain[1] = encodeTile({ land: false, shoreline: false, ocean: true, magnitude: 0 });
  terrain[2] = encodeTile({ land: true, shoreline: true, ocean: false, magnitude: 0 });
  const grid = new TerritoryGrid(new GameMap(3, 1, terrain));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(0, 1);
  grid.claim(2, 2);
  const allies = allianceOf(1, 2);
  const conflict = new RasterConflict(grid, allies);

  const dest: TileRef = 2;
  assert.equal(conflict.launchShip({ attacker: 1, dest, troops: 20 }), "ALLIED");
  assert.equal(grid.troopsOf(1), 50, "no troops board a ship bound for an ally");
});

// ---- Session: the propose / accept / break protocol ----------------------

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

/** Two adjacent neutral, capturable tiles on the session's map (or throws). */
const adjacentNeutralPair = (session: RasterGameSession): [TileRef, TileRef] => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let ref = 0; ref < map.size; ref += 1) {
    if (!grid.isCapturable(ref) || grid.ownerOf(ref) !== NEUTRAL_PLAYER) continue;
    for (const n of map.neighbors(ref)) {
      if (grid.isCapturable(n) && grid.ownerOf(n) === NEUTRAL_PLAYER && n !== ref) return [ref, n];
    }
  }
  throw new Error("no adjacent neutral land on this map");
};

test("propose + accept forms an alliance carried in the snapshot", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1"); // player 1
  collect(session, "c2"); // player 2

  session.proposeAlliance("c1", 2);
  session.tick();
  let snap = lastSnapshot(c1);
  assert.deepEqual(snap.allianceRequests, [{ from: 1, to: 2 }], "the pending offer is broadcast");
  assert.deepEqual(snap.alliances, [], "no alliance until accepted");

  session.respondAlliance("c2", 1, true);
  assert.equal(session.peekAlliances().areAllied(1, 2), true);
  session.tick();
  snap = lastSnapshot(c1);
  assert.equal(snap.alliances.length, 1, "the formed alliance is broadcast");
  assert.equal(snap.alliances[0].a, 1);
  assert.equal(snap.alliances[0].b, 2);
  assert.ok(
    snap.alliances[0].ticksLeft > 0 && snap.alliances[0].ticksLeft <= ALLIANCE_DURATION_TICKS,
    "a fresh pact carries its remaining lifetime",
  );
  assert.deepEqual(snap.alliances[0].renewVotes, [], "no renewal votes yet");
  assert.deepEqual(snap.allianceRequests, [], "the offer is cleared once accepted");
});

test("a crossing proposal auto-accepts; declining and breaking work too", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  collect(session, "c1");
  collect(session, "c2");
  const reg = session.peekAlliances();

  // Crossing offers seal the pact at once.
  session.proposeAlliance("c2", 1);
  session.proposeAlliance("c1", 2);
  assert.equal(reg.areAllied(1, 2), true);

  // Break it, then a declined re-offer leaves no alliance.
  session.breakAlliance("c1", 2);
  assert.equal(reg.areAllied(1, 2), false);
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, false);
  assert.equal(reg.areAllied(1, 2), false);
  assert.deepEqual(reg.incomingProposals(2), [], "a declined offer is cleared");
});

test("expanding into an ally's land is rejected with ALLIED", () => {
  const session = new RasterGameSession({ width: 40, height: 28, seed: 9 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  const grid = session.peekGrid();
  const map = session.peekMap();

  // Stage a shared land border between the two players, then ally them.
  const [a, b] = adjacentNeutralPair(session);
  grid.claim(a, 1);
  grid.claim(b, 2);
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);

  session.queueExpand("c1", { targetX: map.x(b), targetY: map.y(b), percent: 50 });
  session.tick();

  const rejected = c1.find(
    (m): m is Extract<RasterServerMessage, { type: "SERVER_RASTER_ACTION_REJECTED" }> =>
      m.type === "SERVER_RASTER_ACTION_REJECTED" && m.payload.reason === "ALLIED",
  );
  assert.ok(rejected, "an order against an ally's tile is rejected as ALLIED");
  assert.equal(grid.ownerOf(b), 2, "the ally keeps the tile");
});

// ---- Bots: respond to and seek alliances ---------------------------------

test("an easy nation honours the earlygame honeymoon: an early offer is accepted", () => {
  // Flat map split down the middle: nobody can hit the 80% win and freeze the
  // clock before the nation's decision beats.
  const flatW = 60;
  const flatH = 20;
  const flat = buildTerrainFromMask({
    width: flatW, height: flatH,
    land: new Uint8Array(flatW * flatH).fill(1),
    elevation: new Uint8Array(flatW * flatH),
  });
  const session = new RasterGameSession({ prebuiltMap: flat, spawnPhaseTicks: 0 });
  session.subscribe("human", () => {}); // player 1
  const bot = new RasterBotController({ botId: "honeymoon", kind: "nation", difficulty: "easy", seed: 0 });
  bot.attach(session); // player 2
  const botId = bot.getPlayerId()!;
  const grid = session.peekGrid();
  session.tick();
  for (let y = 0; y < flatH; y += 1) {
    for (let x = 0; x < flatW; x += 1) {
      grid.claim(y * flatW + x, x < 30 ? 1 : botId);
    }
  }
  grid.setTroops(1, 5_000_000);

  // OpenFront's Easy nations accept ~90% of offers in the first five minutes
  // (the earlygame honeymoon); this seat's fixed PRNG stream accepts.
  session.proposeAlliance("human", botId);
  let allied = false;
  for (let i = 0; i < 300 && !allied; i += 1) {
    session.tick();
    allied = session.peekAlliances().areAllied(1, botId);
  }
  assert.equal(allied, true, "the early offer was accepted");
});

test("a nation declines an offer from someone who just attacked it", () => {
  const flatW = 60;
  const flatH = 20;
  const flat = buildTerrainFromMask({
    width: flatW, height: flatH,
    land: new Uint8Array(flatW * flatH).fill(1),
    elevation: new Uint8Array(flatW * flatH),
  });
  const session = new RasterGameSession({ prebuiltMap: flat, spawnPhaseTicks: 0 });
  session.subscribe("human", () => {}); // player 1
  // Impossible: no coin-flip confusion, and the weak human is no "threat", so
  // the grudge (relation < neutral after being attacked) decides — a refusal.
  const bot = new RasterBotController({ botId: "grudge", kind: "nation", difficulty: "impossible", seed: 0 });
  bot.attach(session); // player 2
  const botId = bot.getPlayerId()!;
  const grid = session.peekGrid();
  session.tick();
  for (let y = 0; y < flatH; y += 1) {
    for (let x = 0; x < flatW; x += 1) {
      grid.claim(y * flatW + x, x < 30 ? 1 : botId);
    }
  }

  // The human strikes first — the attacked nation's attitude bottoms out —
  // then extends a hollow hand.
  session.queueExpand("human", { targetX: 31, targetY: 10, percent: 1 });
  session.tick();
  grid.setTroops(1, 100); // no longer a threat worth appeasing
  session.proposeAlliance("human", botId);

  let responded = false;
  for (let i = 0; i < 300 && !responded; i += 1) {
    session.tick();
    responded = session.peekAlliances().incomingProposals(botId).length === 0;
  }
  assert.ok(responded, "the offer was answered");
  assert.equal(session.peekAlliances().areAllied(1, botId), false, "the grudge wins: no alliance");
});

test("a pact expires naturally after its lifetime — announced, no betrayal tally", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  assert.equal(session.peekAlliances().areAllied(1, 2), true);

  // Generous over-run: covers any spawn-phase ticks before the pact's clock ran.
  for (let i = 0; i < ALLIANCE_DURATION_TICKS + 200; i += 1) session.tick();

  assert.equal(session.peekAlliances().areAllied(1, 2), false, "the pact lapsed on its own");
  const snap = lastSnapshot(c1);
  assert.deepEqual(snap.alliances, [], "no alliance in the snapshot after expiry");
  assert.ok(
    snap.recentEvents.some((e) => e.includes("has expired")),
    "the lapse is announced as an event",
  );
  const p1 = snap.players.find((p) => p.playerId === 1);
  assert.equal(p1?.betrayals, 0, "natural expiry is not a betrayal");
});

test("renewal votes flow through the session and restart the pact's clock", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);

  for (let i = 0; i < 50; i += 1) session.tick();
  const before = lastSnapshot(c1).alliances[0].ticksLeft;

  session.renewAlliance("c1", 2);
  session.tick();
  assert.deepEqual(lastSnapshot(c1).alliances[0].renewVotes, [1], "the first vote is visible");

  session.renewAlliance("c2", 1);
  session.tick();
  const after = lastSnapshot(c1).alliances[0];
  assert.deepEqual(after.renewVotes, [], "votes clear once the pact renews");
  assert.ok(after.ticksLeft > before, "the renewed pact outlives its old deadline");
});

test("an explicit break is tallied in the snapshot's betrayal count", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  session.breakAlliance("c1", 2);
  session.tick();

  const snap = lastSnapshot(c1);
  assert.equal(snap.players.find((p) => p.playerId === 1)?.betrayals, 1, "the breaker is marked");
  assert.equal(snap.players.find((p) => p.playerId === 2)?.betrayals, 0, "the betrayed side stays clean");
});

test("donating troops to an ally moves pool from donor to recipient", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  collect(session, "c1");
  collect(session, "c2");
  const grid = session.peekGrid();
  grid.setGold(1, 0);
  // Ally the two, then donate 50% of player 1's troops to player 2.
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  const before1 = grid.troopsOf(1);
  const before2 = grid.troopsOf(2);
  session.donate("c1", 2, "troops", 50);
  const moved = before1 - grid.troopsOf(1);
  assert.ok(moved > 0, "the donor's pool falls");
  assert.equal(grid.troopsOf(2) - before2, moved, "the ally receives exactly what the donor sent");
});

test("donating is refused between non-allies", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  collect(session, "c1");
  collect(session, "c2");
  const grid = session.peekGrid();
  const before1 = grid.troopsOf(1);
  session.donate("c1", 2, "troops", 50); // not allied
  assert.equal(grid.troopsOf(1), before1, "no troops leave when the two aren't allied");
});

test("gold donation transfers gold to an ally", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  collect(session, "c1");
  collect(session, "c2");
  const grid = session.peekGrid();
  grid.setGold(1, 100_000);
  grid.setGold(2, 0);
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  session.donate("c1", 2, "gold", 25);
  assert.equal(grid.goldOf(1), 75_000, "donor keeps the rest");
  assert.equal(grid.goldOf(2), 25_000, "ally gets the donated gold");
});

test("an embargo is carried in the snapshot and auto-set on betrayal", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  session.setEmbargo("c1", 2, true);
  session.tick();
  assert.deepEqual(lastSnapshot(c1).embargoes, [[1, 2]], "the embargo shows in the snapshot");

  session.setEmbargo("c1", 2, false);
  session.tick();
  assert.deepEqual(lastSnapshot(c1).embargoes, [], "lifting clears it");

  // Betrayal auto-embargoes.
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  session.breakAlliance("c1", 2);
  session.tick();
  assert.deepEqual(lastSnapshot(c1).embargoes, [[1, 2]], "betrayal raises an automatic embargo");
});

test("a target request reaches the ally in the snapshot", () => {
  const session = new RasterGameSession({ width: 40, height: 28, seed: 9 });
  const c1 = collect(session, "c1"); // player 1
  collect(session, "c2"); // player 2
  // A third player to name as the target (headless nation seat → player 3).
  session.subscribe("c3", () => {}, true, false, undefined, "nation");
  session.proposeAlliance("c1", 2);
  session.respondAlliance("c2", 1, true);
  session.requestTarget("c1", 2, 3);
  session.tick();
  const reqs = lastSnapshot(c1).targetRequests;
  assert.ok(reqs.some((r) => r.from === 1 && r.to === 2 && r.target === 3), "the request is broadcast to the ally");
});

test("an emoji reaction rides the snapshot, then ages out, and is rate-limited", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 7 });
  const c1 = collect(session, "c1");
  collect(session, "c2");
  session.sendEmoji("c1", 2, 0);
  session.tick();
  const first = lastSnapshot(c1).emojis;
  assert.equal(first.length, 1, "the emoji floats in the snapshot");
  assert.equal(first[0].from, 1);
  assert.equal(first[0].emoji, 0);

  // A second emoji immediately is dropped (rate limit).
  session.sendEmoji("c1", 2, 1);
  session.tick();
  assert.equal(lastSnapshot(c1).emojis.length, 1, "a spammed second emoji is rate-limited");

  // After the lifetime elapses the reaction is gone.
  for (let i = 0; i < 25; i += 1) session.tick();
  assert.equal(lastSnapshot(c1).emojis.length, 0, "the reaction ages out");
});
