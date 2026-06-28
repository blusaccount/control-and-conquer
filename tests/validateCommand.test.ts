import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../src/Server/validateCommand.js";

test("validateCommand accepts a valid CLIENT_ATTACK_REQUEST", () => {
  const cmd = validateCommand({
    type: "CLIENT_ATTACK_REQUEST",
    payload: {
      sourceTerritoryId: "west",
      targetTerritoryId: "center",
      troops: 3,
    },
  });

  assert.equal(cmd.type, "CLIENT_ATTACK_REQUEST");
  assert.equal(cmd.payload.troops, 3);
});

test("validateCommand rejects unknown message type", () => {
  assert.throws(() => validateCommand({ type: "purchase" }), /Unknown message type/);
});

test("validateCommand rejects non-object payload", () => {
  assert.throws(
    () =>
      validateCommand({
        type: "CLIENT_ATTACK_REQUEST",
        payload: "x",
      }),
    /payload must be an object/,
  );
});

test("validateCommand rejects empty territory ids", () => {
  assert.throws(
    () =>
      validateCommand({
        type: "CLIENT_ATTACK_REQUEST",
        payload: {
          sourceTerritoryId: "",
          targetTerritoryId: "center",
          troops: 1,
        },
      }),
    /sourceTerritoryId/,
  );
});

test("validateCommand rejects invalid troop count", () => {
  assert.throws(
    () =>
      validateCommand({
        type: "CLIENT_ATTACK_REQUEST",
        payload: {
          sourceTerritoryId: "west",
          targetTerritoryId: "center",
          troops: 0,
        },
      }),
    /troops/,
  );
});
