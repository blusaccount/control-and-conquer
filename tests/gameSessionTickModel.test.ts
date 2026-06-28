import test from "node:test";
import assert from "node:assert/strict";
import { GameSession } from "../src/Server/GameSession.js";
import { ServerMessage } from "../src/Core/types.js";

const latestSnapshot = (messages: ServerMessage[]) => {
  const snapshots = messages.filter((message): message is Extract<ServerMessage, { type: "SERVER_STATE_SNAPSHOT" }> =>
    message.type === "SERVER_STATE_SNAPSHOT",
  );

  return snapshots[snapshots.length - 1].payload;
};

test("queued attacks process deterministically by tick", () => {
  const runScenario = () => {
    const session = new GameSession();
    const c1Messages: ServerMessage[] = [];
    const c2Messages: ServerMessage[] = [];

    session.subscribe("c1", (message) => c1Messages.push(message));
    session.subscribe("c2", (message) => c2Messages.push(message));

    session.queueAttack("c1", {
      sourceTerritoryId: "west",
      targetTerritoryId: "center",
      troops: 4,
    });

    session.queueAttack("c2", {
      sourceTerritoryId: "center",
      targetTerritoryId: "west",
      troops: 5,
    });

    session.tick();

    return {
      c1: latestSnapshot(c1Messages),
      c2: latestSnapshot(c2Messages),
    };
  };

  const first = runScenario();
  const second = runScenario();

  assert.deepEqual(first.c1, second.c1);
  assert.deepEqual(first.c2, second.c2);
  assert.equal(first.c1.tick, 1);
});

test("invalid actions are rejected for originating client", () => {
  const session = new GameSession();
  const c1Messages: ServerMessage[] = [];
  const c2Messages: ServerMessage[] = [];

  session.subscribe("c1", (message) => c1Messages.push(message));
  session.subscribe("c2", (message) => c2Messages.push(message));

  session.queueAttack("c1", {
    sourceTerritoryId: "north-east",
    targetTerritoryId: "north-center",
    troops: 2,
  });

  session.tick();

  const c1Rejections = c1Messages.filter((message) => message.type === "SERVER_ACTION_REJECTED");
  const c2Rejections = c2Messages.filter((message) => message.type === "SERVER_ACTION_REJECTED");

  assert.equal(c1Rejections.length, 1);
  assert.equal(c2Rejections.length, 0);
});
