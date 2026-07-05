import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict, type SeaCrossing } from "../src/Core/RasterConflict.js";
import { MAX_TRANSPORT_SHIPS_PER_PLAYER } from "../src/Core/rasterCombatConfig.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";

/**
 * Freeze every seated player's troop income so a crossing test measures only the
 * landing/refund accounting; the economy is covered in income.test.ts.
 */
const freezeIncome = (grid: TerritoryGrid): void => {
  for (const id of grid.players()) grid.setModifiers(id, { ...IDENTITY_MODIFIERS, income: 0 });
};

/** Single-row map from a mask: '#' = land, ' ' = water. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    if (mask[x] === "#") land[x] = 1;
  }
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

test("findSeaPath takes the shortest water route from the nearest owned coast", () => {
  // owned 0 | water 1 | neutral 2 (dest) | water 3,4 | owned 5.
  // Coast 0 is one water tile away; coast 5 is two — the path must use coast 0.
  const grid = new TerritoryGrid(rowMap("# #  #"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(5, 1);

  const path = grid.findSeaPath(1, 2);
  assert.deepEqual(path, [0, 1, 2], "embarkation→water→dest along the shorter crossing");

  // A landlocked / unreachable target yields null.
  assert.equal(grid.findSeaPath(1, 0), null, "own tile has no sea path");
});

test("a transport ship sails the strait, lands, and captures the far bank", () => {
  // owned 0,1 | water 2,3,4 (3-tile strait) | neutral 5,6.
  const grid = new TerritoryGrid(rowMap("##   ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  // The far bank is unreachable on land but reachable by ship.
  assert.ok(!grid.hasLandBorderWith(1, NEUTRAL_PLAYER), "no land border across the strait");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 50 }), null);
  assert.equal(grid.troopsOf(1), 0, "loaded troops leave the pool immediately");
  assert.equal(conflict.shipCountOf(1), 1, "one ship now at sea");

  // The ship is in flight before it arrives — its position is a water tile.
  conflict.processTick();
  const inFlight = conflict.activeShips();
  assert.equal(inFlight.length, 1);
  assert.ok(grid.map.isWater(inFlight[0].tile), "a sailing ship sits on open water");

  const crossings: SeaCrossing[] = [];
  for (let i = 0; i < 20; i += 1) crossings.push(...conflict.processTick().crossings);

  assert.equal(grid.ownerOf(5), 1, "the ship captured its beachhead");
  assert.equal(conflict.shipCountOf(1), 0, "the ship is consumed on landing");
  const landing = crossings.find((c) => c.to === 5);
  assert.ok(landing, "a landing onto tile 5 should be recorded");
  assert.equal(landing?.attacker, 1);
  assert.ok(grid.map.isWater(landing!.from), "the landing sets out from open water");
});

test("a ship's snapshot carries its remaining route, thinned and ending on the landing tile", () => {
  // owned 0,1 | a long open-water crossing | neutral far bank. The serialized
  // route must always end on the destination, only ever shrink as the ship
  // advances, and stay within the waypoint cap however long the crossing is.
  const water = " ".repeat(80);
  const grid = new TerritoryGrid(rowMap(`##${water}##`));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  const dest = 82;
  assert.equal(conflict.launchShip({ attacker: 1, dest, troops: 50 }), null);

  const first = conflict.activeShips()[0];
  assert.ok(first.route.length > 0, "a fresh ship has a route ahead of it");
  assert.ok(first.route.length <= 32, "long crossings are thinned to the waypoint cap");
  assert.equal(first.route[first.route.length - 1], dest, "the route ends on the landing tile");

  conflict.processTick();
  conflict.processTick();
  const later = conflict.activeShips()[0];
  assert.ok(later.route.length <= first.route.length, "the remaining route never grows");
  assert.equal(later.route[later.route.length - 1], dest, "still ends on the landing tile");
  assert.ok(later.route.every((t) => t > later.tile), "route holds only tiles still ahead of the hull");
});

test("troops left after the beachhead push inland from the landing", () => {
  // owned 0,1 | water 2,3,4 | neutral 5,6,7,8 — a generous lander should keep
  // expanding past its beachhead.
  const grid = new TerritoryGrid(rowMap("##   ####"));
  grid.addPlayer(1, 80);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 80 }), null);
  for (let i = 0; i < 40; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(5), 1, "beachhead taken");
  assert.ok(grid.ownerOf(6) === 1 && grid.ownerOf(7) === 1, "survivors expand inland from the beachhead");
});

test("a landing always conquers its beachhead outright, even a token force (OpenFront)", () => {
  // A one-tile river: OpenFront's TransportShipExecution calls `conquer(dst)`
  // with no toll and no repel roll — the beachhead tile always falls, and the
  // boat load then fights inland as a normal land attack. A 5-troop landing
  // takes the beachhead, then dies overdrawing itself on the next tile.
  const grid = new TerritoryGrid(rowMap("## ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  const tokenForce = 5; // far below the 16-troop plains capture price
  assert.equal(conflict.launchShip({ attacker: 1, dest: 3, troops: tokenForce }), null);
  for (let i = 0; i < 10; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(3), 1, "the beachhead falls regardless of the boat's size");
  assert.equal(grid.troopsOf(1), 45, "the token force is spent inland — nothing returns");
});

test("a landing on a defended shore still takes the beachhead; the fight happens inland", () => {
  // owned 0,1 | water 2 | player-2 shore 3,4. In OpenFront a landing cannot be
  // repelled at the waterline: the beachhead is conquered outright and the
  // troops then push inland via the normal attackLogic — where a one-troop
  // force promptly bleeds out with no refund.
  const grid = new TerritoryGrid(rowMap("## ##"));
  grid.addPlayer(1, 1);
  grid.addPlayer(2, 5);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(3, 2);
  grid.claim(4, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 1, dest: 3, troops: 1 }), null);
  for (let i = 0; i < 10; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(3), 1, "the beachhead falls even on a defended shore");
  assert.equal(grid.troopsOf(1), 0, "the token force dies inland — no refund");
});

test("a ship arriving at a shore that is already ours returns its troops minus the retreat malus", () => {
  // owned 0,1 | water 2,3,4 | far bank 5..10. Two ships sail for the same
  // neutral tile; the first to arrive conquers it, so the second arrives at
  // friendly ground. OpenFront charges `malusForRetreat` (25%) on exactly this
  // arrival — the assault evaporated mid-voyage, and the pull-back costs a
  // quarter. (The far bank is long enough that nobody dominates the map.)
  const grid = new TerritoryGrid(rowMap("##   ######"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 20 }), null);
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 20 }), null);
  assert.equal(grid.troopsOf(1), 10, "both loads leave the pool");
  for (let i = 0; i < 15; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(5), 1, "the first ship conquered the beachhead");
  assert.equal(grid.ownerOf(6), 1, "the first load pushed inland");
  // Pool: 10 held back + 15 back from the second ship (20 minus the 25% malus).
  // The first load spent itself inland (16 for tile 6, the rest overdrawn on
  // tile 7) and returned nothing, per the no-refund death rule.
  assert.equal(grid.troopsOf(1), 25, "10 held back + 15 from the malus arrival");
});

test("a beachhead's owner gaining immunity mid-voyage calls off the landing", () => {
  // owned 0,1 | water 2,3,4 | far bank 5 (neutral at launch),6 (player 2). Player 1
  // ships troops at neutral tile 5; before the ship arrives, immune player 2
  // expands onto 5 by land. The landing must stand down like an ally's shore,
  // not storm a nation that can't currently be attacked.
  const grid = new TerritoryGrid(rowMap("##   ##"));
  grid.addPlayer(1, 50);
  grid.addPlayer(2, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(6, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  conflict.grantImmunity(2, 100);

  // Legal at launch: tile 5 is neutral, so isImmune(NEUTRAL_PLAYER) is false.
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 50 }), null);
  // Player 2 (immune) is still free to expand into neutral land.
  assert.equal(conflict.launchAttack({ attacker: 2, target: NEUTRAL_PLAYER, troops: 30 }), null);

  for (let i = 0; i < 5; i += 1) conflict.processTick();
  assert.equal(grid.ownerOf(5), 2, "player 2 claimed the beachhead by land first");

  for (let i = 0; i < 20; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(5), 2, "the immune owner keeps the tile — the landing was called off");
  assert.equal(conflict.shipCountOf(1), 0, "the ship is still consumed on arrival");
  assert.equal(grid.troopsOf(1), 50, "the troops disembark home in full, not spent attacking");
});

test("a player may have at most three transport ships at sea", () => {
  // owned 0,1 | water 2,3,4 | islet 5 | water 6,7,8 | islet 9. Tile 5 is a lone
  // islet (no land neighbours), so a landing there can't spread inland — keeping
  // the board stable while we exercise the fleet cap.
  const grid = new TerritoryGrid(rowMap("##   #   #"));
  grid.addPlayer(1, 200);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  for (let i = 0; i < MAX_TRANSPORT_SHIPS_PER_PLAYER; i += 1) {
    assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 30 }), null, `ship ${i + 1} launches`);
  }
  assert.equal(conflict.shipCountOf(1), MAX_TRANSPORT_SHIPS_PER_PLAYER);
  // The fourth simultaneous launch is rejected.
  assert.equal(conflict.launchShip({ attacker: 1, dest: 5, troops: 30 }), "TOO_MANY_SHIPS");

  // Once the ships land (taking islet 5), every slot frees up again. Islet 9 is
  // now reachable by sea from the freshly-held coast at 5.
  for (let i = 0; i < 20; i += 1) conflict.processTick();
  assert.equal(grid.ownerOf(5), 1, "the fleet took its beachhead");
  assert.equal(conflict.shipCountOf(1), 0, "ships eventually land and free their slots");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 9, troops: 30 }), null, "a freed slot accepts a new ship");
});

test("a wide but connected sea can be crossed (no distance cap)", () => {
  // 8 open-water tiles — far past the old crossing cap, but one connected body,
  // so a boat sails the whole way (OpenFront's connectivity-based reach).
  const grid = new TerritoryGrid(rowMap("##        ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  const path = grid.findSeaPath(1, 10);
  assert.ok(path, "a route exists across the wide sea");
  assert.equal(path![0], 1, "embarks from the owned coast");
  assert.equal(path![path!.length - 1], 10, "lands on the far coast");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 10, troops: 30 }), null, "the launch is accepted");
});

test("a separate body of water cannot be crossed to", () => {
  // land0 | seaA(1) | land2 | seaB(3) | land4. seaA and seaB are different water
  // bodies (split by land2). The attacker on tile 0 touches only seaA, so it can
  // reach land2 but never land4 — connectivity, not distance, is the gate.
  const grid = new TerritoryGrid(rowMap("#.#.#"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  const conflict = new RasterConflict(grid);

  assert.ok(grid.findSeaPath(1, 2), "land2 shares seaA with the attacker → reachable");
  assert.equal(grid.findSeaPath(1, 4), null, "land4 is on seaB, a disconnected body → unreachable");
  assert.equal(conflict.launchShip({ attacker: 1, dest: 4, troops: 30 }), "NO_FRONTIER");
});

test("a land attack never crosses water", () => {
  // owned 0,1 | water 2 | neutral 3,4: a plain land attack must not leap the river.
  const grid = new TerritoryGrid(rowMap("## ##"));
  grid.addPlayer(1, 50);
  grid.claim(0, 1);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 10 }), "NO_FRONTIER");
});

test("a patrolling warship sinks an enemy transport in range before it lands", () => {
  // owned 0,1 | water 2,3 | player-2 shore 4,5 with a port and a warship
  // patrolling the strait off it.
  const grid = new TerritoryGrid(rowMap("##  ##"));
  grid.addPlayer(1, 200);
  grid.addPlayer(2, 0);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(4, 2);
  grid.claim(5, 2);
  grid.placeBuilding(4, "port"); // player 2's port (instantly active)
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(2, 3, 0), null, "the warship launches from the port");

  assert.equal(conflict.launchShip({ attacker: 1, dest: 4, troops: 100 }), null);
  for (let i = 0; i < 10; i += 1) conflict.processTick();

  assert.equal(conflict.shipCountOf(1), 0, "the transport was sunk en route");
  assert.equal(grid.ownerOf(4), 2, "the warship-guarded shore was never taken");
});

test("a warship never sinks its owner's own transport", () => {
  // Same board, but the warship belongs to the attacker — it guards, never fires
  // on, friendly shipping, so the landing goes through.
  const grid = new TerritoryGrid(rowMap("##  ##"));
  grid.addPlayer(1, 200);
  grid.addPlayer(2, 0);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(4, 2);
  grid.claim(5, 2);
  grid.placeBuilding(1, "port"); // player 1's own port
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);
  assert.equal(conflict.launchWarship(1, 2, 0), null, "player 1's own patrol is afloat");

  assert.equal(conflict.launchShip({ attacker: 1, dest: 4, troops: 100 }), null);
  for (let i = 0; i < 10; i += 1) conflict.processTick();

  assert.equal(grid.ownerOf(4), 1, "the friendly transport landed and took the shore");
});
