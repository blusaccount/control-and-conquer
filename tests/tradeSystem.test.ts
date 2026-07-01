import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { TradeSystem } from "../src/Core/tradeSystem.js";
import {
  tradeShipGold,
  TRADE_SHIP_SPAWN_INTERVAL_TICKS,
  TRADE_MAX_PER_PLAYER,
} from "../src/Core/buildings.js";

/** Single-row map from a mask: '#' = land, ' ' = water. */
const rowMap = (mask: string) => {
  const width = mask.length;
  const land = new Uint8Array(width);
  const elevation = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) if (mask[x] === "#") land[x] = 1;
  return buildTerrainFromMask({ width, height: 1, land, elevation });
};

/** 2-D map from equal-length mask rows: '#' = land, ' ' = water. */
const gridMap = (rows: string[]) => {
  const height = rows.length;
  const width = rows[0].length;
  const land = new Uint8Array(width * height);
  const elevation = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (rows[y][x] === "#") land[y * width + x] = 1;
  }
  return buildTerrainFromMask({ width, height, land, elevation });
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

test("a trade ship sails the water route and never crosses land", () => {
  // An L-shaped channel: the two ports (A at 0,0 and B at 1,2) share the water,
  // but the STRAIGHT line between them cuts across the land block at the corner.
  // The ship must hug the channel — every position it reports must be on water.
  //   col:  0 1 2 3
  //   y0:   A . . #
  //   y1:   # # . #
  //   y2:   # B . #
  //   y3:   # # # #
  const map = gridMap([
    "#  #",
    "## #",
    "## #",
    "####",
  ]);
  const grid = new TerritoryGrid(map);
  const A = map.ref(0, 0);
  const B = map.ref(1, 2);
  grid.addPlayer(1, 0);
  grid.addPlayer(2, 0);
  grid.claim(A, 1);
  grid.claim(B, 2);
  grid.placeBuilding(A, "port");
  grid.placeBuilding(B, "port");

  const trade = new TradeSystem(grid);
  const isWaterOrPort = (ref: number) => map.isWater(ref) || ref === A || ref === B;

  let sawShip = false;
  for (let tick = 0; tick <= TRADE_SHIP_SPAWN_INTERVAL_TICKS * 2; tick += 1) {
    trade.advance(tick);
    for (const ship of trade.tradeViews()) {
      sawShip = true;
      // The reported position lies on the segment between two path tiles, so the
      // nearest tile is always one of them — assert it is water (or a port).
      const tile = map.ref(Math.round(ship.x), Math.round(ship.y));
      assert.ok(
        isWaterOrPort(tile),
        `trade ship at (${ship.x.toFixed(2)}, ${ship.y.toFixed(2)}) sailed onto land tile ${tile}`,
      );
    }
  }
  assert.ok(sawShip, "a trade ship was dispatched across the channel");
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
  assert.ok(trade.shipCount <= TRADE_MAX_PER_PLAYER, "the fleet never exceeds the per-player cap");
});
