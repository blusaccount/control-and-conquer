import test from "node:test";
import assert from "node:assert/strict";
import { GameSession } from "../src/Server/GameSession.js";
import { UnitType } from "../src/Core/types.js";

test("queued inputs are processed on tick and yield deterministic snapshots", () => {
  const runScenario = () => {
    const session = new GameSession();

    session.queueCommand({
      type: "purchase",
      playerId: "usa",
      provinceId: "alpha",
      unitType: UnitType.Infantry,
      count: 1,
    });

    const beforeTick = session.getSnapshot();
    assert.equal(beforeTick.players.usa.credits, 220);
    assert.equal(beforeTick.provinces.alpha.units.infantry, 3);

    session.tick();

    session.queueCommand({
      type: "move",
      playerId: "usa",
      fromProvinceId: "bravo",
      toProvinceId: "alpha",
      unitType: UnitType.Infantry,
      count: 1,
    });
    session.queueCommand({
      type: "purchase",
      playerId: "usa",
      provinceId: "alpha",
      unitType: UnitType.Tank,
      count: 1,
    });

    session.tick();
    session.tick();

    return session.getSnapshot();
  };

  const first = runScenario();
  const second = runScenario();

  assert.deepEqual(first, second);
  assert.equal(first.tick, 3);
  assert.equal(first.provinces.alpha.units.infantry, 5);
  assert.equal(first.provinces.alpha.units.tank, 2);
});
