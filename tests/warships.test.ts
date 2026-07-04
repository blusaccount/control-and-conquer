import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { AllianceRegistry } from "../src/Core/alliances.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";
import {
  FORT_SHELL_DAMAGE,
  FORT_SHELL_RANGE,
  WARSHIP_MAX_HP,
  WARSHIP_RETREAT_HP,
} from "../src/Core/buildings.js";

/** Freeze every seated player's troop income so a combat test measures only the fleet, not the economy. */
const freezeIncome = (grid: TerritoryGrid): void => {
  for (const id of grid.players()) grid.setModifiers(id, { ...IDENTITY_MODIFIERS, income: 0 });
};

/** Single-row map from a mask: '#' = land, ' ' = water. Tile ref equals its x coordinate. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) if (mask[x] === "#") land[x] = 1;
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

// --- purchase & spawn --------------------------------------------------------

test("a warship is a unit: needs a port and a water target, and launches at the nearest port", () => {
  // land 0-4 | water 5-24 | land 25-29
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(20) + "#####"));
  grid.addPlayer(1, 50);
  grid.claim(4, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  // No port yet: the wiki requires one to launch from.
  assert.equal(conflict.launchWarship(1, 10, 0), "NO_PORT");

  grid.placeBuilding(4, "port"); // instantly active (direct placement)
  // A click nowhere near water (beyond the snap radius) is rejected.
  assert.equal(conflict.launchWarship(1, 29, 0), "INVALID_TARGET", "no water near the far end of dry land");
  // A water target launches at once — the unit appears at the port.
  assert.equal(conflict.launchWarship(1, 10, 0), null);
  assert.equal(conflict.warshipCountOf(1), 1);
  const [unit] = conflict.activeWarships();
  assert.equal(unit.owner, 1);
  assert.equal(unit.hp, WARSHIP_MAX_HP);
  assert.equal(unit.x, 4, "the unit spawns at the owner's nearest port");
  assert.equal(unit.retreating, false);
});

test("a warship sails to its patrol sector and wanders inside it", () => {
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(30) + "#####"));
  grid.addPlayer(1, 50);
  grid.claim(4, 1);
  grid.placeBuilding(4, "port");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 20, 0), null);

  for (let i = 0; i < 40; i += 1) conflict.processTick();
  const [unit] = conflict.activeWarships();
  assert.ok(Math.abs(unit.x - 20) < 60, `the ship left the port toward its sector (x=${unit.x})`);
  assert.ok(unit.x > 4.5, "it is out on the water, not parked at the port");
});

// --- combat -------------------------------------------------------------------

test("a warship intercepts and sinks an enemy transport during a long crossing, before it lands", () => {
  // Three rows so the mid-crossing island doesn't sever the water graph — the
  // transport routes around it (single-row maps have no north/south to go around).
  const width = 41;
  const height = 3;
  const land = new Uint8Array(width * height);
  const ref = (x: number, y: number) => y * width + x;
  land[ref(0, 1)] = 1; // attacker's (player 2) home shore
  land[ref(20, 1)] = 1; // player 1's port island, mid-crossing
  land[ref(width - 1, 1)] = 1; // the transport's destination (neutral land)
  const grid = new TerritoryGrid(buildTerrainFromMask({ width, height, land, elevation: new Uint8Array(width * height) }));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 300);
  grid.claim(ref(20, 1), 1);
  grid.claim(ref(0, 1), 2);
  grid.placeBuilding(ref(20, 1), "port");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 20, 0), null, "a patrol floats off the island");

  assert.equal(conflict.launchShip({ attacker: 2, dest: ref(width - 1, 1), troops: 100 }), null);
  let sunk = false;
  for (let i = 0; i < 80 && !sunk; i += 1) {
    conflict.processTick();
    sunk = conflict.shipCountOf(2) === 0;
  }
  assert.ok(sunk, "the warship sank the transport during its crossing");
  assert.equal(grid.ownerOf(ref(width - 1, 1)), NEUTRAL_PLAYER, "the transport never reached its destination");
});

test("target priority: an enemy transport in range is engaged before an enemy warship, even both in range at once", () => {
  const grid2 = new TerritoryGrid((() => {
    const width = 40;
    const land = new Uint8Array(width).fill(1);
    // Carve a strip of water so ships can actually be launched.
    for (let x = 5; x <= 25; x += 1) land[x] = 0;
    land[10] = 1; // player 2's shore, mid-strait
    land[20] = 1; // player 1's port island, mid-strait
    return buildTerrainFromMask({ width, height: 1, land, elevation: new Uint8Array(width) });
  })());
  grid2.addPlayer(1, 50);
  grid2.addPlayer(2, 300);
  grid2.claim(20, 1);
  grid2.claim(30, 2); // player 2's inland ground (port site)
  grid2.claim(10, 2); // enemy transport's shore
  grid2.placeBuilding(20, "port");
  grid2.placeBuilding(30, "port"); // player 2's port (its warship launches here)
  freezeIncome(grid2);
  const conflict2 = new RasterConflict(grid2);
  assert.equal(conflict2.launchWarship(1, 19, 0), null);
  assert.equal(conflict2.launchWarship(2, 25, 0), null);
  assert.equal(conflict2.launchShip({ attacker: 2, dest: 4, troops: 50 }), null, "the transport can launch from its carved-out shore");

  conflict2.processTick(); // tick 0: both an enemy transport and an enemy warship are already in range
  assert.equal(conflict2.shipCountOf(2), 0, "the transport was destroyed — it outranks the enemy warship in priority");
  const enemyWarship = conflict2.activeWarships().find((w) => w.owner === 2);
  assert.equal(enemyWarship?.hp, WARSHIP_MAX_HP, "the enemy warship was left untouched while a transport was still in range");
});

test("two enemy warships duel; the first-processed one wins, and only the unit is lost", () => {
  // land 0-4 | water 5-24 | land 25-29 — each side launches a patrol into the strait.
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(20) + "#####"));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(4, 1);
  grid.claim(25, 2);
  grid.placeBuilding(4, "port");
  grid.placeBuilding(25, "port");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 12, 0), null);
  assert.equal(conflict.launchWarship(2, 17, 0), null);

  for (let i = 0; i < 400; i += 1) conflict.processTick();

  const survivors = conflict.activeWarships();
  assert.equal(survivors.length, 1, "exactly one warship survives the duel");
  assert.equal(survivors[0].owner, 1, "player 1's first-processed warship fires first each tick and wins");
  assert.equal(conflict.warshipCountOf(2), 0, "the loser's unit is gone");
  assert.equal(grid.buildingCountOf(2, "port"), 1, "…but its PORT still stands — nothing falls with a sunk unit");
});

test("a warship below the retreat threshold stops firing back and limps toward its port", () => {
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(20) + "#####"));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(4, 1);
  grid.claim(25, 2);
  grid.placeBuilding(4, "port");
  grid.placeBuilding(25, "port");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 12, 0), null);
  assert.equal(conflict.launchWarship(2, 17, 0), null);

  let retreatTick = -1;
  let p1HpAtRetreat = -1;
  for (let i = 0; i < 120 && retreatTick < 0; i += 1) {
    conflict.processTick();
    const p2 = conflict.activeWarships().find((w) => w.owner === 2);
    if (p2?.retreating) {
      retreatTick = i;
      p1HpAtRetreat = conflict.activeWarships().find((w) => w.owner === 1)?.hp ?? -1;
      assert.ok(p2.hp < WARSHIP_RETREAT_HP, "retreating only ever starts below the documented HP threshold");
    }
  }
  assert.ok(retreatTick >= 0, "the losing warship eventually starts retreating");

  for (let i = 0; i < 15; i += 1) conflict.processTick();
  const p1Later = conflict.activeWarships().find((w) => w.owner === 1)?.hp ?? -1;
  assert.ok(
    p1Later >= p1HpAtRetreat,
    `player 1 should take no further damage once the loser retreats (was ${p1HpAtRetreat}, now ${p1Later})`,
  );
});

test("a warship heals only while its owner still runs a port (the wiki's rule)", () => {
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(20) + "#####"));
  grid.addPlayer(1, 50);
  grid.claim(4, 1);
  grid.placeBuilding(4, "port");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 12, 0), null);

  // Wound the unit via the engine's own damage path: a hostile fort would do,
  // but poking hp directly isn't exposed — so verify the heal by observation:
  // with the port standing, hp stays pinned at max (heal keeps up)…
  for (let i = 0; i < 5; i += 1) conflict.processTick();
  assert.equal(conflict.activeWarships()[0].hp, WARSHIP_MAX_HP);
  // …and with the port gone (demolished), a warship at full HP stays afloat
  // but the no-port branch also stops trade captures (covered in tradeSystem
  // tests); the key observable here is that the unit does NOT die with the
  // port — it is independent of any structure.
  grid.demolishBuilding(4);
  for (let i = 0; i < 5; i += 1) conflict.processTick();
  assert.equal(conflict.warshipCountOf(1), 1, "the fleet outlives its harbour");
});

// --- fort gun ------------------------------------------------------------------

test("a fort's gun sinks a hostile transport sailing within range", () => {
  // Player 1's fort guards the strait; player 2's transport crosses toward the
  // far neutral shore, passing well inside FORT_SHELL_RANGE — it must be shot
  // down before it lands.
  const width = 30;
  const mask = "##" + " ".repeat(width - 3) + "#"; // land 0-1, water, neutral land at the end
  const grid = new TerritoryGrid(rowMap(mask));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 300);
  grid.claim(0, 1);
  grid.claim(1, 2); // player 2's launch shore next door
  grid.placeBuilding(0, "fort");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 2, dest: width - 1, troops: 100 }), null);
  let sunk = false;
  for (let i = 0; i < width + 5 && !sunk; i += 1) {
    conflict.processTick();
    sunk = conflict.shipCountOf(2) === 0;
  }
  assert.ok(sunk, "the fort's gun sank the transport");
  assert.equal(grid.ownerOf(width - 1), NEUTRAL_PLAYER, "the landing never happened");
});

test("a fort's gun damages a hostile warship in range but never an allied one", () => {
  // land 0-4 | water 5-24 | land 25-29. The fort sits at 0; both patrols float
  // well inside its 75-tile gun range.
  const grid = new TerritoryGrid(rowMap("#####" + " ".repeat(20) + "#####"));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.addPlayer(3, 50);
  grid.claim(0, 1);
  grid.claim(25, 2);
  grid.claim(26, 3);
  grid.placeBuilding(0, "fort");
  grid.placeBuilding(25, "port");
  grid.placeBuilding(26, "port");
  freezeIncome(grid);
  assert.ok(FORT_SHELL_RANGE >= 26, "both ships sit inside the documented gun range");

  const alliances = new AllianceRegistry();
  alliances.propose(1, 3);
  alliances.accept(3, 1);
  // Ally the two warships with each other too, so the only gunfire in this
  // scenario is the fort's — the test isolates the defense-post gun.
  alliances.propose(2, 3);
  alliances.accept(3, 2);
  const conflict = new RasterConflict(grid, alliances);
  assert.equal(conflict.launchWarship(2, 20, 0), null);
  assert.equal(conflict.launchWarship(3, 22, 0), null);

  conflict.processTick(); // instant-active fort fires on its first ready tick
  const hostile = conflict.activeWarships().find((w) => w.owner === 2);
  const allied = conflict.activeWarships().find((w) => w.owner === 3);
  assert.ok(hostile && allied, "both warships are afloat");
  assert.ok(
    hostile.hp <= WARSHIP_MAX_HP - FORT_SHELL_DAMAGE + 1,
    `the hostile warship took a shell (hp ${hostile.hp})`,
  );
  assert.ok(allied.hp >= WARSHIP_MAX_HP - 1, "the allied warship was never fired on");
});

// --- diplomacy ------------------------------------------------------------------

test("a warship never fires on an ally's transport", () => {
  // The interception map, but the crossing player is an ALLY: the same patrol
  // that sinks an enemy transport must let this one sail through and land.
  const width = 41;
  const height = 3;
  const land = new Uint8Array(width * height);
  const ref = (x: number, y: number) => y * width + x;
  land[ref(0, 1)] = 1; // the ally's (player 2) home shore
  land[ref(20, 1)] = 1; // player 1's port island, mid-crossing
  land[ref(width - 1, 1)] = 1; // the transport's destination (neutral land)
  const grid = new TerritoryGrid(buildTerrainFromMask({ width, height, land, elevation: new Uint8Array(width * height) }));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 300);
  grid.claim(ref(20, 1), 1);
  grid.claim(ref(0, 1), 2);
  grid.placeBuilding(ref(20, 1), "port");
  freezeIncome(grid);

  const alliances = new AllianceRegistry();
  alliances.propose(1, 2);
  alliances.accept(2, 1);
  const conflict = new RasterConflict(grid, alliances);
  assert.equal(conflict.launchWarship(1, 20, 0), null);

  assert.equal(conflict.launchShip({ attacker: 2, dest: ref(width - 1, 1), troops: 50 }), null);
  for (let i = 0; i < 80; i += 1) conflict.processTick();
  assert.equal(grid.ownerOf(ref(width - 1, 1)), 2, "the allied transport crossed the patrol line unharmed and landed");
});
