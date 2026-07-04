import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { resolveHeightmapSessionMap } from "../src/Server/sessionMap.js";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

/** Build a GameMap from rows of '#' (land) / '.' (water) for hand-authored scenarios. */
const mapFromRows = (rows: string[]) => {
  const height = rows.length;
  const width = rows[0].length;
  const land = new Uint8Array(width * height);
  const elevation = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (rows[y][x] !== ".") land[y * width + x] = 1;
  return buildTerrainFromMask({ width, height, land, elevation });
};

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

/**
 * Stage a sea assault for player 1 on a hand-authored map: give player 1 a
 * coastal foothold and return a neutral tile on a *different* landmass that a
 * transport can reach by water — so the only way there is by ship. Footholds
 * that reach nothing are reverted, leaving exactly the one that works claimed.
 */
const stageSeaTarget = (session: RasterGameSession): { x: number; y: number } => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  const spawnComp = (() => {
    for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) === 1) return grid.landComponentId(ref);
    return -1;
  })();
  for (let a = 0; a < map.size; a += 1) {
    if (!grid.isCapturable(a) || !map.isShore(a) || grid.ownerOf(a) !== 0) continue;
    const compA = grid.landComponentId(a);
    grid.claim(a, 1); // player 1 gains a coast on landmass A
    for (let b = 0; b < map.size; b += 1) {
      if (grid.ownerOf(b) !== 0 || !grid.isCapturable(b)) continue;
      const compB = grid.landComponentId(b);
      // b must be a different landmass from both the foothold and the spawn, so
      // the only route is a boat.
      if (compB === compA || compB === spawnComp) continue;
      if (grid.findSeaPath(1, b) !== null) return { x: map.x(b), y: map.y(b) };
    }
    grid.claim(a, NEUTRAL_PLAYER); // this foothold reached nothing — revert it
  }
  throw new Error("no cross-landmass sea target on this map");
};

test("first subscriber gets PLAYER_ASSIGNED and an initial snapshot with terrain", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  assert.equal(messages[0].type, "SERVER_RASTER_PLAYER_ASSIGNED");
  assert.equal(messages[1].type, "SERVER_RASTER_SNAPSHOT");
  const snap = messages[1];
  if (snap.type !== "SERVER_RASTER_SNAPSHOT") throw new Error("type");
  assert.ok(snap.payload.terrainBase64, "first snapshot must include terrain bytes");
  assert.equal(snap.payload.width, 32);
  assert.equal(snap.payload.height, 24);
});

test("subsequent snapshots omit terrainBase64", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  session.tick();
  const snaps = messages.filter((m): m is Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }> => m.type === "SERVER_RASTER_SNAPSHOT");
  assert.equal(snaps.length, 2);
  assert.ok(snaps[0].payload.terrainBase64);
  assert.equal(snaps[1].payload.terrainBase64, undefined);
});

test("two subscribers get distinct playerIds and distinct spawn tiles", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 9 });
  const a: RasterServerMessage[] = [];
  const b: RasterServerMessage[] = [];
  session.subscribe("alice", (m) => a.push(m));
  session.subscribe("bob", (m) => b.push(m));

  const aId = a[0].type === "SERVER_RASTER_PLAYER_ASSIGNED" ? a[0].payload.playerId : -1;
  const bId = b[0].type === "SERVER_RASTER_PLAYER_ASSIGNED" ? b[0].payload.playerId : -1;
  assert.notEqual(aId, bId);

  // After both join, each holds its own founding blob (disjoint by construction:
  // a blob claims only unowned land).
  const grid = session.peekGrid();
  let claimedA = 0, claimedB = 0;
  for (let i = 0; i < grid.owner.length; i += 1) {
    if (grid.owner[i] === aId) claimedA += 1;
    if (grid.owner[i] === bId) claimedB += 1;
  }
  assert.ok(claimedA > 1, "alice holds her founding blob");
  assert.ok(claimedB > 1, "bob holds his founding blob");
});

test("startingTroops option seeds each player's pool", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3, startingTroops: 123 });
  session.subscribe("human", () => {});
  const grid = session.peekGrid();
  // The human is player 1; income has not run yet (no tick), so the pool equals
  // the configured starting troops — proving the option is actually applied.
  assert.equal(grid.troopsOf(1), 123);
});

test("queueExpand with invalid tile is rejected on tick", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  session.queueExpand("human", { targetX: 1000, targetY: 1000, percent: 50 });
  session.tick();
  const rejected = messages.find((m) => m.type === "SERVER_RASTER_ACTION_REJECTED");
  assert.ok(rejected, "out-of-bounds tile must be rejected");
  if (rejected?.type === "SERVER_RASTER_ACTION_REJECTED") {
    assert.equal(rejected.payload.reason, "INVALID_TILE");
  }
});

test("queued expands from one client are capped between ticks (flood protection)", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  // Flood far more intents than any human could click in one ~100ms tick
  // window; each uses an out-of-bounds tile so every drained one rejects,
  // making the queue depth observable via the rejection count.
  for (let i = 0; i < 200; i += 1) {
    session.queueExpand("human", { targetX: 1000, targetY: 1000, percent: 50 });
  }
  session.tick();
  const rejections = messages.filter((m) => m.type === "SERVER_RASTER_ACTION_REJECTED");
  assert.ok(rejections.length < 200, "the flood must not all be queued and drained in one tick");
  assert.ok(rejections.length > 0, "some intents still get through up to the cap");
});

test("ticks broadcast a snapshot every tick", () => {
  const session = new RasterGameSession({ width: 16, height: 12, seed: 2 });
  const messages = collect(session, "human");
  const before = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  session.tick();
  session.tick();
  session.tick();
  const after = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  assert.equal(after - before, 3);
});

test("snapshots carry a ships array (empty when none are at sea)", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3 });
  const messages = collect(session, "human");
  const snap = lastSnapshot(messages);
  assert.ok(Array.isArray(snap.ships), "every snapshot must carry a ships array");
  assert.equal(snap.ships.length, 0, "no ships are at sea before any are launched");
});

test("clicking a sea-only target dispatches a transport ship that lands", () => {
  const session = new RasterGameSession({ realMapId: "world", startingTroops: 200 });
  const messages = collect(session, "human");
  const target = stageSeaTarget(session);

  session.queueExpand("human", { targetX: target.x, targetY: target.y, percent: 100 });
  session.tick();

  const afterLaunch = lastSnapshot(messages);
  const myShips = afterLaunch.ships.filter((s) => s.playerId === 1);
  assert.equal(myShips.length, 1, "one click dispatches exactly one ship");
  // OpenFront's boats carry at most a fifth of the pool: even this 100% click
  // loads only floor(200 / 5) = 40 troops; the rest stays home to defend.
  assert.equal(myShips[0].troops, 40, "a boat is capped at floor(pool/5) troops");
  assert.ok(afterLaunch.recentEvents.some((e) => e.includes("transport ship")), "the launch is logged");

  // Let the ship sail and disembark; it should capture its target tile.
  for (let i = 0; i < 30; i += 1) session.tick();
  const grid = session.peekGrid();
  const ref = session.peekMap().ref(target.x, target.y);
  assert.equal(grid.ownerOf(ref), 1, "the ship captured its beachhead");
  assert.equal(lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 0, "the ship is gone once it has landed");
});

test("OpenFront routing: an unbordered rival can't be land-attacked, but neutral land still marches", () => {
  // A landlocked strip — p1 | neutral | neutral | neutral | rival — with no water
  // at all, so a boat is impossible and the only routes are by land. OpenFront
  // gates a march onto a *player's* tile purely by a shared border, so clicking
  // the rival we don't touch is rejected; a neutral tile we border still marches.
  const map = mapFromRows(["#####"]);
  const session = new RasterGameSession({ prebuiltMap: map, startingTroops: 200, spawnPhaseTicks: 0 });
  const messages = collect(session, "human"); // seats player 1 somewhere
  const grid = session.peekGrid();

  for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) !== NEUTRAL_PLAYER) grid.claim(ref, NEUTRAL_PLAYER);
  if (!grid.hasPlayer(2)) grid.addPlayer(2, 50);
  grid.claim(map.ref(0, 0), 1); // our foothold
  grid.claim(map.ref(4, 0), 2); // rival, three neutral tiles away
  assert.equal(grid.hasLandBorderWith(1, 2), false, "player 1 does not border the rival");

  // Click the unbordered rival: no shared border, no water → OpenFront rejects it.
  session.queueExpand("human", { targetX: 4, targetY: 0, percent: 50 });
  session.tick();
  assert.ok(
    messages.some((m) => m.type === "SERVER_RASTER_ACTION_REJECTED"),
    "an unbordered rival can't be land-attacked (OpenFront needs a shared border)",
  );

  // Click a neutral tile we do border: a normal land march grows our territory.
  const before = grid.tileCountOf(1);
  session.queueExpand("human", { targetX: 1, targetY: 0, percent: 50 });
  session.tick();
  assert.ok(grid.tileCountOf(1) > before, "neutral land within reach is still marched into");
});

test("a far coast across water on the SAME continent dispatches a boat, not a silent land creep", () => {
  // Regression for the reported bug: a coastal enclave on a giant landmass clicks
  // a far coast of that *same* landmass that sits across open water. The old
  // "same landmass ⇒ march" rule launched nothing visible (a creep the long way
  // round); the OpenFront-style bounded land-reach rule must instead send a boat.
  const earth = resolveHeightmapSessionMap("earth", 1024)!;
  const session = new RasterGameSession({ prebuiltMap: earth.map, mapName: earth.name, startingTroops: 5000 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), /*autoSpawn*/ false);
  const map = session.peekMap();
  const grid = session.peekGrid();

  const seat = map.ref(673, 149); // a coast on Earth's largest landmass
  const clickX = 598;
  const clickY = 139; // a far coast of the SAME landmass, across the water
  const clickRef = map.ref(clickX, clickY);
  assert.ok(grid.isCapturable(seat), "seat is land");
  assert.ok(grid.isCapturable(clickRef), "click target is land");

  session.selectSpawn("human", map.x(seat), map.y(seat));
  // Grow a contiguous coastal enclave (~300 tiles) around the seat.
  const seen = new Set<number>([seat]);
  const queue = [seat];
  let claimed = 0;
  for (let h = 0; h < queue.length && claimed < 300; h += 1) {
    const t = queue[h];
    if (!grid.isCapturable(t)) continue;
    grid.claim(t, 1);
    claimed += 1;
    for (const n of map.neighbors(t)) if (!seen.has(n) && grid.isCapturable(n)) { seen.add(n); queue.push(n); }
  }

  // Preconditions that make this exactly the reported state (guard against map drift).
  assert.equal(grid.landComponentId(seat), grid.landComponentId(clickRef), "seat and target share one landmass");
  assert.equal(grid.ownsLandComponentOf(1, clickRef), true, "the player holds ground on that landmass");
  assert.equal(grid.canReachByLand(1, clickRef), false, "the far coast is out of land-march reach");
  assert.notEqual(grid.resolveSeaLanding(1, clickRef), null, "but a transport can reach it across the water");

  session.queueExpand("human", { targetX: clickX, targetY: clickY, percent: 50 });
  session.tick();

  const rejection = messages.find((m) => m.type === "SERVER_RASTER_ACTION_REJECTED");
  assert.equal(rejection, undefined, "the across-water click is not rejected");
  const snap = lastSnapshot(messages);
  assert.equal(snap.ships.filter((s) => s.playerId === 1).length, 1, "exactly one transport ship is dispatched");
});

test("a fourth simultaneous ship is rejected with TOO_MANY_SHIPS", () => {
  const session = new RasterGameSession({ realMapId: "world", startingTroops: 200 });
  const messages = collect(session, "human");
  const target = stageSeaTarget(session);

  // Four clicks on the same tick: only three ships may put to sea.
  for (let i = 0; i < 4; i += 1) {
    session.queueExpand("human", { targetX: target.x, targetY: target.y, percent: 10 });
  }
  session.tick();

  const rejections = messages.filter(
    (m): m is Extract<RasterServerMessage, { type: "SERVER_RASTER_ACTION_REJECTED" }> =>
      m.type === "SERVER_RASTER_ACTION_REJECTED",
  );
  assert.equal(rejections.length, 1, "exactly the fourth click is rejected");
  assert.equal(rejections[0].payload.reason, "TOO_MANY_SHIPS");
  assert.equal(session.peekGrid() && lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 3);
});

// --- Forced route (B/G hotkeys): mode "land" / "sea" overrides -------------

test('mode "sea" launches a transport ship at a bordering rival instead of a land push', () => {
  // P and E share a land border (row 0) but both also touch one connected
  // water body beneath them (row 1), so a sea route exists too — the only
  // way to prove "sea" is *forced* rather than merely picked by default.
  const map = mapFromRows(["##", ".."]);
  const session = new RasterGameSession({ prebuiltMap: map, startingTroops: 200, spawnPhaseTicks: 0 });
  const messages = collect(session, "human");
  const grid = session.peekGrid();
  for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) !== NEUTRAL_PLAYER) grid.claim(ref, NEUTRAL_PLAYER);
  if (!grid.hasPlayer(2)) grid.addPlayer(2, 50);
  grid.claim(map.ref(0, 0), 1);
  grid.claim(map.ref(1, 0), 2);
  assert.equal(grid.hasLandBorderWith(1, 2), true, "the two players share a land border");
  assert.notEqual(grid.findSeaPath(1, map.ref(1, 0)), null, "a sea route also exists");

  session.queueExpand("human", { targetX: 1, targetY: 0, percent: 50, mode: "sea" });
  session.tick();

  assert.equal(messages.some((m) => m.type === "SERVER_RASTER_ACTION_REJECTED"), false, "the forced sea order is accepted");
  assert.equal(lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 1, "a transport ship was dispatched, not a land push");
});

test('mode "land" rejects a target only reachable by sea, even though a route exists', () => {
  const session = new RasterGameSession({ realMapId: "world", startingTroops: 200 });
  const messages = collect(session, "human");
  const target = stageSeaTarget(session);

  session.queueExpand("human", { targetX: target.x, targetY: target.y, percent: 10, mode: "land" });
  session.tick();

  const rejection = messages.find((m) => m.type === "SERVER_RASTER_ACTION_REJECTED");
  assert.ok(rejection, "a sea-only target is rejected when land is forced");
  if (rejection?.type === "SERVER_RASTER_ACTION_REJECTED") assert.equal(rejection.payload.reason, "NO_FRONTIER");
  assert.equal(lastSnapshot(messages).ships.filter((s) => s.playerId === 1).length, 0, "no ship was dispatched");
});

// --- Retaliate (Shift+R): lastAttackedBy tracking ---------------------------

test("a land attack records the attacker as the victim's lastAttackedBy, publicly visible to all", () => {
  const map = mapFromRows(["##"]);
  const session = new RasterGameSession({ prebuiltMap: map, startingTroops: 200, spawnPhaseTicks: 0 });
  const messages = collect(session, "human");
  const grid = session.peekGrid();
  for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) !== NEUTRAL_PLAYER) grid.claim(ref, NEUTRAL_PLAYER);
  if (!grid.hasPlayer(2)) grid.addPlayer(2, 50);
  grid.claim(map.ref(0, 0), 1);
  grid.claim(map.ref(1, 0), 2);

  // The first snapshot (sent synchronously on subscribe) predates these manual
  // grid mutations; tick once so a fresh snapshot reflects both players before
  // asserting the "nobody has attacked yet" baseline.
  session.tick();
  assert.equal(lastSnapshot(messages).players.find((p) => p.playerId === 2)?.lastAttackedBy, 0, "nobody has attacked player 2 yet");
  session.queueExpand("human", { targetX: 1, targetY: 0, percent: 50 });
  session.tick();
  assert.equal(lastSnapshot(messages).players.find((p) => p.playerId === 2)?.lastAttackedBy, 1, "player 2's snapshot row now names player 1 as the last attacker");
  // The attacker's own row is untouched.
  assert.equal(lastSnapshot(messages).players.find((p) => p.playerId === 1)?.lastAttackedBy, 0);
});

test("sessions with identical seed produce identical terrain bytes", () => {
  const a = new RasterGameSession({ width: 24, height: 16, seed: 11 });
  const b = new RasterGameSession({ width: 24, height: 16, seed: 11 });
  const aMap = a.peekMap();
  const bMap = b.peekMap();
  assert.equal(aMap.width, bMap.width);
  for (let i = 0; i < aMap.terrain.length; i += 1) {
    if (aMap.terrain[i] !== bMap.terrain[i]) {
      throw new Error(`terrain differs at byte ${i}: ${aMap.terrain[i]} vs ${bMap.terrain[i]}`);
    }
  }
});

const firstSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (const m of messages) if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  throw new Error("no snapshot seen");
};

test("headless subscribers get no ownership raster (the bot bandwidth saving)", () => {
  const session = new RasterGameSession({ width: 24, height: 16, seed: 3 });
  const human: RasterServerMessage[] = [];
  const bot: RasterServerMessage[] = [];
  session.subscribe("human", (m) => human.push(m), true, true);
  session.subscribe("bot", (m) => bot.push(m), true, false);

  const humanSnap = firstSnapshot(human);
  const botSnap = firstSnapshot(bot);

  // The real client is seeded with the full terrain + owner raster...
  assert.ok(humanSnap.terrainBase64 !== undefined, "human gets terrain bytes");
  assert.ok(humanSnap.ownerBase64 !== undefined, "human gets the full owner raster");

  // ...while the headless bot, which reads engine state directly, gets neither
  // the terrain bytes nor any ownership encoding (the per-tick cost we cut).
  assert.equal(botSnap.terrainBase64, undefined, "bot gets no terrain bytes");
  assert.equal(botSnap.ownerBase64, undefined, "bot gets no full owner raster");
  assert.equal(botSnap.ownerDeltaBase64, undefined, "bot gets no owner delta");
  // It still receives the player standings it needs to make decisions.
  assert.ok(botSnap.players.length >= 1, "bot still sees player standings");
});

test("the snapshot reports an active attack front with the troops fighting on it", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 9 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m), true, true); // auto-spawn on land
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.setTroops(1, 60);

  // Push into a neutral capturable neighbour of our founding tile.
  let target = -1;
  for (const ref of grid.tilesOf(1)) {
    for (const n of map.neighbors(ref)) {
      if (grid.isCapturable(n) && grid.ownerOf(n) === 0) { target = n; break; }
    }
    if (target >= 0) break;
  }
  assert.ok(target >= 0, "the spawn should border neutral land");
  session.queueExpand("human", { targetX: map.x(target), targetY: map.y(target), percent: 80 });
  session.tick();

  const snap = lastSnapshot(messages);
  const front = snap.fronts.find((f) => f.playerId === 1);
  assert.ok(front, "the player's own front is reported");
  assert.equal(front!.targetId, 0, "it pushes into neutral land");
  assert.ok(front!.troops > 0, "the troops fighting on the front are reported");
  assert.ok(front!.x >= 0 && front!.x < snap.width, "the front anchor is a real tile");
});
