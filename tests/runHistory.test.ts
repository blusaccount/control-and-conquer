import test from "node:test";
import assert from "node:assert/strict";
import { loadRunHistory, recordRun, type StorageLike } from "../src/Client/runHistory.js";
import type { RasterMatchEndedPayload } from "../src/Core/types.js";

const makeStorage = (seed?: string): StorageLike => {
  const mem = new Map<string, string>();
  if (seed !== undefined) mem.set("cnc-run-history", seed);
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v);
    },
  };
};

const payload = (over: Partial<RasterMatchEndedPayload["stats"]> = {}): RasterMatchEndedPayload => ({
  winnerPlayerId: 1,
  reason: "conquest",
  durationTicks: 200,
  tickRate: 20,
  stats: {
    playerId: 1,
    peakTiles: 50,
    finalTiles: 40,
    kills: 2,
    survivedTicks: 100,
    eliminated: false,
    won: true,
    ...over,
  },
});

test("recordRun assigns incrementing run numbers and converts survival ticks to seconds", () => {
  const storage = makeStorage();
  const first = recordRun(storage, payload(), 1000);
  assert.equal(first.run, 1);
  assert.equal(first.survivedSeconds, 5); // 100 ticks / 20 tps

  const second = recordRun(storage, payload({ won: false, eliminated: true, survivedTicks: 40 }), 2000);
  assert.equal(second.run, 2);
  assert.equal(second.survivedSeconds, 2);

  const history = loadRunHistory(storage);
  assert.equal(history.length, 2);
  assert.equal(history[0].won, true);
  assert.equal(history[1].won, false);
});

test("loadRunHistory tolerates absent and corrupt storage", () => {
  assert.deepEqual(loadRunHistory(makeStorage()), []);
  assert.deepEqual(loadRunHistory(makeStorage("not json")), []);
  assert.deepEqual(loadRunHistory(makeStorage('{"not":"an array"}')), []);
});
