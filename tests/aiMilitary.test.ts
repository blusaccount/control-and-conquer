import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController } from "../src/Server/RasterBotController.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

// ---------------------------------------------------------------------------
// The nation military programme, OpenFront-style: reactive defense posts,
// ratio-driven structures with perceived-cost saving, the 1/50 warship roll,
// and nuke targeting (retaliation first, never at tribes).
//
// The AI has no test knobs: each seat rolls its cadence (Impossible 30–49,
// Hard 45–59 ticks…) and its odds from a PRNG seeded by botId+seed, so these
// tests run real decision cycles and, where an odds roll gates a behaviour,
// give several seats enough cycles that the outcome is deterministic for the
// chosen seeds (fixed PRNG streams — none of this is flaky).
// ---------------------------------------------------------------------------

/** Flat-land map, optionally with `waterRows` rows of sea along the bottom (shore above). */
const landMap = (width: number, height: number, waterRows = 0) => {
  const land = new Uint8Array(width * height);
  const elevation = new Uint8Array(width * height);
  for (let y = 0; y < height - waterRows; y += 1) {
    for (let x = 0; x < width; x += 1) land[y * width + x] = 1;
  }
  return buildTerrainFromMask({ width, height, land, elevation });
};

const noop = (): void => {};

/** Claim every capturable tile in the rectangle for `id`. */
const claimRect = (
  session: RasterGameSession,
  id: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void => {
  const grid = session.peekGrid();
  const map = session.peekMap();
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const ref = map.ref(x, y);
      if (grid.isCapturable(ref)) grid.claim(ref, id);
    }
  }
};

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

test("a hard nation raises defense posts against a heavy incoming attack", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "fort-test", kind: "nation", difficulty: "hard", seed: 1 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("rival", noop, true, false, undefined, "nation"); // player 2
  claimRect(session, me, 0, 49, 0, 23);
  claimRect(session, 2, 50, 79, 0, 23);
  const grid = session.peekGrid();
  grid.setGold(me, 200_000);

  // Let the nation place its first structure (a city) — the defense-post
  // branch only arms after the first ordinary placement, as in OpenFront.
  for (let i = 0; i < 200 && grid.buildingCountOf(me, "city") === 0; i += 1) session.tick();
  assert.ok(grid.buildingCountOf(me, "city") >= 1, "the first city stands");

  // Now the rival commits an army worth well over 35% of our pool.
  grid.setTroops(2, 500_000);
  grid.setTroops(me, 20_000);
  grid.setGold(me, 300_000);
  session.queueExpand("rival", { targetX: 49, targetY: 12, percent: 50 });
  for (let i = 0; i < 300 && grid.buildingCountOf(me, "fort") === 0; i += 1) session.tick();

  assert.ok(grid.buildingCountOf(me, "fort") >= 1, "a defense post rises against the incoming attack");
});

test("an easy nation never builds defense posts, even under heavy attack", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "fort-easy", kind: "nation", difficulty: "easy", seed: 1 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("rival", noop, true, false, undefined, "nation");
  claimRect(session, me, 0, 49, 0, 23);
  claimRect(session, 2, 50, 79, 0, 23);
  const grid = session.peekGrid();
  grid.setGold(me, 200_000);
  for (let i = 0; i < 300 && grid.buildingCountOf(me, "city") === 0; i += 1) session.tick();

  grid.setTroops(2, 500_000);
  grid.setTroops(me, 20_000);
  grid.setGold(me, 300_000);
  session.queueExpand("rival", { targetX: 49, targetY: 12, percent: 50 });
  for (let i = 0; i < 400; i += 1) session.tick();

  assert.equal(session.peekGrid().buildingCountOf(me, "fort"), 0, "easy nations don't defend reactively");
});

test("perceived costs make a nation save instead of carpeting cities", () => {
  // Territory must stay under OpenFront's 1-structure-per-1500-tiles density,
  // or the nation (correctly) upgrades city #1 instead of founding city #2.
  const session = new RasterGameSession({ prebuiltMap: landMap(200, 40), mapName: "t" });
  const bot = new RasterBotController({ botId: "save-test", kind: "nation", difficulty: "medium", seed: 2 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  // A second landholder keeps the bot under the 80% win threshold (a victory
  // would freeze the simulation mid-test).
  session.subscribe("bystander", noop, true, false, undefined, "nation");
  claimRect(session, me, 0, 119, 0, 39);
  claimRect(session, 2, 120, 199, 0, 39);
  const grid = session.peekGrid();

  // First city: 125k real, no inflation (nothing owned yet).
  grid.setGold(me, 130_000);
  for (let i = 0; i < 300 && grid.buildingCountOf(me, "city") === 0; i += 1) session.tick();
  assert.equal(grid.buildingCountOf(me, "city"), 1, "the first city goes up at its real price");

  // Second city: 250k real, but *felt* as 500k while the treasury is far from
  // the warhead stockpile target — 300k gold is NOT enough to trigger it.
  grid.setGold(me, 300_000);
  for (let i = 0; i < 300; i += 1) session.tick();
  assert.equal(grid.buildingCountOf(me, "city"), 1, "300k gold doesn't clear the perceived 500k price");

  // 600k clears the perceived price and the second city rises.
  grid.setGold(me, 600_000);
  for (let i = 0; i < 300 && grid.buildingCountOf(me, "city") < 2; i += 1) session.tick();
  assert.equal(grid.buildingCountOf(me, "city"), 2, "600k gold clears the perceived 500k price");
});

test("a nation with a ready silo answers the attacker with a warhead", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "nuke-test", kind: "nation", difficulty: "hard", seed: 3 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("attacker", noop, true, false, undefined, "nation"); // player 2, west
  const watch: RasterServerMessage[] = [];
  session.subscribe("watch", (m) => watch.push(m), false); // observer only, never seated on the map
  // Evenly sized nations: an attacker half our ceiling would (correctly) be
  // left to the conventional army — OpenFront only nukes real rivals.
  claimRect(session, me, 40, 79, 0, 23);
  claimRect(session, 2, 0, 39, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(70, 12), "silo"); // active at once, far behind the front line
  // The defender can hold the front — the point is the warhead, not the rout.
  grid.setTroops(me, 150_000);
  grid.setTroops(2, 200_000);
  // 6M covers a hydrogen bomb too, so even a "hydro nation" seat retaliates.
  grid.setGold(me, 6_000_000);
  session.queueExpand("attacker", { targetX: 41, targetY: 3, percent: 40 });

  let flight: { toX: number } | undefined;
  for (let i = 0; i < 400 && !flight; i += 1) {
    session.tick();
    flight = lastSnapshot(watch).nukes.find((n) => n.playerId === me);
  }
  assert.ok(flight, "a retaliation warhead is in flight");
  assert.ok(flight!.toX <= 39, `it flies west at the attacker (toX=${flight!.toX})`);
});

test("a nation never wastes a warhead on a tribe", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "nuke-test", kind: "nation", difficulty: "hard", seed: 3 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("tribe", noop, true, false, undefined, "bot"); // player 2 is a Tribe
  const watch: RasterServerMessage[] = [];
  session.subscribe("watch", (m) => watch.push(m), false); // observer only
  claimRect(session, me, 25, 79, 0, 23);
  claimRect(session, 2, 0, 24, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(40, 12), "silo");
  grid.setTroops(me, 150_000);
  grid.setTroops(2, 200_000);
  session.queueExpand("tribe", { targetX: 26, targetY: 3, percent: 40 });
  session.tick();
  grid.setGold(me, 6_000_000);

  for (let i = 0; i < 400; i += 1) session.tick();
  const snap = lastSnapshot(watch);
  assert.equal(snap.nukes.filter((n) => n.playerId === me).length, 0, "no warhead flies at a map-filler");
});

test("the structure programme follows the per-city ratios (2 cities before the first port)", () => {
  // Room for 3 structures under the 1-per-1500-tiles density rule (else the
  // nation would upgrade rather than expand its footprint — see above).
  const session = new RasterGameSession({ prebuiltMap: landMap(200, 48, 2), mapName: "t" });
  const bot = new RasterBotController({ botId: "ratio-test", kind: "nation", difficulty: "medium", seed: 4 });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  // A second landholder keeps the bot under the 80% win threshold.
  session.subscribe("bystander", noop, true, false, undefined, "nation");
  claimRect(session, me, 0, 119, 0, 45); // includes the shore row at y=45
  claimRect(session, 2, 120, 199, 0, 45);
  const grid = session.peekGrid();

  // Enough for city #1 (125k) + perceived city #2 (500k) + port (125k).
  grid.setGold(me, 800_000);
  for (let i = 0; i < 1200 && grid.buildingCountOf(me, "port") === 0; i += 1) session.tick();

  assert.ok(grid.buildingCountOf(me, "city") >= 2, "two cities stand");
  assert.equal(grid.buildingCountOf(me, "port"), 1, "the first port follows the 0.75-per-city ratio");
  // floor(cities × 0.75) with 2 cities is 1 — a second port must wait for city #3.
  assert.ok(grid.buildingCountOf(me, "port") <= Math.floor(grid.buildingCountOf(me, "city") * 0.75));
});

test("a coastal nation floats at most one patrol warship (the 1-in-50 roll)", () => {
  // Several seats share one sim so the 1/50-per-decision roll fires for at
  // least one of them inside the window — each stream is fixed, so this is
  // deterministic, and the one-warship cap must hold for every seat.
  const session = new RasterGameSession({ prebuiltMap: landMap(120, 24, 2), mapName: "t" });
  const bots = Array.from({ length: 4 }, (_, i) => {
    const b = new RasterBotController({ botId: `ship-${i}`, kind: "nation", difficulty: "impossible", seed: i });
    b.attach(session);
    return b;
  });
  const grid = session.peekGrid();
  const map = session.peekMap();
  // Four side-by-side coastal strips, one per nation, all pre-seeded with an
  // active port + gold so only the odds roll gates the warship.
  bots.forEach((b, i) => {
    const me = b.getPlayerId()!;
    claimRect(session, me, i * 30, i * 30 + 29, 0, 21);
    grid.placeBuilding(map.ref(i * 30 + 5, 21), "port");
    grid.setGold(me, 400_000);
  });

  let anyShip = 0;
  for (let i = 0; i < 4000; i += 1) {
    session.tick();
    anyShip = Math.max(anyShip, ...bots.map((b) => session.peekWarshipCount(b.getPlayerId()!)));
    // Keep everyone solvent so the roll stays the only gate.
    for (const b of bots) if (grid.goldOf(b.getPlayerId()!) < 300_000) grid.setGold(b.getPlayerId()!, 400_000);
    if (anyShip > 0 && i > 600) break;
  }
  assert.ok(anyShip >= 1, "some seat's 1/50 roll fired within the window");
  for (const b of bots) {
    assert.ok(session.peekWarshipCount(b.getPlayerId()!) <= 1, "no nation floats more than one patrol warship");
  }
});

test("the anti-human throttle: an easy nation holds back where hard does not", () => {
  // OpenFront's shouldAttack: Easy follows through on 1-in-4 attack decisions
  // against a human, Hard on all of them. Same board, same seed — the only
  // variable is the difficulty, so the attack-order counts must sit far apart.
  const countAttacks = (difficulty: "easy" | "hard"): number => {
    const W = 60;
    const H = 20;
    const flat = buildTerrainFromMask({
      width: W, height: H,
      land: new Uint8Array(W * H).fill(1),
      elevation: new Uint8Array(W * H),
    });
    const session = new RasterGameSession({ prebuiltMap: flat, spawnPhaseTicks: 0 });
    session.subscribe("human", noop); // player 1
    const bot = new RasterBotController({ botId: "throttle", kind: "nation", difficulty, seed: 5 });
    bot.attach(session); // player 2
    const p2 = bot.getPlayerId()!;
    const grid = session.peekGrid();
    session.tick();
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) grid.claim(y * W + x, x < 30 ? 1 : p2);
    }

    let attacks = 0;
    const orig = session.queueExpand.bind(session);
    (session as unknown as { queueExpand: typeof session.queueExpand }).queueExpand = (cid, intent) => {
      if (cid === "throttle") attacks += 1;
      return orig(cid, intent);
    };
    for (let i = 0; i < 4000; i += 1) {
      // Hold the board stationary: the human stays weak but never dies, the
      // nation always has the pool for a strike.
      grid.setTroops(1, 5_000);
      grid.setTroops(p2, 200_000);
      if (i % 25 === 0) {
        for (let y = 0; y < H; y += 1) for (let x = 0; x < 30; x += 1) grid.claim(y * W + x, 1);
      }
      session.tick();
    }
    return attacks;
  };

  const easy = countAttacks("easy");
  const hard = countAttacks("hard");
  assert.ok(easy >= 1, `even easy nations attack humans sometimes (saw ${easy})`);
  assert.ok(easy * 2 < hard, `easy holds back vs hard (easy ${easy}, hard ${hard})`);
});
