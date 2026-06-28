import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../src/Server/validateCommand.js";

test("validateCommand accepts a well-formed CLIENT_RASTER_EXPAND", () => {
  const result = validateCommand({
    type: "CLIENT_RASTER_EXPAND",
    payload: { targetX: 5, targetY: 7, percent: 50 },
  });
  assert.equal(result.type, "CLIENT_RASTER_EXPAND");
  if (result.type === "CLIENT_RASTER_EXPAND") {
    assert.deepEqual(result.payload, { targetX: 5, targetY: 7, percent: 50 });
  }
});

test("validateCommand rejects raster expand with non-integer percent", () => {
  assert.throws(() => validateCommand({
    type: "CLIENT_RASTER_EXPAND",
    payload: { targetX: 5, targetY: 7, percent: 50.5 },
  }), /percent/);
});

test("validateCommand rejects raster expand with negative tile", () => {
  assert.throws(() => validateCommand({
    type: "CLIENT_RASTER_EXPAND",
    payload: { targetX: -1, targetY: 7, percent: 50 },
  }), /targetX/);
});

test("validateCommand rejects unknown message types", () => {
  assert.throws(() => validateCommand({ type: "GIBBERISH", payload: {} }), /Unknown message type/);
});
