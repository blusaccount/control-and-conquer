import assert from "node:assert/strict";
import { test } from "node:test";
import { DIGIT_ACTIONS, digitAction, digitSlotFromCode } from "../src/Client/hotkeys.js";
import { BUILDING_TYPES } from "../src/Core/buildings.js";
import { NUKE_KINDS } from "../src/Core/nukes.js";

test("the digit row matches OpenFront's exact key→action mapping", () => {
  // 1 City · 2 Factory · 3 Port · 4 Defense Post · 5 Missile Silo · 6 SAM ·
  // 7 Warship · 8 Atom · 9 Hydrogen · 0 MIRV (getDefaultKeybinds).
  assert.deepEqual(digitAction("Digit1"), { build: "city" });
  assert.deepEqual(digitAction("Digit2"), { build: "factory" });
  assert.deepEqual(digitAction("Digit3"), { build: "port" });
  assert.deepEqual(digitAction("Digit4"), { build: "fort" }); // OpenFront's Defense Post
  assert.deepEqual(digitAction("Digit5"), { build: "silo" }); // Missile Silo
  assert.deepEqual(digitAction("Digit6"), { build: "sam" });
  assert.deepEqual(digitAction("Digit7"), { build: "warship" });
  assert.deepEqual(digitAction("Digit8"), { nuke: "atom" });
  assert.deepEqual(digitAction("Digit9"), { nuke: "hydrogen" });
  assert.deepEqual(digitAction("Digit0"), { nuke: "mirv" });
});

test("the numpad is an alias for the digit row", () => {
  assert.deepEqual(digitAction("Numpad1"), { build: "city" });
  assert.deepEqual(digitAction("Numpad0"), { nuke: "mirv" });
  assert.equal(digitSlotFromCode("Numpad5"), 4);
});

test("non-digit codes resolve to no action", () => {
  for (const code of ["KeyT", "KeyB", "Space", "Escape", "ArrowUp", "Minus"]) {
    assert.equal(digitAction(code), null, `${code} is not a digit key`);
    assert.equal(digitSlotFromCode(code), -1);
  }
});

test("every digit action names a real building or nuke type", () => {
  assert.equal(DIGIT_ACTIONS.length, 10, "one action per digit-row key");
  for (const action of DIGIT_ACTIONS) {
    if ("build" in action) assert.ok(BUILDING_TYPES.includes(action.build), `${action.build} is a real building`);
    else assert.ok(NUKE_KINDS.includes(action.nuke), `${action.nuke} is a real nuke`);
  }
  // All three nukes and seven distinct buildings are reachable from the row.
  const builds = DIGIT_ACTIONS.filter((a): a is { build: (typeof BUILDING_TYPES)[number] } => "build" in a);
  const nukes = DIGIT_ACTIONS.filter((a): a is { nuke: (typeof NUKE_KINDS)[number] } => "nuke" in a);
  assert.equal(builds.length, 7);
  assert.equal(new Set(nukes.map((n) => n.nuke)).size, 3);
});
