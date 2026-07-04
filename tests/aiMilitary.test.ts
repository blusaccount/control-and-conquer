import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController, type RasterBotPersonality } from "../src/Server/RasterBotController.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

// A hair-trigger personality so tests don't wait out real decision cadences.
const FAST: RasterBotPersonality = {
  id: "test",
  decisionCooldownTicks: 1,
  minPool: 0,
  reserveFraction: 0.3,
  expandCommit: 0.25,
  attackCommit: 0.3,
  attackPoolRatio: 1.25,
  aggression: 0.5,
};

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

test("a nation garrisons a contested border with forts, up to the cap", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("rival", noop, true, false, undefined, "nation"); // player 2
  claimRect(session, me, 0, 49, 0, 23);
  claimRect(session, 2, 50, 79, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(5, 3), "city"); // economy gate: one city stands
  grid.setGold(me, 300_000); // covers fort #1 (50k) + #2 (100k), not a 3rd city

  for (let i = 0; i < 12; i += 1) session.tick();

  assert.equal(grid.buildingCountOf(me, "fort"), 2, "two forts rise on the hostile border, then the cap holds");
  // Both stand near the contested border (within range of the rival's line at x=50).
  for (const [ref, type] of grid.buildingEntries()) {
    if (type !== "fort" || grid.ownerOf(ref) !== me) continue;
    assert.ok(map.x(ref) >= 35, `fort at x=${map.x(ref)} sits near the x=50 border`);
  }
});

test("a coastal nation floats a warship patrol once its economy matures", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24, 1), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  // A vastly stronger rival holds the other half, so the bot can't hit the
  // 80% domination win before its port (50 build ticks) even finishes.
  session.subscribe("rival", noop, true, false, undefined, "nation"); // player 2
  claimRect(session, me, 0, 49, 0, 22); // includes the shore row at y=22
  claimRect(session, 2, 50, 79, 0, 22);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.addTroops(2, 1_000_000);
  grid.placeBuilding(map.ref(5, 3), "city");
  grid.placeBuilding(map.ref(25, 3), "city");
  // Covers the ladder up to the warship — 125k port + two border forts
  // (50k+100k, the hostile rival triggers those) + 250k factory + the 250k
  // warship = 775k — but never the 1M silo.
  grid.setGold(me, 900_000);

  // The port takes 50 ticks to finish, and a warship (a mobile unit now) can
  // only launch from an ACTIVE port — run well past both.
  for (let i = 0; i < 150; i += 1) session.tick();

  assert.equal(session.peekWarshipCount(me), 1, "one warship patrols the coast (cap for a balanced nation)");
  assert.equal(grid.buildingCountOf(me, "warship"), 0, "a warship is a unit, never a structure on the grid");
});

test("the war chest keeps city spending from raiding the silo budget", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  claimRect(session, me, 0, 49, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(5, 3), "city");
  grid.placeBuilding(map.ref(25, 3), "city");
  // 990k affords the next city (500k) but NOT the silo (1M): the nation must
  // sit on its gold rather than spend the war chest on another city. The one
  // exception is the economy ladder — the 125k factory is an income
  // *multiplier* and is bought even while saving (this landlocked map has no
  // shore, so no ports/warships muddy the count).
  grid.setGold(me, 990_000);

  for (let i = 0; i < 8; i += 1) session.tick();
  assert.equal(grid.buildingCountOf(me, "factory"), 1, "the factory (economy multiplier) is exempt from the war chest");
  assert.equal(grid.buildingCount, 3, "beyond the factory, nothing is built while saving for the silo");

  // Once the chest covers the silo, it goes up at once.
  grid.setGold(me, 1_200_000);
  for (let i = 0; i < 8; i += 1) session.tick();
  assert.equal(grid.buildingCountOf(me, "silo"), 1, "the silo rises the moment it is affordable");
});

test("a nation with a ready silo nukes the bordering threat, aiming deep in its land", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("rival", noop, true, false, undefined, "nation"); // player 2
  const watch: RasterServerMessage[] = [];
  session.subscribe("watch", (m) => watch.push(m)); // snapshot observer
  claimRect(session, me, 0, 49, 0, 23);
  claimRect(session, 2, 50, 79, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(5, 3), "city");
  grid.placeBuilding(map.ref(25, 3), "city");
  grid.placeBuilding(map.ref(45, 12), "silo"); // instantly active (no build window)
  grid.setGold(me, 2_000_000);
  grid.addTroops(2, 100_000); // the rival's pool dwarfs ours -> a threat worth deterring

  for (let i = 0; i < 6; i += 1) session.tick();

  const snap = lastSnapshot(watch);
  assert.ok(
    snap.recentEvents.some((e) => e.includes("launched an Atom Bomb")),
    `the launch is announced, events: ${snap.recentEvents.join(" | ")}`,
  );
  const flight = snap.nukes.find((n) => n.playerId === me);
  assert.ok(flight, "the warhead is in flight");
  assert.ok(flight!.toX >= 65, `aimed deep in the rival's land (toX=${flight!.toX}, border at x=50)`);
  assert.ok(grid.goldOf(me) < 1_400_000, "the warhead's 750k came out of the treasury");
});

test("retaliation outranks deterrence: the last attacker eats the warhead", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("attacker", noop, true, false, undefined, "nation"); // player 2, west
  session.subscribe("giant", noop, true, false, undefined, "nation"); // player 3, east
  const watch: RasterServerMessage[] = [];
  session.subscribe("watch", (m) => watch.push(m));
  claimRect(session, me, 25, 55, 0, 23);
  claimRect(session, 2, 0, 24, 0, 23);
  claimRect(session, 3, 56, 79, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(30, 3), "city");
  grid.placeBuilding(map.ref(50, 3), "city");
  grid.placeBuilding(map.ref(40, 14), "silo");
  grid.addTroops(3, 200_000); // the giant is the bigger *threat*...

  // ...but the weak western rival strikes first (no gold yet, so the bot can't
  // pre-empt on the threat path before the attack lands).
  session.queueExpand("attacker", { targetX: 26, targetY: 3, percent: 10 });
  session.tick();
  grid.setGold(me, 2_000_000);
  for (let i = 0; i < 6; i += 1) session.tick();

  const flight = lastSnapshot(watch).nukes.find((n) => n.playerId === me);
  assert.ok(flight, "a retaliation warhead is in flight");
  assert.ok(flight!.toX <= 24, `it flies west at the attacker (toX=${flight!.toX}), not at the eastern giant`);
});

test("SAM cover goes up once warheads have flown in the match", () => {
  const session = new RasterGameSession({ prebuiltMap: landMap(80, 24), mapName: "t" });
  const bot = new RasterBotController({ botId: "b1", personality: FAST, kind: "nation" });
  bot.attach(session);
  const me = bot.getPlayerId()!;
  session.subscribe("rival", noop, true, false, undefined, "nation"); // player 2
  claimRect(session, me, 0, 49, 0, 23);
  claimRect(session, 2, 50, 79, 0, 23);
  const grid = session.peekGrid();
  const map = session.peekMap();
  grid.placeBuilding(map.ref(5, 3), "city");
  grid.placeBuilding(map.ref(25, 3), "city");
  // The RIVAL has the nuclear programme; our nation must react with SAM cover.
  grid.placeBuilding(map.ref(70, 12), "silo");
  grid.setGold(2, 1_000_000);
  grid.setGold(me, 5_000_000);

  session.queueNuke("rival", { targetX: 10, targetY: 10, kind: "atom" });
  // Assert while the warhead is still in flight (~15 ticks for this distance):
  // its impact would raze whatever our nation just built near the aim point —
  // which is itself the correct, brutal behaviour.
  for (let i = 0; i < 10; i += 1) session.tick();

  assert.equal(grid.buildingCountOf(me, "sam"), 1, "a SAM battery stands once bombs are flying");
});
