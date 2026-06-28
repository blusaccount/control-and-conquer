import test from "node:test";
import assert from "node:assert/strict";
import { MapState } from "../src/Core/MapState.js";
import { GameSession } from "../src/Server/GameSession.js";
import { GameStateSnapshot, ServerMessage } from "../src/Core/types.js";

/**
 * Win-condition tests at both Core and Session level.
 */

const buildTwoTerritoryState = (srcTroops: number, tgtTroops: number): GameStateSnapshot => ({
  tick: 0,
  mapName: "Test Map",
  teams: {
    blue: { id: "blue", name: "Blue Team", color: "#3b82f6" },
    red: { id: "red", name: "Red Team", color: "#ef4444" },
  },
  territories: {
    src: {
      id: "src",
      name: "Source",
      ownerId: "blue",
      troops: srcTroops,
      neighbors: ["tgt"],
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      center: { x: 0, y: 0 },
    },
    tgt: {
      id: "tgt",
      name: "Target",
      ownerId: "red",
      troops: tgtTroops,
      neighbors: ["src"],
      polygon: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
      ],
      center: { x: 1, y: 0 },
    },
  },
  territoryOrder: ["src", "tgt"],
  recentEvents: ["Match started."],
  activeConflicts: [],
  winnerTeamId: null,
});

test("winnerTeamId stays null while at least two teams hold territory", () => {
  const map = new MapState(buildTwoTerritoryState(25, 25));

  for (let i = 0; i < 5; i += 1) {
    map.processTick([]);
  }
  assert.equal(map.getSnapshot().winnerTeamId, null);
});

test("winnerTeamId is set to the conquering team after the last enemy territory is captured", () => {
  const map = new MapState(buildTwoTerritoryState(50, 2));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 40 },
    },
  ]);
  for (let i = 0; i < 5; i += 1) {
    map.processTick([]);
  }

  const final = map.getSnapshot();
  assert.equal(final.territories["tgt"].ownerId, "blue");
  assert.equal(final.winnerTeamId, "blue", "blue should be the winner");
  assert.ok(
    final.recentEvents.some((e) => e.toLowerCase().includes("conquered")),
    "victory event should be in recentEvents",
  );
});

test("attacks queued after match-end are rejected with MATCH_ENDED", () => {
  const map = new MapState(buildTwoTerritoryState(50, 2));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 40 },
    },
  ]);
  for (let i = 0; i < 5; i += 1) {
    map.processTick([]);
  }
  assert.equal(map.getSnapshot().winnerTeamId, "blue");

  const after = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 1 },
    },
  ]);

  assert.equal(after.rejections.length, 1);
  assert.equal(after.rejections[0].rejection.reason, "MATCH_ENDED");
});

test("processTick.matchJustEnded fires exactly once across multiple post-victory ticks", () => {
  const map = new MapState(buildTwoTerritoryState(50, 2));

  let trueCount = 0;
  const firstResult = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 40 },
    },
  ]);
  if (firstResult.matchJustEnded) trueCount += 1;

  for (let i = 0; i < 10; i += 1) {
    const result = map.processTick([]);
    if (result.matchJustEnded) trueCount += 1;
  }
  assert.equal(trueCount, 1, "matchJustEnded must be true on exactly one tick");
});

test("GameSession broadcasts SERVER_MATCH_ENDED exactly once on victory", () => {
  const session = new GameSession(buildTwoTerritoryState(50, 2));
  const c1: ServerMessage[] = [];
  const c2: ServerMessage[] = [];

  session.subscribe("c1", (m) => c1.push(m));
  session.subscribe("c2", (m) => c2.push(m));

  // Queue an overwhelming attack. c1 is "blue".
  session.queueAttack("c1", {
    sourceTerritoryId: "src",
    targetTerritoryId: "tgt",
    troops: 40,
  });

  // Drive ticks until the conflict resolves and victory is declared.
  for (let i = 0; i < 10; i += 1) {
    session.tick();
  }

  const c1Ends = c1.filter((m) => m.type === "SERVER_MATCH_ENDED");
  const c2Ends = c2.filter((m) => m.type === "SERVER_MATCH_ENDED");
  assert.equal(c1Ends.length, 1, "c1 should receive exactly one SERVER_MATCH_ENDED");
  assert.equal(c2Ends.length, 1, "c2 should receive exactly one SERVER_MATCH_ENDED");
  assert.equal(
    (c1Ends[0] as Extract<ServerMessage, { type: "SERVER_MATCH_ENDED" }>).payload.winnerTeamId,
    "blue",
  );
});

test("GameSession does not fire SERVER_MATCH_ENDED while the match is ongoing", () => {
  const session = new GameSession();
  const messages: ServerMessage[] = [];
  session.subscribe("c1", (m) => messages.push(m));
  session.subscribe("c2", () => {});

  for (let i = 0; i < 50; i += 1) {
    session.tick();
  }

  const ends = messages.filter((m) => m.type === "SERVER_MATCH_ENDED");
  assert.equal(ends.length, 0);
});
