import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../src/Server/validateCommand.js";

// ── valid commands ────────────────────────────────────────────────────────────

test("validateCommand accepts a valid purchase command", () => {
  const cmd = validateCommand({
    type: "purchase",
    playerId: "usa",
    provinceId: "alpha",
    unitType: "infantry",
    count: 3,
  });
  assert.equal(cmd.type, "purchase");
});

test("validateCommand accepts a valid move command", () => {
  const cmd = validateCommand({
    type: "move",
    playerId: "china",
    fromProvinceId: "charlie",
    toProvinceId: "delta",
    unitType: "tank",
    count: 1,
  });
  assert.equal(cmd.type, "move");
});

test("validateCommand accepts a valid placeMine command", () => {
  const cmd = validateCommand({
    type: "placeMine",
    playerId: "gla",
    provinceId: "echo",
  });
  assert.equal(cmd.type, "placeMine");
});

// ── non-object inputs ─────────────────────────────────────────────────────────

test("validateCommand rejects null", () => {
  assert.throws(() => validateCommand(null), /JSON object/);
});

test("validateCommand rejects a plain string", () => {
  assert.throws(() => validateCommand("purchase"), /JSON object/);
});

// ── unknown type ──────────────────────────────────────────────────────────────

test("validateCommand rejects an unknown command type", () => {
  assert.throws(() => validateCommand({ type: "nuke" }), /Unknown command type/);
});

test("validateCommand rejects a command with no type field", () => {
  assert.throws(() => validateCommand({ playerId: "usa" }), /Unknown command type/);
});

// ── purchase validation ───────────────────────────────────────────────────────

test("validateCommand rejects purchase with missing playerId", () => {
  assert.throws(
    () => validateCommand({ type: "purchase", provinceId: "alpha", unitType: "infantry", count: 1 }),
    /playerId/,
  );
});

test("validateCommand rejects purchase with invalid unitType", () => {
  assert.throws(
    () =>
      validateCommand({ type: "purchase", playerId: "usa", provinceId: "alpha", unitType: "nuke", count: 1 }),
    /unitType/,
  );
});

test("validateCommand rejects purchase with non-integer count", () => {
  assert.throws(
    () =>
      validateCommand({ type: "purchase", playerId: "usa", provinceId: "alpha", unitType: "infantry", count: 1.5 }),
    /count/,
  );
});

test("validateCommand rejects purchase with zero count", () => {
  assert.throws(
    () =>
      validateCommand({ type: "purchase", playerId: "usa", provinceId: "alpha", unitType: "infantry", count: 0 }),
    /count/,
  );
});

// ── move validation ───────────────────────────────────────────────────────────

test("validateCommand rejects move with missing fromProvinceId", () => {
  assert.throws(
    () =>
      validateCommand({
        type: "move",
        playerId: "usa",
        toProvinceId: "bravo",
        unitType: "infantry",
        count: 1,
      }),
    /fromProvinceId/,
  );
});

test("validateCommand rejects move with negative count", () => {
  assert.throws(
    () =>
      validateCommand({
        type: "move",
        playerId: "usa",
        fromProvinceId: "alpha",
        toProvinceId: "bravo",
        unitType: "infantry",
        count: -2,
      }),
    /count/,
  );
});

// ── placeMine validation ──────────────────────────────────────────────────────

test("validateCommand rejects placeMine with empty provinceId", () => {
  assert.throws(
    () => validateCommand({ type: "placeMine", playerId: "gla", provinceId: "" }),
    /provinceId/,
  );
});
