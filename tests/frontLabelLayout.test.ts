import test from "node:test";
import assert from "node:assert/strict";
import { layoutFrontLabels, type FrontLabelInput } from "../src/Client/frontLabelLayout.js";

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  Math.abs(a.x - b.x) * 2 < a.width + b.width && Math.abs(a.y - b.y) * 2 < a.height + b.height;

test("a single label keeps its original position", () => {
  const [placed] = layoutFrontLabels([{ id: 1, x: 100, y: 100, width: 40, height: 20, priority: 5 }]);
  assert.equal(placed.x, 100);
  assert.equal(placed.y, 100);
});

test("two non-overlapping labels are left untouched", () => {
  const inputs: FrontLabelInput[] = [
    { id: 1, x: 0, y: 0, width: 40, height: 20, priority: 5 },
    { id: 2, x: 500, y: 500, width: 40, height: 20, priority: 5 },
  ];
  const placed = layoutFrontLabels(inputs);
  assert.deepEqual(
    placed.map((p) => [p.x, p.y]),
    [[0, 0], [500, 500]],
  );
});

test("two coincident labels are pushed apart so neither pill overlaps", () => {
  const inputs: FrontLabelInput[] = [
    { id: 1, x: 100, y: 100, width: 40, height: 20, priority: 10 },
    { id: 2, x: 101, y: 100, width: 40, height: 20, priority: 3 },
  ];
  const placed = layoutFrontLabels(inputs);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const a = { ...byId.get(1)!, width: 40, height: 20 };
  const b = { ...byId.get(2)!, width: 40, height: 20 };
  assert.ok(!overlaps(a, b), "the two labels no longer overlap");
  // The higher-priority (bigger battle) label keeps its exact spot.
  assert.equal(a.x, 100);
  assert.equal(a.y, 100);
});

test("the higher-priority label wins its spot when several fronts collide", () => {
  const inputs: FrontLabelInput[] = [
    { id: 1, x: 200, y: 200, width: 30, height: 20, priority: 1 },
    { id: 2, x: 200, y: 200, width: 30, height: 20, priority: 50 },
    { id: 3, x: 200, y: 200, width: 30, height: 20, priority: 25 },
  ];
  const placed = layoutFrontLabels(inputs);
  const byId = new Map(placed.map((p) => [p.id, p]));
  assert.deepEqual([byId.get(2)!.x, byId.get(2)!.y], [200, 200], "the largest battle keeps the true anchor");

  // No two placements overlap.
  const rects = placed.map((p) => ({ ...p, width: 30, height: 20 }));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      assert.ok(!overlaps(rects[i], rects[j]), `labels ${rects[i].id} and ${rects[j].id} still overlap`);
    }
  }
});

test("output preserves the input order and every id round-trips", () => {
  const inputs: FrontLabelInput[] = [
    { id: 7, x: 10, y: 10, width: 10, height: 10, priority: 1 },
    { id: 3, x: 20, y: 20, width: 10, height: 10, priority: 2 },
    { id: 9, x: 30, y: 30, width: 10, height: 10, priority: 3 },
  ];
  const placed = layoutFrontLabels(inputs);
  assert.deepEqual(placed.map((p) => p.id), [7, 3, 9]);
});
