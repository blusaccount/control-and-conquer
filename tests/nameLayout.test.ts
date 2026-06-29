import test from "node:test";
import assert from "node:assert/strict";
import { computeNameAnchors } from "../src/Client/nameLayout.js";

/** Build a width×height owner raster, painting `pid` over the given tiles. */
const ownerFrom = (
  width: number,
  height: number,
  tiles: ReadonlyArray<readonly [number, number, number]>,
): Uint16Array => {
  const owner = new Uint16Array(width * height);
  for (const [x, y, pid] of tiles) owner[y * width + x] = pid;
  return owner;
};

const rectTiles = (x0: number, y0: number, x1: number, y1: number, pid: number) => {
  const out: Array<[number, number, number]> = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) out.push([x, y, pid]);
  return out;
};

test("a name anchor lands inside the player's mass for a solid block", () => {
  const owner = ownerFrom(16, 16, rectTiles(4, 4, 9, 9, 1));
  const [anchor] = computeNameAnchors(16, 16, owner, [{ playerId: 1, nameLength: 5 }]);
  assert.ok(anchor, "an anchor is produced");
  assert.equal(anchor.playerId, 1);
  assert.ok(anchor.size > 0, "font size is positive");
  // The anchor tile must be owned by the player.
  const tx = Math.floor(anchor.x);
  const ty = Math.floor(anchor.y);
  assert.equal(owner[ty * 16 + tx], 1, "anchor sits on the player's land");
});

test("the anchor avoids a thin tail and sits in the thick mass (concave shape)", () => {
  // An L: a thick 8×8 block (area 64) plus a long thin 1-tile-high tail. The
  // tail's full-width strip has less area than the block, so the largest
  // inscribed rectangle — and thus the name — stays in the block.
  const owner = ownerFrom(40, 16, [
    ...rectTiles(2, 2, 9, 9, 1),
    ...rectTiles(10, 9, 38, 9, 1),
  ]);
  const [anchor] = computeNameAnchors(40, 16, owner, [{ playerId: 1, nameLength: 4 }]);
  assert.ok(anchor);
  assert.ok(anchor.x < 14, `anchor.x ${anchor.x} should be near the block, not the tail`);
  const tx = Math.floor(anchor.x);
  const ty = Math.floor(anchor.y);
  assert.equal(owner[ty * 40 + tx], 1, "anchor sits on the player's land");
});

test("separate players each get their own anchor on their own mass", () => {
  const owner = ownerFrom(32, 16, [
    ...rectTiles(2, 2, 7, 9, 1),
    ...rectTiles(22, 4, 29, 11, 2),
  ]);
  const anchors = computeNameAnchors(32, 16, owner, [
    { playerId: 1, nameLength: 3 },
    { playerId: 2, nameLength: 3 },
  ]);
  assert.equal(anchors.length, 2);
  for (const a of anchors) {
    assert.equal(owner[Math.floor(a.y) * 32 + Math.floor(a.x)], a.playerId);
  }
});

test("players with no tiles and an empty request produce no anchors", () => {
  const owner = ownerFrom(16, 16, rectTiles(4, 4, 9, 9, 1));
  // Player 2 holds nothing.
  const anchors = computeNameAnchors(16, 16, owner, [{ playerId: 2, nameLength: 5 }]);
  assert.equal(anchors.length, 0);
  assert.equal(computeNameAnchors(16, 16, owner, []).length, 0);
});
