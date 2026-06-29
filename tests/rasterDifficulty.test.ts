import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { DIFFICULTY_BOT_COUNT } from "../src/Server/MatchRegistry.js";
import { isRasterDifficulty, RASTER_DIFFICULTIES } from "../src/Core/messages.js";
import { validateCommand } from "../src/Server/validateCommand.js";

test("difficulty seats more rival nations as it rises", () => {
  assert.ok(DIFFICULTY_BOT_COUNT.easy < DIFFICULTY_BOT_COUNT.medium);
  assert.ok(DIFFICULTY_BOT_COUNT.medium < DIFFICULTY_BOT_COUNT.hard);
  for (const d of RASTER_DIFFICULTIES) assert.ok(DIFFICULTY_BOT_COUNT[d] > 0);
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
