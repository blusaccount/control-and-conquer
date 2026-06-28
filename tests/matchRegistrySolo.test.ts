import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import type { ServerMessage } from "../src/Core/types.js";

test("joinSolo starts the match immediately — no SERVER_LOBBY_WAITING", () => {
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.joinSolo("human-1", (m) => messages.push(m));

  // Human should immediately get PLAYER_ASSIGNED + STATE_SNAPSHOT, never LOBBY_WAITING.
  assert.equal(messages.some((m) => m.type === "SERVER_LOBBY_WAITING"), false);
  assert.equal(messages.some((m) => m.type === "SERVER_PLAYER_ASSIGNED"), true);
  assert.equal(messages.some((m) => m.type === "SERVER_STATE_SNAPSHOT"), true);
});

test("joinSolo seats human as blue (first rotation slot)", () => {
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.joinSolo("human-1", (m) => messages.push(m));

  const assigned = messages.find((m) => m.type === "SERVER_PLAYER_ASSIGNED");
  assert.ok(assigned && assigned.type === "SERVER_PLAYER_ASSIGNED");
  assert.equal(assigned.payload.teamId, "blue");
});

test("joinSolo creates an isolated session — does not consume the PvP lobby slot", () => {
  const registry = new MatchRegistry();
  const soloMessages: ServerMessage[] = [];
  const pvpMessages: ServerMessage[] = [];

  registry.joinSolo("solo-1", (m) => soloMessages.push(m));
  registry.join("pvp-1", (m) => pvpMessages.push(m));

  // PvP first-comer should still see LOBBY_WAITING; solo did not eat the slot.
  assert.equal(pvpMessages.some((m) => m.type === "SERVER_LOBBY_WAITING"), true);
  assert.equal(registry.getActiveMatchCount(), 1); // only the solo match is "active"
});

test("joinSolo tick produces snapshots broadcast to the human", () => {
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.joinSolo("human-1", (m) => messages.push(m));
  const beforeSnapshots = messages.filter((m) => m.type === "SERVER_STATE_SNAPSHOT").length;

  registry.tickAll();
  registry.tickAll();
  registry.tickAll();

  const afterSnapshots = messages.filter((m) => m.type === "SERVER_STATE_SNAPSHOT").length;
  assert.equal(afterSnapshots - beforeSnapshots, 3, "Each tick should broadcast one snapshot to the human.");
});

test("joinSolo unsubscribe cleans up the match", () => {
  const registry = new MatchRegistry();
  const unsubscribe = registry.joinSolo("human-1", () => {});
  assert.equal(registry.getActiveMatchCount(), 1);

  unsubscribe();
  assert.equal(registry.getActiveMatchCount(), 0);
});

test("attacks queued by the bot are eventually executed in the same session", () => {
  // We don't directly observe the bot's queue, but we do observe that the
  // game state changes over time (troop counts move, conflicts appear).
  // With the default bot and default map there should eventually be a
  // SERVER_ACTION_REJECTED or a tick where activeConflicts is non-empty.
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.joinSolo("human-1", (m) => messages.push(m));

  for (let i = 0; i < 600; i++) registry.tickAll(); // 30s of simulated game

  const snapshots = messages.filter((m): m is Extract<ServerMessage, { type: "SERVER_STATE_SNAPSHOT" }> => m.type === "SERVER_STATE_SNAPSHOT");
  const sawConflict = snapshots.some((s) => s.payload.activeConflicts.length > 0);
  const sawCapture = snapshots.some((s) => s.payload.recentEvents.some((e) => /captured/i.test(e)));

  assert.ok(sawConflict || sawCapture, "Over 30s of simulated time the bot should produce at least one conflict or capture.");
});
