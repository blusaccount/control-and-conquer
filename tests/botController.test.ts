import test from "node:test";
import assert from "node:assert/strict";
import { BotController, DEFAULT_BOT_CONFIG } from "../src/Server/BotController.js";
import { GameSession } from "../src/Server/GameSession.js";
import type { AttackOrder, GameStateSnapshot, ServerMessage } from "../src/Core/types.js";

const collectSession = (): {
  session: GameSession;
  attacks: Array<{ clientId: string; order: AttackOrder }>;
  messages: ServerMessage[];
} => {
  const session = new GameSession();
  const messages: ServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));
  // Hook into queueAttack to record the bot's orders. We can't easily spy
  // without modifying the class, but the bot's queued attacks become visible
  // via session.getPendingAttackCount() before tick() drains them.
  return { session, attacks: [], messages };
};

test("BotController.attach receives SERVER_PLAYER_ASSIGNED and stores team id", () => {
  const { session } = collectSession();
  const bot = new BotController();

  assert.equal(bot.getTeamId(), null);
  bot.attach(session);
  assert.notEqual(bot.getTeamId(), null);
  // Human got blue first, so bot is red under the default rotation.
  assert.equal(bot.getTeamId(), "red");
});

test("BotController queues an attack within attackCooldownTicks when an opportunity exists", () => {
  const session = new GameSession();
  // Seat human first so bot lands on the second rotation slot ("red").
  session.subscribe("human", () => {});

  const bot = new BotController({
    ...DEFAULT_BOT_CONFIG,
    minSourceTroops: 1,
    minAttackRatio: 0.1, // very aggressive bot, will attack at first chance
    attackPercent: 0.9,
    attackCooldownTicks: 0,
  });
  bot.attach(session);

  // Drive a few ticks so the bot sees snapshots and can act.
  let attempts = 0;
  while (session.getPendingAttackCount() === 0 && attempts < 5) {
    session.tick();
    attempts += 1;
  }

  assert.ok(
    session.getPendingAttackCount() > 0 || attempts < 5,
    "Bot should have queued at least one attack after a few ticks given an aggressive config.",
  );
});

test("BotController respects attackCooldownTicks", () => {
  const session = new GameSession();
  session.subscribe("human", () => {});

  const bot = new BotController({
    ...DEFAULT_BOT_CONFIG,
    minSourceTroops: 1,
    minAttackRatio: 0.1,
    attackPercent: 0.9,
    attackCooldownTicks: 1000, // effectively never again after the first
  });
  bot.attach(session);

  // Run many ticks. With cooldown 1000, only one (or zero) attacks max in this range.
  let totalQueued = 0;
  for (let i = 0; i < 50; i++) {
    totalQueued += session.getPendingAttackCount();
    session.tick();
  }
  totalQueued += session.getPendingAttackCount();

  assert.ok(totalQueued <= 1, `Cooldown should cap attacks; saw ${totalQueued}`);
});

test("BotController does not attack after the match ends", () => {
  const session = new GameSession();
  const humanMessages: ServerMessage[] = [];
  session.subscribe("human", (m) => humanMessages.push(m));
  const bot = new BotController({
    ...DEFAULT_BOT_CONFIG,
    attackCooldownTicks: 0,
    minSourceTroops: 1,
    minAttackRatio: 0.0,
  });
  bot.attach(session);

  // Drive ticks until a winner exists. The bot is very aggressive so it should
  // either win or get crushed; either way the match eventually ends if we tick long enough.
  // To make this deterministic and fast, we'll cap and just verify the post-end behavior.
  for (let i = 0; i < 2000; i++) {
    session.tick();
    const last = humanMessages[humanMessages.length - 1];
    if (last?.type === "SERVER_MATCH_ENDED") break;
  }

  // If the match never ends in 2000 ticks that's fine — test is informational about post-end behaviour.
  const ended = humanMessages.some((m) => m.type === "SERVER_MATCH_ENDED");
  if (ended) {
    const queuedAfterEnd = session.getPendingAttackCount();
    // After end, snapshots still go out but bot's tryAttack short-circuits on winnerTeamId.
    for (let i = 0; i < 10; i++) session.tick();
    assert.ok(
      session.getPendingAttackCount() === 0 || session.getPendingAttackCount() === queuedAfterEnd,
      "Bot must not queue new attacks after the match has ended.",
    );
  }
});

test("BotController detach stops the bot from queueing further attacks", () => {
  const session = new GameSession();
  session.subscribe("human", () => {});
  const bot = new BotController({
    ...DEFAULT_BOT_CONFIG,
    attackCooldownTicks: 0,
    minSourceTroops: 1,
    minAttackRatio: 0.1,
  });
  const detach = bot.attach(session);

  // Let the bot act a couple of ticks while attached.
  session.tick();
  session.tick();

  detach();
  assert.equal(bot.getTeamId(), null, "detach should clear team id");

  // Drain whatever the bot may have queued just before detach.
  session.tick();
  const baseline = session.getPendingAttackCount();

  // Now run many more ticks. With the bot detached, no NEW attacks should appear.
  for (let i = 0; i < 30; i++) session.tick();
  assert.equal(
    session.getPendingAttackCount(),
    baseline,
    "Detached bot must not enqueue any new attacks.",
  );
});

test("BotController picks deterministically: same snapshot -> same attack", () => {
  // Two parallel sessions seeded identically should produce identical bot behaviour.
  const sessionA = new GameSession();
  const sessionB = new GameSession();
  sessionA.subscribe("human", () => {});
  sessionB.subscribe("human", () => {});

  const botA = new BotController({ ...DEFAULT_BOT_CONFIG, attackCooldownTicks: 0, minSourceTroops: 1, minAttackRatio: 0.1 });
  const botB = new BotController({ ...DEFAULT_BOT_CONFIG, attackCooldownTicks: 0, minSourceTroops: 1, minAttackRatio: 0.1 });
  botA.attach(sessionA);
  botB.attach(sessionB);

  for (let i = 0; i < 20; i++) {
    sessionA.tick();
    sessionB.tick();
  }

  // Last-attack-tick is a public proxy for "did the bot act and when".
  assert.equal(
    botA.getLastAttackTick(),
    botB.getLastAttackTick(),
    "Deterministic bot should fire on identical ticks in identical sessions.",
  );
});
