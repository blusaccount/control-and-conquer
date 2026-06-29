import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_PERK_IDS,
  IDENTITY_MODIFIERS,
  PERK_OFFER_SIZE,
  applyPerk,
  isPerkId,
  modifiersForPerks,
  offerPerks,
} from "../src/Core/perks.js";

test("each perk scales exactly the modifier it should", () => {
  assert.equal(applyPerk(IDENTITY_MODIFIERS, "swift-attacker").expansionSpeed, 1.2);
  assert.equal(applyPerk(IDENTITY_MODIFIERS, "fortress-wall").defense, 1.5);
  const sea = applyPerk(IDENTITY_MODIFIERS, "sea-god");
  assert.equal(sea.seaRange, 2);
  assert.equal(sea.seaSpeed, 2);
  assert.equal(applyPerk(IDENTITY_MODIFIERS, "growth-driver").income, 1.3);
});

test("modifiersForPerks folds and stacks perks multiplicatively", () => {
  const mods = modifiersForPerks(["growth-driver", "growth-driver", "swift-attacker"]);
  assert.ok(Math.abs(mods.income - 1.69) < 1e-9, "two growth perks stack to 1.3^2");
  assert.equal(mods.expansionSpeed, 1.2);
  assert.equal(mods.defense, 1); // untouched modifiers stay at identity
});

test("offerPerks is deterministic, sized, and distinct", () => {
  for (let round = 0; round < 8; round += 1) {
    const options = offerPerks(round);
    assert.equal(options.length, PERK_OFFER_SIZE);
    assert.equal(new Set(options).size, PERK_OFFER_SIZE, "options must be distinct");
    for (const id of options) assert.ok(isPerkId(id));
    assert.deepEqual(offerPerks(round), options, "same round yields the same offer");
  }
  // The window rotates between rounds.
  assert.notDeepEqual(offerPerks(0), offerPerks(1));
});

test("isPerkId rejects unknown values", () => {
  assert.ok(ALL_PERK_IDS.every(isPerkId));
  assert.ok(!isPerkId("nope"));
  assert.ok(!isPerkId(42));
  assert.ok(!isPerkId(null));
});
