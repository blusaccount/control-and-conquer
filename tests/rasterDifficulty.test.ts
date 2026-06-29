import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { DIFFICULTY_BOT_COUNT, MAX_RASTER_BOTS, scaleBotCount } from "../src/Server/MatchRegistry.js";
import { isRasterDifficulty, RASTER_DIFFICULTIES } from "../src/Core/messages.js";
import { validateCommand } from "../src/Server/validateCommand.js";

test("difficulty seats more rival nations as it rises", () => {
  assert.ok(DIFFICULTY_BOT_COUNT.easy < DIFFICULTY_BOT_COUNT.medium);
  assert.ok(DIFFICULTY_BOT_COUNT.medium < DIFFICULTY_BOT_COUNT.hard);
  for (const d of RASTER_DIFFICULTIES) assert.ok(DIFFICULTY_BOT_COUNT[d] > 0);
});

test("the field scales up with the land a map offers", () => {
  // A tiny (Classic-scale) map stays a small handful; ever-larger maps seat
  // strictly more nations, scaling with the tiles available.
  const tiny = scaleBotCount(1_500, "medium");
  const standard = scaleBotCount(30_000, "medium");
  const large = scaleBotCount(120_000, "medium");
  const huge = scaleBotCount(480_000, "medium");
  assert.ok(tiny < standard, `tiny (${tiny}) should field fewer than standard (${standard})`);
  assert.ok(standard < large, `standard (${standard}) should field fewer than large (${large})`);
  assert.ok(large <= huge, `large (${large}) should not exceed huge (${huge})`);
});

test("a tiny map floors at the difficulty minimum, a vast one caps at the seat limit", () => {
  for (const d of RASTER_DIFFICULTIES) {
    assert.equal(scaleBotCount(1, d), DIFFICULTY_BOT_COUNT[d], "tiny maps fall back to the floor");
    assert.equal(scaleBotCount(50_000_000, d), MAX_RASTER_BOTS, "vast maps cap at the seat limit");
  }
});

test("harder difficulty packs a denser field onto the same map", () => {
  const tiles = 120_000;
  assert.ok(scaleBotCount(tiles, "easy") < scaleBotCount(tiles, "medium"));
  assert.ok(scaleBotCount(tiles, "medium") < scaleBotCount(tiles, "hard"));
});

test("isRasterDifficulty accepts the known ids and rejects everything else", () => {
  for (const d of RASTER_DIFFICULTIES) assert.ok(isRasterDifficulty(d));
  assert.equal(isRasterDifficulty("impossible"), false);
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
  // Each holds exactly its own founding tile, so no two share a spawn.
  let owned = 0;
  for (const id of players) owned += grid.tileCountOf(id);
  assert.equal(owned, N, "spawns are distinct (one tile each, no overlap)");
});

test("validateCommand accepts a JOIN with difficulty and rejects an unknown one", () => {
  const ok = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { difficulty: "hard" } });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  if (ok.type === "CLIENT_RASTER_JOIN") assert.equal(ok.payload.difficulty, "hard");
  assert.throws(() =>
    validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { difficulty: "nightmare" } }),
  );
});
