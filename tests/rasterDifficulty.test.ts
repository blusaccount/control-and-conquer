import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { DIFFICULTY_BOT_COUNT, MAX_FIELD, scaleFieldCount } from "../src/Server/MatchRegistry.js";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import { isRasterDifficulty, RASTER_DIFFICULTIES } from "../src/Core/messages.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { kindForSeat, splitField, tribeName } from "../src/Server/botField.js";
import type { RasterServerMessage } from "../src/Core/types.js";

test("difficulty seats more rival nations as it rises", () => {
  assert.ok(DIFFICULTY_BOT_COUNT.easy < DIFFICULTY_BOT_COUNT.medium);
  assert.ok(DIFFICULTY_BOT_COUNT.medium < DIFFICULTY_BOT_COUNT.hard);
  for (const d of RASTER_DIFFICULTIES) assert.ok(DIFFICULTY_BOT_COUNT[d] > 0);
});

test("the field scales up with the land a map offers", () => {
  // A tiny (Classic-scale) map stays a small handful; ever-larger maps seat
  // strictly more opponents, scaling with the land available.
  const tiny = scaleFieldCount(1_500, "medium");
  const large = scaleFieldCount(120_000, "medium");
  const huge = scaleFieldCount(480_000, "medium");
  assert.ok(tiny < large, `tiny (${tiny}) should field fewer than large (${large})`);
  assert.ok(large < huge, `large (${large}) should field fewer than huge (${huge})`);
});

test("the field density matches OpenFront's World (≈1370 land tiles per seat)", () => {
  // OpenFront's World FFA: 651,609 land tiles (world/manifest.json) shared by
  // ~475 AI (400 bots + ~75 nations) ≈ 1,370 land tiles per seat. Our maps
  // must seat at that *land* density — the old sqrt scaling packed small maps
  // ~2× too tight, ending the opening land-grab in under a minute.
  const standardLand = 40_000; // earth-standard's capturable land (measured ~40.4k)
  const largeLand = 161_000; // earth-large ≈ 4× standard
  const hugeLand = 645_000; // earth-huge ≈ OpenFront's World land count
  const large = scaleFieldCount(largeLand, "medium");
  assert.ok(
    largeLand / large >= 1200 && largeLand / large <= 1600,
    `earth-large lands on OpenFront's density, got ${largeLand / large} tiles/seat`,
  );
  // earth-huge carries OpenFront's whole World-scale crowd (capped at 400).
  assert.equal(scaleFieldCount(hugeLand, "medium"), MAX_FIELD);
  // Small maps floor at the difficulty minimum rather than over-packing.
  const standard = scaleFieldCount(standardLand, "medium");
  assert.ok(
    standardLand / standard >= 1200 || standard === DIFFICULTY_BOT_COUNT.medium,
    `earth-standard is not over-packed, got ${standardLand / standard} tiles/seat`,
  );
  // The ceiling matches OpenFront's default bot count.
  assert.equal(MAX_FIELD, 400);
});

test("a tiny map floors at the difficulty minimum, a vast one caps at MAX_FIELD", () => {
  for (const d of RASTER_DIFFICULTIES) {
    assert.equal(scaleFieldCount(1, d), DIFFICULTY_BOT_COUNT[d], "tiny maps fall back to the floor");
    assert.equal(scaleFieldCount(50_000_000, d), MAX_FIELD, "vast maps cap at the field limit");
  }
});

test("harder difficulty packs a denser field onto the same map", () => {
  const tiles = 120_000;
  assert.ok(scaleFieldCount(tiles, "easy") < scaleFieldCount(tiles, "medium"));
  assert.ok(scaleFieldCount(tiles, "medium") < scaleFieldCount(tiles, "hard"));
});

test("isRasterDifficulty accepts the known ids and rejects everything else", () => {
  for (const d of RASTER_DIFFICULTIES) assert.ok(isRasterDifficulty(d));
  assert.equal(isRasterDifficulty("nightmare"), false);
  assert.equal(isRasterDifficulty(undefined), false);
  assert.equal(isRasterDifficulty(3), false);
});

test("a session seats many distinct nations on a real map", () => {
  // The World map has ample land for a crowded field.
  const session = new RasterGameSession({ realMapId: "world", maxDurationTicks: 999 });
  const N = 20;
  for (let i = 0; i < N; i += 1) session.subscribe(`p${i}`, () => {}); // autoSpawn = true
  const grid = session.peekGrid();
  const players = [...grid.players()];
  assert.equal(players.length, N, "every nation is seated");
  // Every nation founds its own blob (OpenFront's spawn radius). Blobs only
  // claim unowned land, so the seats never overlap — each keeps at least its
  // own founding tile.
  for (const id of players) {
    assert.ok(grid.tileCountOf(id) >= 1, `player ${id} holds its founding blob`);
  }
});

// --- Bot (Tribe) vs Nation field composition --------------------------------

test("the field is bot-heavy like OpenFront (~1 nation per ~5 bots)", () => {
  // OpenFront's World defaults to 400 bots + 75 nations ≈ 16% nations.
  const { nations, bots } = splitField(100);
  assert.equal(nations + bots, 100, "the split is exhaustive");
  assert.ok(nations >= 14 && nations <= 18, `~16% nations, got ${nations}`);
  assert.ok(bots > nations * 4, "far more passive tribes than nations");
  // Always at least one nation (someone must build/ally/nuke), even in a tiny field.
  assert.equal(splitField(1).nations, 1);
  assert.deepEqual(splitField(0), { nations: 0, bots: 0 });
});

test("kindForSeat puts the nations first, then the tribe fillers", () => {
  const { nations } = splitField(30);
  const kinds = Array.from({ length: 30 }, (_, i) => kindForSeat(i, nations));
  assert.equal(kinds.filter((k) => k === "nation").length, nations);
  assert.equal(kinds.filter((k) => k === "bot").length, 30 - nations);
  assert.equal(kindForSeat(0, nations), "nation", "the first seats are Nations");
  assert.equal(kindForSeat(29, nations), "bot", "the tail is Bot filler");
});

test("tribeName is deterministic and always two words", () => {
  for (let i = 0; i < 50; i += 1) {
    const name = tribeName(i);
    assert.equal(tribeName(i), name, "same seat index always yields the same name");
    assert.match(name, /^\S+ \S+$/, `"${name}" should be exactly two words`);
  }
});

test("a solo match seats both Bot fillers and Nations, distinguishable by name shape", () => {
  const registry = new MatchRegistry();
  const messages: RasterServerMessage[] = [];
  // A big field on "hard" so the 1-in-3 Bot split is well past one seat.
  registry.joinRasterSolo("human", (m) => messages.push(m), { realMapId: "world" }, "hard", 12);
  // The human's very first snapshot predates the bots being seated (each
  // subscribe() only pushes its *own* initial snapshot); a real tick
  // broadcasts a fresh one to every subscriber, human included.
  for (let i = 0; i < 5; i += 1) registry.tickAll();

  const snapshot = [...messages].reverse().find((m) => m.type === "SERVER_RASTER_SNAPSHOT");
  assert.ok(snapshot && snapshot.type === "SERVER_RASTER_SNAPSHOT");
  if (!snapshot || snapshot.type !== "SERVER_RASTER_SNAPSHOT") return;
  const names = snapshot.payload.players.map((p) => p.name).filter((n) => n !== undefined);
  assert.ok(names.length >= 12, "every bot seat appears in standings");

  // Nation names are drawn from the curated list (e.g. "Iron Pact"); Bot names
  // are always "<Prefix> <Suffix>" pairs from the tribal lists — the two pools
  // don't overlap, so at least one of each confirms both kinds were seated.
  const nationNames = new Set(["Blue Empire", "Red Empire", "Green Empire", "Amber Empire", "Violet Empire", "Cyan Empire", "Iron Pact", "Sun Dominion"]);
  const looksLikeTribe = (n: string): boolean => /^(Roman|Hittite|Sumerian|Akkadian|Babylonian|Phoenician|Greek|Persian|Egyptian|Numidian|Thracian|Scythian|Gothic|Frankish|Norman|Saxon|Celtic|Iberian|Mongol|Khazar|Cuman|Avar|Bulgar|Magyar) /.test(n);
  assert.ok(names.some((n) => nationNames.has(n)), "at least one seat is a recognisable Nation");
  assert.ok(names.some(looksLikeTribe), "at least one seat is a recognisable Bot tribe");
});

test("validateCommand accepts a JOIN with difficulty and rejects an unknown one", () => {
  const ok = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { difficulty: "hard" } });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  if (ok.type === "CLIENT_RASTER_JOIN") assert.equal(ok.payload.difficulty, "hard");
  assert.throws(() =>
    validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { difficulty: "nightmare" } }),
  );
});
