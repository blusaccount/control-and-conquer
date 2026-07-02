import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import {
  RasterBotController,
  RASTER_BOT_PERSONALITIES,
  DEFAULT_RASTER_BOT_CONFIG,
  FILLER_PERSONALITY,
  type RasterBotPersonality,
} from "../src/Server/RasterBotController.js";
import type { RasterServerMessage } from "../src/Core/types.js";

/** A snappy, eager personality for tests: decides every tick, almost no reserve. */
const EAGER: RasterBotPersonality = {
  id: "test-eager",
  decisionCooldownTicks: 0,
  minPool: 1,
  reserveFraction: 0.05,
  expandCommit: 0.9,
  attackCommit: 0.9,
  attackPoolRatio: 1.0,
  aggression: 0.9,
};

test("RasterBotController.attach assigns a playerId via subscription", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 4 });
  const bot = new RasterBotController();
  assert.equal(bot.getPlayerId(), null);
  bot.attach(session);
  assert.ok(bot.getPlayerId() !== null && bot.getPlayerId()! >= 1);
});

test("RasterBot detach clears state", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 4 });
  const bot = new RasterBotController();
  const detach = bot.attach(session);
  assert.notEqual(bot.getPlayerId(), null);
  detach();
  assert.equal(bot.getPlayerId(), null);
});

test("RasterBot does eventually queue an expand intent once income builds", () => {
  // Seat a human first so the bot becomes player 2.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", personality: EAGER });
  bot.attach(session);

  let any = false;
  for (let i = 0; i < 50; i += 1) {
    session.tick();
    if (session.getPendingExpandCount() > 0) { any = true; break; }
  }
  assert.ok(any, "Eager bot should queue at least one expand intent within 50 ticks.");
});

test("RasterBot expands into real land instead of stalling on water/rock", () => {
  // On a land-rich map an eager bot must turn its intents into captures.
  // Reading the authoritative grid (sea links included) means it never locks
  // onto a tile the server would reject and stall on its single spawn.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", personality: EAGER });
  bot.attach(session);

  for (let i = 0; i < 200; i += 1) session.tick();

  const botId = bot.getPlayerId();
  assert.ok(botId !== null);
  const grid = session.peekGrid();
  assert.ok(grid.tileCountOf(botId!) > 1, `bot should capture beyond its spawn, owns ${grid.tileCountOf(botId!)}`);
});

test("RasterBot respects its decision cooldown", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 5 });
  session.subscribe("human", () => {});
  const slow: RasterBotPersonality = { ...EAGER, decisionCooldownTicks: 10000 };
  const bot = new RasterBotController({ botId: "bot", personality: slow });
  bot.attach(session);

  // Across many ticks the bot should never be more than one intent ahead.
  let totalQueued = 0;
  for (let i = 0; i < 200; i += 1) {
    totalQueued += session.getPendingExpandCount();
    session.tick();
  }
  totalQueued += session.getPendingExpandCount();
  assert.ok(totalQueued <= 1, `Cooldown should cap intents; saw ${totalQueued}`);
});

test("RasterBot prefers cheap neutral land over an evenly-matched rival", () => {
  // Two bots, plenty of neutral land between them: a land-grabber should pour
  // its troops into neutral tiles (cost 1) rather than start an expensive war.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 7 });
  const expander: RasterBotPersonality = { ...RASTER_BOT_PERSONALITIES[0], decisionCooldownTicks: 2, minPool: 2 };
  const a = new RasterBotController({ botId: "a", personality: expander });
  const b = new RasterBotController({ botId: "b", personality: expander });
  a.attach(session);
  b.attach(session);

  for (let i = 0; i < 150; i += 1) session.tick();

  const grid = session.peekGrid();
  const ownedByBots = grid.tileCountOf(a.getPlayerId()!) + grid.tileCountOf(b.getPlayerId()!);
  // Both should have grown well past their spawns by claiming neutral land.
  assert.ok(grid.tileCountOf(a.getPlayerId()!) > 3, "bot A should have expanded");
  assert.ok(grid.tileCountOf(b.getPlayerId()!) > 3, "bot B should have expanded");
  assert.ok(ownedByBots > grid.capturableCount * 0.2, "bots should carve up a real share of the map");
});

test("A field of varied bots drives toward a decisive outcome", () => {
  // Four personalities on a connected continent should not deadlock: territory
  // keeps consolidating, so the leader controls a meaningful share over time.
  // The seed is chosen to be genuinely continental — since transport ships are
  // rationed (max 3 per player), evenly-matched bots separated by open water can
  // legitimately stand off, so a decisive outcome is only guaranteed where the
  // landmass lets fronts meet on land.
  const session = new RasterGameSession({ width: 40, height: 28, seed: 20 });
  const bots = [0, 1, 2, 3].map((i) =>
    new RasterBotController({
      botId: `bot-${i}`,
      personality: { ...RASTER_BOT_PERSONALITIES[i], decisionCooldownTicks: 2, minPool: 2 },
    }),
  );
  for (const bot of bots) bot.attach(session);

  for (let i = 0; i < 600; i += 1) session.tick();

  const grid = session.peekGrid();
  const counts = bots.map((bot) => grid.tileCountOf(bot.getPlayerId()!));
  const leader = Math.max(...counts);
  assert.ok(leader > grid.capturableCount * 0.3, `leader should dominate; held ${leader}/${grid.capturableCount}`);
});

test("DEFAULT_RASTER_BOT_CONFIG ships a sane all-rounder personality", () => {
  assert.equal(DEFAULT_RASTER_BOT_CONFIG.personality.id, "balanced");
  assert.ok(DEFAULT_RASTER_BOT_CONFIG.personality.decisionCooldownTicks > 0);
});

// --- Bot (Tribe) filler vs. Nation: behaviour differences -------------------

test("a Bot filler never builds, even once it holds land and gold", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", personality: EAGER, kind: "bot" });
  bot.attach(session);
  const botId = bot.getPlayerId()!;
  const grid = session.peekGrid();

  for (let i = 0; i < 400; i += 1) {
    // Keep the filler flush with gold throughout — if it were going to build
    // (like a Nation with EAGER's fast cadence does well within 400 ticks),
    // affordability was never the blocker.
    grid.setGold(botId, 10_000_000);
    session.tick();
  }

  assert.equal(grid.buildingCountOf(botId, "city"), 0, "a Bot filler places no cities");
  assert.equal(grid.buildingCountOf(botId, "port"), 0, "a Bot filler places no ports");
});

test("a Bot filler unconditionally accepts an incoming alliance offer", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 6 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  const bot = new RasterBotController({ botId: "bot", personality: FILLER_PERSONALITY, kind: "bot" });
  bot.attach(session);
  const botId = bot.getPlayerId()!;

  // The human proposes to the Bot; a full-strategy Nation with a low-aggression
  // personality might also accept, but a Bot accepts unconditionally, with no
  // troop-strength comparison at all — assert it lands even though the human
  // (the "from" side here) is far weaker than the Bot's decisive-edge threshold.
  session.proposeAlliance("human", botId);
  let allied = false;
  for (let i = 0; i < 100 && !allied; i += 1) {
    session.tick();
    allied = session.peekAlliances().areAllied(1, botId);
  }
  assert.ok(allied, "the Bot filler accepted the human's alliance offer");
});
