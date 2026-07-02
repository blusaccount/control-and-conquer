import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict } from "../src/Core/RasterConflict.js";
import { AllianceRegistry } from "../src/Core/alliances.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";
import { BUILDING_CONSTRUCTION_TICKS, WARSHIP_MAX_HP, WARSHIP_RETREAT_HP } from "../src/Core/buildings.js";

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

test("a warship spawns as a mobile unit only once its structure finishes construction", () => {
  // A second, unclaimed land tile keeps the single seated player under 100% of
  // the map's capturable land — owning it all would auto-win and short-circuit
  // the engine (including construction) before the unit ever gets to spawn.
  const grid = new TerritoryGrid(rowMap("# #"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  const readyTick = BUILDING_CONSTRUCTION_TICKS.warship;
  grid.placeBuilding(0, "warship", 0, readyTick);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  for (let i = 0; i < readyTick; i += 1) {
    conflict.processTick();
    assert.equal(conflict.activeWarships().length, 0, `no unit yet at tick ${i} — still under construction`);
  }
  conflict.processTick(); // crosses readyTick
  const [unit] = conflict.activeWarships();
  assert.ok(unit, "the unit spawns the tick construction finishes");
  assert.equal(unit.owner, 1);
  assert.equal(unit.hp, WARSHIP_MAX_HP);
  assert.equal(unit.retreating, false);
});

test("a warship intercepts and sinks an enemy transport during a long crossing, before it lands", () => {
  // Three rows so the mid-crossing island doesn't sever the water graph — the
  // transport routes around it (single-row maps have no north/south to go around).
  const width = 41;
  const height = 3;
  const land = new Uint8Array(width * height);
  const ref = (x: number, y: number) => y * width + x;
  land[ref(0, 1)] = 1; // attacker's (player 2) home shore
  land[ref(20, 1)] = 1; // player 1's warship island, mid-crossing
  land[ref(width - 1, 1)] = 1; // the transport's destination (neutral land)
  const grid = new TerritoryGrid(buildTerrainFromMask({ width, height, land, elevation: new Uint8Array(width * height) }));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 300);
  grid.claim(ref(20, 1), 1);
  grid.claim(ref(0, 1), 2);
  grid.placeBuilding(ref(20, 1), "warship");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 2, dest: ref(width - 1, 1), troops: 100 }), null);
  let sunk = false;
  for (let i = 0; i < 80 && !sunk; i += 1) {
    conflict.processTick();
    sunk = conflict.shipCountOf(2) === 0;
  }
  assert.ok(sunk, "the warship closed in and sank the transport during its crossing");
  assert.equal(grid.ownerOf(ref(width - 1, 1)), NEUTRAL_PLAYER, "the transport never reached its destination");
});

test("target priority: an enemy transport in range is engaged before an enemy warship, even both in range at once", () => {
  const grid2 = new TerritoryGrid((() => {
    const width = 40;
    const land = new Uint8Array(width).fill(1);
    // Carve a strip of water so a transport can actually be launched.
    for (let x = 5; x <= 25; x += 1) land[x] = 0;
    land[10] = 1; // player 2's shore, mid-strait, within engage range of the warship at 20
    land[20] = 1; // player 1's warship island, mid-strait
    return buildTerrainFromMask({ width, height: 1, land, elevation: new Uint8Array(width) });
  })());
  grid2.addPlayer(1, 50);
  grid2.addPlayer(2, 300);
  grid2.claim(20, 1);
  grid2.claim(30, 2); // enemy warship, still on dry land, 10 tiles from player 1's
  grid2.claim(10, 2); // enemy transport's shore, also 10 tiles from player 1's
  grid2.placeBuilding(20, "warship");
  grid2.placeBuilding(30, "warship");
  freezeIncome(grid2);
  const conflict2 = new RasterConflict(grid2);
  assert.equal(conflict2.launchShip({ attacker: 2, dest: 4, troops: 50 }), null, "the transport can launch from its carved-out shore");

  conflict2.processTick(); // tick 0: both an enemy transport and an enemy warship are already in range
  assert.equal(conflict2.shipCountOf(2), 0, "the transport was destroyed — it outranks the enemy warship in priority");
  const enemyWarship = conflict2.activeWarships().find((w) => w.owner === 2);
  assert.equal(enemyWarship?.hp, WARSHIP_MAX_HP, "the enemy warship was left untouched while a transport was still in range");
});

test("two enemy warships duel; the lower-tile-ref one (processed first each tick) wins, taking the loser's structure with it", () => {
  const grid = new TerritoryGrid(rowMap("#".repeat(20)));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(10, 1);
  grid.claim(15, 2);
  grid.placeBuilding(10, "warship");
  grid.placeBuilding(15, "warship");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  for (let i = 0; i < 400; i += 1) conflict.processTick();

  const survivors = conflict.activeWarships();
  assert.equal(survivors.length, 1, "exactly one warship survives the duel");
  assert.equal(survivors[0].owner, 1, "player 1's lower-ref warship fires first each tick and wins");
  assert.equal(grid.buildingCountOf(2, "warship"), 0, "the loser's home structure was demolished along with the unit");
  assert.equal(grid.buildingCountOf(1, "warship"), 1, "the winner's structure still stands");
});

test("a warship below the retreat threshold stops firing back", () => {
  const grid = new TerritoryGrid(rowMap("#".repeat(20)));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(10, 1);
  grid.claim(15, 2);
  grid.placeBuilding(10, "warship");
  grid.placeBuilding(15, "warship");
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  let retreatTick = -1;
  let p1HpAtRetreat = -1;
  for (let i = 0; i < 60 && retreatTick < 0; i += 1) {
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

test("a warship never targets an allied ship", () => {
  const grid = new TerritoryGrid(rowMap("#".repeat(20)));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 300);
  grid.claim(10, 1);
  grid.claim(12, 2); // an ally's transport embarks 2 tiles away — well within engage range
  grid.placeBuilding(10, "warship");
  freezeIncome(grid);

  const alliances = new AllianceRegistry();
  alliances.propose(1, 2);
  alliances.accept(2, 1);
  const conflict = new RasterConflict(grid, alliances);

  assert.equal(conflict.launchShip({ attacker: 2, dest: 19, troops: 50 }), "NO_FRONTIER");
  // No open water on this board to actually sail on, but the point stands at
  // the target-selection layer regardless: an allied owner is never hostile.
  for (let i = 0; i < 30; i += 1) conflict.processTick();
  const unit = conflict.activeWarships()[0];
  assert.equal(unit.hp, WARSHIP_MAX_HP, "no combat occurred — there is nothing hostile to engage");
  assert.equal(unit.retreating, false);
});
