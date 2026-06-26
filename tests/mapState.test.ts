import test from "node:test";
import assert from "node:assert/strict";
import { MapState, createInitialState } from "../src/Core/MapState.js";
import { Faction, UnitType } from "../src/Core/types.js";

test("tick distributes 10 credits per owned province", () => {
  const map = new MapState(createInitialState());
  const before = map.getSnapshot();

  map.tick();

  const after = map.getSnapshot();
  assert.equal(after.players.usa.credits, before.players.usa.credits + 20);
  assert.equal(after.players.china.credits, before.players.china.credits + 20);
  assert.equal(after.players.gla.credits, before.players.gla.credits + 10);
});

test("purchase spends credits and stores units in owned province", () => {
  const map = new MapState(createInitialState());
  map.purchase("usa", "alpha", UnitType.Infantry, 2);
  const snapshot = map.getSnapshot();

  assert.equal(snapshot.players.usa.credits, 120);
  assert.equal(snapshot.provinces.alpha.units.infantry, 5);
});

test("gla can tunnel between owned provinces", () => {
  const initial = createInitialState();
  initial.provinces.delta.ownerId = "gla";
  initial.provinces.delta.units = { infantry: 0, tank: 0 };
  const map = new MapState(initial);

  map.move("gla", "echo", "delta", UnitType.Infantry, 2);
  const snapshot = map.getSnapshot();

  assert.equal(snapshot.provinces.echo.units.infantry, 2);
  assert.equal(snapshot.provinces.delta.units.infantry, 2);
});

test("winning a battle grants general level and mine charge", () => {
  const initial = createInitialState();
  initial.players.usa.faction = Faction.China;
  initial.provinces.charlie.units = { infantry: 1, tank: 0 };
  const map = new MapState(initial);

  map.move("usa", "alpha", "charlie", UnitType.Tank, 1);
  const snapshot = map.getSnapshot();

  assert.equal(snapshot.players.usa.generalLevel, 1);
  assert.equal(snapshot.players.usa.mineCharges, 1);
  assert.equal(snapshot.provinces.charlie.ownerId, "usa");
});

test("mine placement requires an earned charge", () => {
  const map = new MapState(createInitialState());

  assert.throws(() => map.placeMine("usa", "alpha"));
});
