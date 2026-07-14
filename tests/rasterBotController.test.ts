import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { RasterBotController, DEFAULT_RASTER_BOT_CONFIG } from "../src/Server/RasterBotController.js";
import type { RasterServerMessage } from "../src/Core/types.js";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";
import { NATION_DECISION_TICKS } from "../src/Server/botField.js";

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

test("RasterBot opens with the land rush (an expand within its first cycle)", () => {
  // Seat a human first so the bot becomes player 2. Impossible cadence rolls
  // 30–49 ticks, so the opening half-pool rush lands within ~100 ticks.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", kind: "nation", difficulty: "impossible", seed: 0 });
  bot.attach(session);

  let any = false;
  for (let i = 0; i < 120; i += 1) {
    session.tick();
    if (session.getPendingExpandCount() > 0) { any = true; break; }
  }
  assert.ok(any, "the nation should queue its opening expand within its first decision cycle");
});

test("RasterBot expands into real land instead of stalling on water/rock", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", kind: "nation", difficulty: "impossible", seed: 0 });
  bot.attach(session);

  for (let i = 0; i < 300; i += 1) session.tick();

  const botId = bot.getPlayerId();
  assert.ok(botId !== null);
  const grid = session.peekGrid();
  assert.ok(grid.tileCountOf(botId!) > 1, `bot should capture beyond its spawn, owns ${grid.tileCountOf(botId!)}`);
});

test("RasterBot decisions follow its rolled cadence (no per-tick spam)", () => {
  // Two evenly-matched nations split the map, so neither hits the 80% win
  // inside the window and the decision stream keeps flowing.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 7 });
  const a = new RasterBotController({ botId: "cadence-a", kind: "nation", difficulty: "impossible", seed: 0 });
  const b = new RasterBotController({ botId: "cadence-b", kind: "nation", difficulty: "impossible", seed: 1 });
  a.attach(session);
  b.attach(session);

  const decisions: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 400; i += 1) {
    session.tick();
    const t = a.getLastDecisionTick();
    if (t !== last && Number.isFinite(t)) {
      decisions.push(t);
      last = t;
    }
  }
  assert.ok(decisions.length >= 3, `several decisions happened (saw ${decisions.length})`);
  const [lo] = NATION_DECISION_TICKS.impossible;
  for (let i = 1; i < decisions.length; i += 1) {
    assert.ok(decisions[i] - decisions[i - 1] >= lo, `decisions ${decisions[i - 1]}→${decisions[i]} spaced by the cadence`);
  }
});

test("RasterBot prefers cheap neutral land over an evenly-matched rival", () => {
  // Two nations, plenty of neutral land between them: both pour troops into
  // neutral tiles (OpenFront's unconditional terra-nullius priority) rather
  // than starting an expensive early war.
  const session = new RasterGameSession({ width: 48, height: 32, seed: 7 });
  const a = new RasterBotController({ botId: "a", kind: "nation", difficulty: "impossible", seed: 0 });
  const b = new RasterBotController({ botId: "b", kind: "nation", difficulty: "impossible", seed: 1 });
  a.attach(session);
  b.attach(session);

  for (let i = 0; i < 400; i += 1) session.tick();

  const grid = session.peekGrid();
  const ownedByBots = grid.tileCountOf(a.getPlayerId()!) + grid.tileCountOf(b.getPlayerId()!);
  assert.ok(grid.tileCountOf(a.getPlayerId()!) > 3, "bot A should have expanded");
  assert.ok(grid.tileCountOf(b.getPlayerId()!) > 3, "bot B should have expanded");
  assert.ok(ownedByBots > grid.capturableCount * 0.2, "bots should carve up a real share of the map");
});

test("A field of nations drives toward a decisive outcome", () => {
  // Four Impossible nations on a connected continent should not deadlock:
  // once the wilderness is gone, the strategy ladder (veryWeak → victim →
  // weakest) keeps fronts open and territory consolidating.
  const session = new RasterGameSession({ width: 40, height: 28, seed: 20 });
  const bots = [0, 1, 2, 3].map((i) =>
    new RasterBotController({ botId: `bot-${i}`, kind: "nation", difficulty: "impossible", seed: i }),
  );
  for (const bot of bots) bot.attach(session);

  for (let i = 0; i < 1500; i += 1) session.tick();

  const grid = session.peekGrid();
  const counts = bots.map((bot) => grid.tileCountOf(bot.getPlayerId()!));
  const leader = Math.max(...counts);
  assert.ok(leader > grid.capturableCount * 0.3, `leader should dominate; held ${leader}/${grid.capturableCount}`);
});

test("DEFAULT_RASTER_BOT_CONFIG seats a medium Nation", () => {
  assert.equal(DEFAULT_RASTER_BOT_CONFIG.kind, "nation");
  assert.equal(DEFAULT_RASTER_BOT_CONFIG.difficulty, "medium");
});

// --- Bot (Tribe) filler vs. Nation: behaviour differences -------------------

test("a Bot filler never builds, even once it holds land and gold", () => {
  const session = new RasterGameSession({ width: 48, height: 32, seed: 5 });
  session.subscribe("human", () => {});
  const bot = new RasterBotController({ botId: "bot", kind: "bot", difficulty: "medium", seed: 0 });
  bot.attach(session);
  const botId = bot.getPlayerId()!;
  const grid = session.peekGrid();

  for (let i = 0; i < 400; i += 1) {
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
  // Wall off a third of the map for the human BEFORE the tribe spawns — the
  // tribe's land rush would otherwise hit the 80% win and freeze the clock
  // before its second decision beat (the first is the rush itself).
  {
    const grid = session.peekGrid();
    const map = session.peekMap();
    for (let y = 0; y < 24; y += 1) {
      for (let x = 0; x < 11; x += 1) {
        const ref = map.ref(x, y);
        if (grid.isCapturable(ref)) grid.claim(ref, 1);
      }
    }
    grid.setTroops(1, 5_000_000);
  }
  const bot = new RasterBotController({ botId: "bot", kind: "bot", difficulty: "medium", seed: 0 });
  bot.attach(session);
  const botId = bot.getPlayerId()!;

  // A tribe accepts every offer, with no judgement at all — even from a
  // far weaker human.
  // The tribe answers on a decision beat; its first beat is consumed by the
  // opening land rush, so allow two full cycles (cadence rolls up to 79 ticks).
  session.proposeAlliance("human", botId);
  let allied = false;
  for (let i = 0; i < 300 && !allied; i += 1) {
    session.tick();
    allied = session.peekAlliances().areAllied(1, botId);
  }
  assert.ok(allied, "the Bot filler accepted the human's alliance offer");
});

test("a Nation retaliates conventionally against its attacker, even a stronger one", () => {
  // Two big blocks sharing a border: a strong human and a nation that would
  // never attack a stronger rival on its own (the weakest strategy requires
  // fewer troops than ours). After the human attacks, the retaliate strategy —
  // first in no difficulty later than third — answers with force, bypassing
  // even the anti-human throttle.
  const width = 30;
  const height = 8;
  const flat = buildTerrainFromMask({
    width, height,
    land: new Uint8Array(width * height).fill(1),
    elevation: new Uint8Array(width * height),
  });
  const session = new RasterGameSession({ prebuiltMap: flat, spawnPhaseTicks: 0 });
  session.subscribe("human", () => {}); // player 1
  const snaps: Array<{ recentEvents: string[]; players: Array<{ playerId: number; name: string }> }> = [];
  session.subscribe("watch", (m) => { if (m.type === "SERVER_RASTER_SNAPSHOT") snaps.push(m.payload); }, false);
  // Medium: no Hard/Impossible home-guard cap (which would rightly refuse to
  // commit against a 2x-stronger neighbour), so the answer comes through the
  // retaliate strategy (live incoming attack) or the relations-driven grudge.
  const bot = new RasterBotController({ botId: "nation", kind: "nation", difficulty: "medium", seed: 2 });
  bot.attach(session); // player 2
  const p2 = bot.getPlayerId()!;
  const grid = session.peekGrid();
  session.tick(); // leave the (0-tick) spawn phase before arranging the board

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      grid.claim(y * width + x, x < 15 ? 1 : p2);
    }
  }
  // Freeze incomes; a heavy defense modifier keeps the human's pushes from
  // simply deleting the nation before it can answer.
  grid.setModifiers(1, { ...IDENTITY_MODIFIERS, income: 0 });
  grid.setModifiers(p2, { ...IDENTITY_MODIFIERS, income: 0, defense: 8 });
  grid.addTroops(1, 300_000 - grid.troopsOf(1));
  grid.addTroops(p2, 150_000 - grid.troopsOf(p2));

  // Sustained pressure: a fresh small push every 20 ticks keeps an incoming
  // attack live across every decision beat (the retaliation read is live,
  // exactly like OpenFront's incomingAttacks()). The counter-attack may be
  // fully netted against the incoming front at launch (no visible front of
  // its own), so detect it by the public event line instead.
  const botName = (): string => snaps.at(-1)?.players.find((p) => p.playerId === p2)?.name ?? " ";
  let foughtBack = false;
  for (let i = 0; i < 400 && !foughtBack; i += 1) {
    if (i % 20 === 0) session.queueExpand("human", { targetX: 20, targetY: 4, percent: 3 });
    session.tick();
    const name = botName();
    foughtBack = (snaps.at(-1)?.recentEvents ?? []).some((e) => e.startsWith(name) && e.includes("committed"));
  }
  assert.ok(foughtBack, "the nation fought back against its attacker instead of banking");
});

test("a Tribe (bot) strikes a neighbour once banked past its trigger — no dead map", () => {
  // OpenFront's tribes bank to their trigger ratio (50–60% of max troops),
  // then poke a random neighbour (nations/humans skipped half the time). Box
  // one in with a weak rival and zero neutral land, hand it a banked pool, and
  // confirm the strike takes ground.
  const W = 12;
  const flat = buildTerrainFromMask({
    width: W, height: 1,
    land: new Uint8Array(W).fill(1),
    elevation: new Uint8Array(W),
  });
  const session = new RasterGameSession({ prebuiltMap: flat, spawnPhaseTicks: 0 });
  session.subscribe("human", () => {}); // player 1 (the rival)
  const bot = new RasterBotController({ botId: "tribe", kind: "bot", difficulty: "medium", seed: 3 });
  bot.attach(session); // player 2 (the tribe)
  const p2 = bot.getPlayerId()!;
  const grid = session.peekGrid();
  session.tick(); // leave the (0-tick) spawn phase before arranging the board

  // Split the whole row between the two — no neutral left, nobody at the
  // domination threshold (7/12 vs 5/12).
  for (let r = 0; r < 7; r += 1) grid.claim(r, 1);
  for (let r = 7; r < W; r += 1) grid.claim(r, p2);
  grid.setModifiers(1, { ...IDENTITY_MODIFIERS, income: 0 });
  grid.setModifiers(p2, { ...IDENTITY_MODIFIERS, income: 0, neutralCostMultiplier: 0.5 });
  grid.addTroops(1, 40 - grid.troopsOf(1)); // rival down to ~40 troops over its 7 tiles
  grid.addTroops(p2, 90_000 - grid.troopsOf(p2)); // tribe banked past its trigger ratio

  const rivalBefore = grid.tileCountOf(1);
  for (let i = 0; i < 600; i += 1) session.tick();

  assert.ok(
    grid.tileCountOf(1) < rivalBefore,
    `the tribe should keep poking and take ground (rival ${rivalBefore} → ${grid.tileCountOf(1)})`,
  );
});
