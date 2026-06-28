import test from "node:test";
import assert from "node:assert/strict";
import { MapState } from "../src/Core/MapState.js";
import { GameStateSnapshot } from "../src/Core/types.js";

/**
 * Builds a minimal two-territory GameStateSnapshot for controlled unit tests.
 * "src" is owned by blue, "tgt" by red. They are adjacent.
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
});

test("attack validation rejects non-adjacent targets", () => {
  const map = new MapState();

  const result = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: {
        sourceTerritoryId: "north-west",
        targetTerritoryId: "east",
        troops: 3,
      },
    },
  ]);

  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].rejection.reason, "NOT_ADJACENT");
});

test("attack validation enforces at least one troop remains", () => {
  const map = new MapState();

  const snapshot = map.getSnapshot();
  const sourceTroops = snapshot.territories["south-west"].troops;

  const result = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: {
        sourceTerritoryId: "south-west",
        targetTerritoryId: "center",
        troops: sourceTroops,
      },
    },
  ]);

  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].rejection.reason, "INSUFFICIENT_TROOPS");
});

test("valid attack creates an ActiveConflict without immediately changing ownership", () => {
  const map = new MapState();

  const result = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: {
        sourceTerritoryId: "west",
        targetTerritoryId: "center",
        troops: 3,
      },
    },
  ]);

  assert.equal(result.rejections.length, 0);
  assert.equal(result.snapshot.territories["center"].ownerId, "red");
  assert.equal(result.snapshot.activeConflicts.length, 1);
  assert.equal(result.snapshot.activeConflicts[0].targetTerritoryId, "center");
  assert.equal(result.snapshot.activeConflicts[0].attackerTeamId, "blue");
});

test("conflict progress retreats when defender has troop advantage", () => {
  const map = new MapState();
  // 3 attackers vs 16 defenders: defenders have a clear advantage.
  const result = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "west", targetTerritoryId: "center", troops: 3 },
    },
  ]);

  const conflict = result.snapshot.activeConflicts.find((c) => c.targetTerritoryId === "center");
  assert.ok(conflict, "conflict should still exist after first tick");
  // Initial progress is 0.10; one tick with defender advantage retreats it to 0.05.
  assert.ok(conflict.progress < 0.10, "progress should have retreated since defenders outnumber attackers");
});

test("conflict progress advances when attacker has troop advantage", () => {
  // 10 attackers vs 5 defenders: attacker advantage after the first tick.
  const map = new MapState(buildTwoTerritoryState(25, 5));
  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 10 },
    },
  ]);

  const snap1 = map.getSnapshot();
  const c1 = snap1.activeConflicts[0];
  assert.ok(c1, "conflict should exist after tick 1");
  assert.ok(c1.progress > 0.10, "progress should have advanced since attackers outnumber defenders");

  // One more tick with no new orders should advance further.
  map.processTick([]);
  const snap2 = map.getSnapshot();
  const c2 = snap2.activeConflicts[0];
  assert.ok(c2, "conflict should still exist after tick 2");
  assert.ok(c2.progress > c1.progress, "progress should continue advancing");
});

test("capture resolves when defenders are eliminated", () => {
  // 20 attackers vs 2 defenders — overwhelming advantage; capture in 2 ticks.
  const map = new MapState(buildTwoTerritoryState(25, 2));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 20 },
    },
  ]);
  // After tick 1: attrition (20→19, 2→1), progress advances, no capture yet.
  assert.equal(map.getSnapshot().territories["tgt"].ownerId, "red");
  assert.equal(map.getSnapshot().activeConflicts.length, 1);

  map.processTick([]);
  // After tick 2: defenders reach 0, capture triggers.
  const final = map.getSnapshot();
  assert.equal(final.territories["tgt"].ownerId, "blue");
  assert.equal(final.activeConflicts.length, 0);
});

test("conflict is repelled when all attackers are eliminated", () => {
  // 2 attackers vs 20 defenders — hopeless attack, repelled within 2 ticks.
  const map = new MapState(buildTwoTerritoryState(25, 20));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 2 },
    },
  ]);
  assert.equal(map.getSnapshot().territories["tgt"].ownerId, "red");

  map.processTick([]);
  // After tick 2: attackers reach 0 or progress reaches 0, repel triggers.
  const final = map.getSnapshot();
  assert.equal(final.territories["tgt"].ownerId, "red");
  assert.equal(final.activeConflicts.length, 0);
});

test("reinforcing an existing conflict adds to attackingTroops and can tip the balance", () => {
  // src=30, tgt=5 — equal fight at 5v5, reinforcement tips it toward attacker.
  const map = new MapState(buildTwoTerritoryState(30, 5));

  // Tick 1: send 5 troops; after attrition both sides are at 4 (equal → no progress change).
  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 5 },
    },
  ]);
  const afterFirst = map.getSnapshot();
  assert.equal(afterFirst.activeConflicts.length, 1);
  const troopsBeforeReinforce = afterFirst.activeConflicts[0].attackingTroops;
  const progressBeforeReinforce = afterFirst.activeConflicts[0].progress;

  // Tick 2: reinforce with 5 more troops from same source.
  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 5 },
    },
  ]);
  const afterSecond = map.getSnapshot();
  const conflict = afterSecond.activeConflicts[0];
  // Conflict survives and reinforcement tips the balance.
  assert.ok(conflict, "conflict should persist after reinforcement");
  // Reinforcement offset attrition, so attacking troops exceed pre-reinforce level.
  assert.ok(
    conflict.attackingTroops > troopsBeforeReinforce,
    "attacking troops should exceed pre-reinforce count after reinforcement",
  );
  // Attackers now outnumber defenders — progress should advance.
  assert.ok(
    conflict.progress > progressBeforeReinforce,
    "progress should advance after reinforcement tips the troop balance",
  );
});
