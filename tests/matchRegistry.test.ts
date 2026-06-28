import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import { ServerMessage } from "../src/Core/types.js";

const collectMessages = (registry: MatchRegistry, clientId: string): ServerMessage[] => {
  const messages: ServerMessage[] = [];
  registry.join(clientId, (message) => messages.push(message));
  return messages;
};

test("first client receives SERVER_LOBBY_WAITING", () => {
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.join("c1", (message) => messages.push(message));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "SERVER_LOBBY_WAITING");
});

test("second client triggers match start — both receive SERVER_PLAYER_ASSIGNED", () => {
  const registry = new MatchRegistry();
  const c1Messages: ServerMessage[] = [];
  const c2Messages: ServerMessage[] = [];

  registry.join("c1", (message) => c1Messages.push(message));
  registry.join("c2", (message) => c2Messages.push(message));

  const c1Assigned = c1Messages.filter((m) => m.type === "SERVER_PLAYER_ASSIGNED");
  const c2Assigned = c2Messages.filter((m) => m.type === "SERVER_PLAYER_ASSIGNED");

  assert.equal(c1Assigned.length, 1);
  assert.equal(c2Assigned.length, 1);
});

test("matched players receive distinct team ids", () => {
  const registry = new MatchRegistry();
  const c1Messages: ServerMessage[] = [];
  const c2Messages: ServerMessage[] = [];

  registry.join("c1", (message) => c1Messages.push(message));
  registry.join("c2", (message) => c2Messages.push(message));

  const c1Assigned = c1Messages.find(
    (m): m is Extract<ServerMessage, { type: "SERVER_PLAYER_ASSIGNED" }> => m.type === "SERVER_PLAYER_ASSIGNED",
  )!;
  const c2Assigned = c2Messages.find(
    (m): m is Extract<ServerMessage, { type: "SERVER_PLAYER_ASSIGNED" }> => m.type === "SERVER_PLAYER_ASSIGNED",
  )!;

  assert.notEqual(c1Assigned.payload.teamId, c2Assigned.payload.teamId);
});

test("third client opens a new lobby slot and receives SERVER_LOBBY_WAITING", () => {
  const registry = new MatchRegistry();
  const c3Messages: ServerMessage[] = [];

  registry.join("c1", () => {});
  registry.join("c2", () => {});
  registry.join("c3", (message) => c3Messages.push(message));

  assert.equal(c3Messages.length, 1);
  assert.equal(c3Messages[0].type, "SERVER_LOBBY_WAITING");
});

test("two matches are isolated — each pair gets its own state snapshot", () => {
  const registry = new MatchRegistry();

  const snapshots = (messages: ServerMessage[]) =>
    messages
      .filter((m): m is Extract<ServerMessage, { type: "SERVER_STATE_SNAPSHOT" }> => m.type === "SERVER_STATE_SNAPSHOT")
      .map((m) => m.payload);

  const m1c1: ServerMessage[] = [];
  const m1c2: ServerMessage[] = [];
  const m2c1: ServerMessage[] = [];
  const m2c2: ServerMessage[] = [];

  registry.join("m1c1", (m) => m1c1.push(m));
  registry.join("m1c2", (m) => m1c2.push(m));
  registry.join("m2c1", (m) => m2c1.push(m));
  registry.join("m2c2", (m) => m2c2.push(m));

  // Each active player should have received an initial state snapshot.
  assert.equal(snapshots(m1c1).length, 1);
  assert.equal(snapshots(m1c2).length, 1);
  assert.equal(snapshots(m2c1).length, 1);
  assert.equal(snapshots(m2c2).length, 1);

  // Queue an attack in match 1 and tick — only match-1 players get the update.
  registry.queueAttack("m1c1", {
    sourceTerritoryId: "west",
    targetTerritoryId: "center",
    troops: 2,
  });
  registry.tickAll();

  const m1c1Snaps = snapshots(m1c1);
  const m2c1Snaps = snapshots(m2c1);

  // Match-1 client gets a new snapshot after the tick.
  assert.ok(m1c1Snaps.length > 1, "match-1 player should receive post-tick snapshot");
  // Match-2 client also receives a post-tick snapshot (its own isolated game ticked too).
  assert.ok(m2c1Snaps.length > 1, "match-2 player should receive post-tick snapshot");

  // The snapshots of the two matches must evolve independently.
  const m1Tick1 = m1c1Snaps[m1c1Snaps.length - 1];
  const m2Tick1 = m2c1Snaps[m2c1Snaps.length - 1];

  // Match-1 has an active conflict; match-2 does not (no attack was queued there).
  assert.ok(m1Tick1.activeConflicts.length > 0, "match-1 should have an active conflict after the attack");
  assert.equal(m2Tick1.activeConflicts.length, 0, "match-2 should have no conflicts");
});

test("disconnecting a lobby client frees the slot for the next joiner", () => {
  const registry = new MatchRegistry();
  const c2Messages: ServerMessage[] = [];

  const unsubscribeC1 = registry.join("c1", () => {});
  // c1 is in lobby; c2 would pair with c1 normally.
  // Disconnect c1 first — slot should be released.
  unsubscribeC1();

  // c2 now joins an empty registry and should go into the lobby.
  registry.join("c2", (m) => c2Messages.push(m));

  assert.equal(c2Messages.length, 1);
  assert.equal(c2Messages[0].type, "SERVER_LOBBY_WAITING");
});

test("attacks from a lobby client are silently ignored", () => {
  const registry = new MatchRegistry();
  const messages: ServerMessage[] = [];

  registry.join("c1", (m) => messages.push(m));

  // Should not throw even though c1 has no session yet.
  assert.doesNotThrow(() => {
    registry.queueAttack("c1", {
      sourceTerritoryId: "west",
      targetTerritoryId: "center",
      troops: 1,
    });
  });
});
