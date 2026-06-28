import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAttackTroops, pointInPolygon } from "../src/Client/geometry.js";
import type { Point } from "../src/Core/types.js";

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

test("pointInPolygon detects a point inside the polygon", () => {
  assert.equal(pointInPolygon(5, 5, SQUARE), true);
});

test("pointInPolygon rejects a point outside the polygon", () => {
  assert.equal(pointInPolygon(20, 5, SQUARE), false);
});

test("computeAttackTroops sends the rounded percentage of the garrison", () => {
  assert.equal(computeAttackTroops(100, 50), 50);
  assert.equal(computeAttackTroops(10, 30), 3);
});

test("computeAttackTroops always leaves at least one troop behind", () => {
  assert.equal(computeAttackTroops(10, 100), 9);
});

test("computeAttackTroops returns 0 when the source cannot spare a troop", () => {
  assert.equal(computeAttackTroops(1, 90), 0);
});

test("computeAttackTroops sends at least one troop for any viable attack", () => {
  assert.equal(computeAttackTroops(5, 10), 1);
});
