import test from "node:test";
import assert from "node:assert/strict";
import { MapState } from "../src/Core/MapState.js";

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

test("valid attack reduces defender troops when not captured", () => {
  const map = new MapState();

  const before = map.getSnapshot();
  const targetBefore = before.territories["center"].troops;

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
  assert.equal(result.snapshot.territories["center"].troops, targetBefore - 3);
});

test("capture switches ownership and moves remaining attackers", () => {
  const map = new MapState();

  const first = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: {
        sourceTerritoryId: "west",
        targetTerritoryId: "center",
        troops: 9,
      },
    },
  ]);

  const second = map.processTick([
    {
      clientId: "c1",
      teamId: "blue",
      order: {
        sourceTerritoryId: "north-center",
        targetTerritoryId: "center",
        troops: 8,
      },
    },
  ]);

  assert.equal(first.snapshot.territories["center"].ownerId, "red");
  assert.equal(second.snapshot.territories["center"].ownerId, "blue");
  assert.equal(second.snapshot.territories["center"].troops, 1);
});
