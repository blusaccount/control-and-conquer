import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import type { RasterServerMessage } from "../src/Core/types.js";

test("joinRasterSolo starts immediately and assigns a player", () => {
  const registry = new MatchRegistry();
  const messages: RasterServerMessage[] = [];
  registry.joinRasterSolo("human", (m) => messages.push(m), { width: 24, height: 16, seed: 1 });

  assert.equal(messages.some((m) => m.type === "SERVER_RASTER_PLAYER_ASSIGNED"), true);
  assert.equal(messages.some((m) => m.type === "SERVER_RASTER_SNAPSHOT"), true);
});

test("joinRasterSolo creates an isolated raster match", () => {
  const registry = new MatchRegistry();
  registry.joinRasterSolo("a", () => {}, { width: 24, height: 16, seed: 1 });
  registry.joinRasterSolo("b", () => {}, { width: 24, height: 16, seed: 2 });
  assert.equal(registry.getActiveRasterMatchCount(), 2);
});

test("joinRasterSolo unsubscribe cleans the match up", () => {
  const registry = new MatchRegistry();
  const off = registry.joinRasterSolo("a", () => {}, { width: 16, height: 12, seed: 1 });
  assert.equal(registry.getActiveRasterMatchCount(), 1);
  off();
  assert.equal(registry.getActiveRasterMatchCount(), 0);
});

test("tickAll drives raster snapshots too", () => {
  const registry = new MatchRegistry();
  const messages: RasterServerMessage[] = [];
  registry.joinRasterSolo("a", (m) => messages.push(m), { width: 16, height: 12, seed: 1 });
  const before = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  registry.tickAll();
  registry.tickAll();
  registry.tickAll();
  const after = messages.filter((m) => m.type === "SERVER_RASTER_SNAPSHOT").length;
  // 1 initial + 3 ticks * 2 subscribers (human + bot) but bot has its own callback;
  // we only count messages on the human channel.
  assert.equal(after - before, 3);
});
