import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController, DEFAULT_RASTER_BOT_CONFIG } from "../src/Server/RasterBotController.js";

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
  const bot = new RasterBotController({ ...DEFAULT_RASTER_BOT_CONFIG, expandCooldownTicks: 0, minPool: 1, percent: 50 });
  bot.attach(session);

  let any = false;
  for (let i = 0; i < 50; i += 1) {
    session.tick();
    if (session.getPendingExpandCount() > 0) { any = true; break; }
  }
  assert.ok(any, "Aggressive bot should queue at least one expand intent within 50 ticks.");
});

test("RasterBot respects cooldown", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({
    ...DEFAULT_RASTER_BOT_CONFIG,
    expandCooldownTicks: 10000,
    minPool: 1,
    percent: 50,
  });
  bot.attach(session);

  // After many ticks the bot should still be at most one intent ahead.
  let totalQueued = 0;
  for (let i = 0; i < 200; i += 1) {
    totalQueued += session.getPendingExpandCount();
    session.tick();
  }
  totalQueued += session.getPendingExpandCount();
  assert.ok(totalQueued <= 1, `Cooldown should cap intents; saw ${totalQueued}`);
});
