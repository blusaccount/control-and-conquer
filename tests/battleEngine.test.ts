import test from "node:test";
import assert from "node:assert/strict";
import { resolveBattle } from "../src/Core/BattleEngine.js";
import { Faction, UnitType } from "../src/Core/types.js";

test("china horde bonus can overpower an equal infantry defense", () => {
  const result = resolveBattle({
    battleId: "battle-1",
    attackerId: "china",
    defenderId: "usa",
    attackerFaction: Faction.China,
    defenderFaction: Faction.USA,
    attackerProvinceId: "charlie",
    defenderProvinceId: "alpha",
    attackerUnits: {
      [UnitType.Infantry]: 5,
      [UnitType.Tank]: 0,
    },
    defenderUnits: {
      [UnitType.Infantry]: 4,
      [UnitType.Tank]: 0,
    },
    defenderHasMine: false,
  });

  assert.equal(result.winnerId, "china");
  assert.equal(result.provinceCaptured, true);
  assert.ok(result.timeline.length > 1);
});

test("defender mine damages the first attacking wave", () => {
  const result = resolveBattle({
    battleId: "battle-2",
    attackerId: "usa",
    defenderId: "gla",
    attackerFaction: Faction.USA,
    defenderFaction: Faction.GLA,
    attackerProvinceId: "alpha",
    defenderProvinceId: "echo",
    attackerUnits: {
      [UnitType.Infantry]: 1,
      [UnitType.Tank]: 0,
    },
    defenderUnits: {
      [UnitType.Infantry]: 1,
      [UnitType.Tank]: 0,
    },
    defenderHasMine: true,
  });

  assert.equal(result.winnerId, "gla");
  assert.match(result.log[0], /mine/i);
});
