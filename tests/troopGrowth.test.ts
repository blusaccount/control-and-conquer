import test from "node:test";
import assert from "node:assert/strict";
import { MapState } from "../src/Core/MapState.js";
import { GameStateSnapshot } from "../src/Core/types.js";

/**
 * Tests for the per-tick troop income mechanic. INCOME_PER_TICK = 0.05 means
 * a full integer troop flushes into a territory every 20 ticks.
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

test("non-contested territories grow by exactly one troop every 20 ticks (INCOME_PER_TICK=0.05)", () => {
  const map = new MapState(buildTwoTerritoryState(10, 10));

  // 19 idle ticks should not yet flush a whole troop.
  for (let i = 0; i < 19; i += 1) {
    map.processTick([]);
  }
  const after19 = map.getSnapshot();
  assert.equal(after19.territories["src"].troops, 10, "no whole troop after 19 ticks");
  assert.equal(after19.territories["tgt"].troops, 10, "no whole troop after 19 ticks");

  // The 20th tick flushes one whole troop.
  map.processTick([]);
  const after20 = map.getSnapshot();
  assert.equal(after20.territories["src"].troops, 11, "src grew by 1 after 20 ticks");
  assert.equal(after20.territories["tgt"].troops, 11, "tgt grew by 1 after 20 ticks");
});

test("contested target does not grow while the conflict is active", () => {
  const map = new MapState(buildTwoTerritoryState(100, 5));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 10 },
    },
  ]);

  // Conflict is active from tick 1 onwards. tgt should not receive any growth
  // while contested — its troop count is owned by the conflict's defending
  // troops and synced back each tick.
  for (let i = 0; i < 20; i += 1) {
    const snap = map.getSnapshot();
    const conflict = snap.activeConflicts.find((c) => c.targetTerritoryId === "tgt");
    if (!conflict) break;
    map.processTick([]);
  }

  // The conflict will have resolved (capture) before 20 idle ticks complete,
  // because 10 attackers crush 5 defenders quickly. After capture, tgt is
  // owned by blue with the surviving attacker garrison — not by accumulated
  // growth from the red defender.
  const final = map.getSnapshot();
  assert.equal(final.territories["tgt"].ownerId, "blue", "tgt should have been captured");
});

test("source territory keeps growing during an attack it launched", () => {
  // Source has 100, attacker sends 5 — source is not contested.
  const map = new MapState(buildTwoTerritoryState(100, 100));

  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 5 },
    },
  ]);
  // src now has 95 (after sending 5). Growth in same tick: still fractional, no flush.
  assert.equal(map.getSnapshot().territories["src"].troops, 95);

  // Run 20 more ticks. src is not contested, so it should grow by 1 every 20 ticks.
  for (let i = 0; i < 20; i += 1) {
    map.processTick([]);
  }
  const after = map.getSnapshot();
  assert.equal(after.territories["src"].troops, 96, "src grew by 1 in 20 idle ticks");
});

test("captured territory's growth accumulator is reset on capture", () => {
  const map = new MapState(buildTwoTerritoryState(100, 2));

  // Run 15 idle ticks so tgt accumulates 0.75 growth (not yet flushed).
  for (let i = 0; i < 15; i += 1) {
    map.processTick([]);
  }
  // Now launch overwhelming attack — should capture in 2 ticks.
  map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: { sourceTerritoryId: "src", targetTerritoryId: "tgt", troops: 50 },
    },
  ]);
  map.processTick([]);

  const afterCapture = map.getSnapshot();
  assert.equal(afterCapture.territories["tgt"].ownerId, "blue", "tgt was captured");

  // Now run 19 more idle ticks. With accumulator reset, tgt should NOT yet
  // flush a troop. (If reset failed, it would inherit ~0.75 and flush within 5 ticks.)
  const troopsAtCapture = afterCapture.territories["tgt"].troops;
  for (let i = 0; i < 19; i += 1) {
    map.processTick([]);
  }
  const after19 = map.getSnapshot();
  assert.equal(
    after19.territories["tgt"].troops,
    troopsAtCapture,
    "tgt growth accumulator was correctly reset on capture (no early flush)",
  );
});
