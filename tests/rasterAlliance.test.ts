import test from "node:test";
import assert from "node:assert/strict";
import { GameMap, type TileRef } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { AllianceRegistry } from "../src/Core/alliances.js";
import { encodeTile } from "../src/Core/terrainCodec.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController, type RasterBotPersonality } from "../src/Server/RasterBotController.js";
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
  assert.deepEqual(snap.alliances, [[1, 2]], "the formed alliance is broadcast");
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

const DEFENSIVE: RasterBotPersonality = {
  id: "test-defensive",
  decisionCooldownTicks: 0,
  minPool: 1,
  reserveFraction: 0.2,
  expandCommit: 0.7,
  attackCommit: 0.6,
  attackPoolRatio: 1.6,
  aggression: 0.2,
};

const AGGRESSIVE: RasterBotPersonality = {
  id: "test-aggressive",
  decisionCooldownTicks: 0,
  minPool: 1,
  reserveFraction: 0.1,
  expandCommit: 0.8,
  attackCommit: 0.9,
  attackPoolRatio: 1.0,
  aggression: 0.9,
};

test("a defensive bot accepts an alliance offer", () => {
  const session = new RasterGameSession({ width: 40, height: 28, seed: 11 });
  session.subscribe("human", () => {}); // player 1
  const bot = new RasterBotController({ botId: "bot", personality: DEFENSIVE });
  bot.attach(session); // player 2

  session.proposeAlliance("human", bot.getPlayerId()!);
  for (let i = 0; i < 5; i += 1) session.tick();

  assert.equal(session.peekAlliances().areAllied(1, bot.getPlayerId()!), true);
});

test("an aggressive bot declines an offer from a weaker nation", () => {
  const session = new RasterGameSession({ width: 40, height: 28, seed: 11 });
  session.subscribe("human", () => {}); // player 1
  const bot = new RasterBotController({ botId: "bot", personality: AGGRESSIVE });
  bot.attach(session); // player 2
  const botId = bot.getPlayerId()!;

  // Make the human clearly the weaker party, so a ruthless bot has no reason to ally.
  session.peekGrid().setTroops(1, 1);
  session.proposeAlliance("human", botId);
  for (let i = 0; i < 5; i += 1) session.tick();

  assert.equal(session.peekAlliances().areAllied(1, botId), false, "the offer is not accepted");
  assert.deepEqual(session.peekAlliances().incomingProposals(botId), [], "the offer is declined, not left pending");
});
