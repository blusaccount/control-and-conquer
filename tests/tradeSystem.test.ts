import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { TradeSystem } from "../src/Core/tradeSystem.js";
import {
  tradeShipGold,
  tradeFleetCap,
  tradePayoutDistance,
  TRADE_SHIP_SPAWN_INTERVAL_TICKS,
  TRADE_REFERENCE_SPAN,
} from "../src/Core/buildings.js";

/** Single-row map from a mask: '#' = land, ' ' = water. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) if (mask[x] === "#") land[x] = 1;
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

test("tradeShipGold follows OpenFront's sigmoid: long hauls pay far more than short hops", () => {
  assert.ok(tradeShipGold(1000) > tradeShipGold(100), "a longer route pays more");
  // Approaches ~75,000 + 50*dist for a very long haul (sigmoid ~1).
  assert.ok(tradeShipGold(2000) > 75_000, "a long haul approaches the ceiling plus the per-tile bonus");
  // The short-range debuff makes a tiny hop pay only a small fraction.
  assert.ok(tradeShipGold(10) < 5_000, "a short hop is heavily penalised");
});

test("two ports across a shared sea trade and pay BOTH owners gold", () => {
  // land0,1 | water2,3 | land4,5. Port on the shore tile of each side, owned by
  // two different players who share the connecting water body.
  const grid = new TerritoryGrid(rowMap("##  ##"));
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  grid.claim(1, 1); // player 1's shore (borders water tile 2)
  grid.claim(4, 2); // player 2's shore (borders water tile 3)
  grid.placeBuilding(1, "port");
  grid.placeBuilding(4, "port");

  const trade = new TradeSystem(grid);
  // Dispatch happens on the fixed cadence (tick % interval === 0), so tick 0
  // sends ships; the lane is 3 tiles long, so they arrive a few ticks later.
  const dist = 3;
  let sawShip = false;
  for (let tick = 0; tick <= TRADE_SHIP_SPAWN_INTERVAL_TICKS; tick += 1) {
    trade.advance(tick);
    if (trade.shipCount > 0) sawShip = true;
  }

  assert.ok(sawShip, "a trade ship sailed between the ports");
  const expected = tradeShipGold(dist);
  assert.ok(grid.goldOf(1) >= expected, `port owner 1 was paid the trade gold, got ${grid.goldOf(1)}`);
  assert.ok(grid.goldOf(2) >= expected, `port owner 2 was paid the trade gold, got ${grid.goldOf(2)}`);
});

test("a lone port with no partner across the water earns no trade gold", () => {
  const grid = new TerritoryGrid(rowMap("##  ##"));
  grid.addPlayer(1, 0);
  grid.claim(1, 1);
  grid.placeBuilding(1, "port"); // the only port — nobody to trade with
  const trade = new TradeSystem(grid);
  for (let tick = 0; tick <= TRADE_SHIP_SPAWN_INTERVAL_TICKS + 5; tick += 1) trade.advance(tick);
  assert.equal(trade.shipCount, 0, "no ship is dispatched without a partner port");
  assert.equal(grid.goldOf(1), 0, "a lone port earns nothing from trade");
});

test("a player's trade fleet is capped", () => {
  // Many ports for player 1 on one shore, all sharing the sea, so dispatch would
  // exceed the cap without the limit.
  const grid = new TerritoryGrid(rowMap("#### ####"));
  grid.addPlayer(1, 0);
  // Shore tiles 3 and 4 border the water gap at index 4; claim a run and port
  // several shore-adjacent tiles. Tiles 0-3 are land, 4 is water, 5-8 land.
  for (const ref of [0, 1, 2, 3, 5, 6, 7, 8]) grid.claim(ref, 1);
  for (const ref of [3, 5]) grid.placeBuilding(ref, "port"); // both border water tile 4
  const trade = new TradeSystem(grid);
  for (let tick = 0; tick <= TRADE_SHIP_SPAWN_INTERVAL_TICKS * 3; tick += 1) trade.advance(tick);
  // Two ports → the cap is the floor (tradeFleetCap(2)); the fleet never exceeds it.
  assert.ok(trade.shipCount <= tradeFleetCap(2), "the fleet never exceeds the per-player cap");
});

test("the trade-fleet cap scales with owned ports (income tracks the coastal empire)", () => {
  // More ports must lift the cap, so a bigger coastal empire sustains more trade.
  assert.equal(tradeFleetCap(1), 4, "a lone port floats the base fleet");
  assert.equal(tradeFleetCap(4), 4, "the base is the floor");
  assert.equal(tradeFleetCap(10), 10, "each extra port beyond the floor adds a ship");
  assert.equal(tradeFleetCap(1000), 40, "a huge navy is ceilinged");
  assert.ok(tradeFleetCap(20) > tradeFleetCap(5), "more ports → a larger cap");
});

test("trade is priced by a map-relative distance so a port pays back on small maps", () => {
  // The same physical trip pays far more on a small map than on an OpenFront-scale
  // one, because a short-map distance is scaled up toward the reference span before
  // pricing — otherwise every hop would sit in the sigmoid's penalised tail.
  const dist = 60;
  const smallSpan = 120; // e.g. a ~60×60 sketch map
  const largeSpan = TRADE_REFERENCE_SPAN * 2; // an Earth-scale map, priced verbatim
  assert.ok(
    tradePayoutDistance(dist, smallSpan) > tradePayoutDistance(dist, largeSpan),
    "a short-map trip is priced at a longer effective distance",
  );
  // A map at/above the reference span is unchanged (factor 1) — large maps keep
  // OpenFront's exact numbers.
  assert.equal(tradePayoutDistance(dist, largeSpan), dist, "large maps are priced verbatim");
  assert.ok(
    tradeShipGold(tradePayoutDistance(dist, smallSpan)) > tradeShipGold(dist),
    "so the small-map port earns meaningfully more per trip",
  );
});
