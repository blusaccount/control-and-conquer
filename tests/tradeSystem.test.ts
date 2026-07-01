import test from "node:test";
import assert from "node:assert/strict";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { TradeSystem } from "../src/Core/tradeSystem.js";
import {
  tradeShipGold,
  tradeShipSpawnRate,
  TRADE_SHIP_SOFTCAP_MIDPOINT,
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
  // A port fires on OpenFront's spawn cadence (rejection counter reaches the
  // rate), so the first ship appears after ~100 ticks; run well past that. The
  // lane is 3 tiles long, so it arrives a few ticks after dispatch.
  const dist = 3;
  let sawShip = false;
  for (let tick = 0; tick <= 200; tick += 1) {
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
  for (let tick = 0; tick <= 200; tick += 1) trade.advance(tick);
  assert.equal(trade.shipCount, 0, "no ship is dispatched without a partner port");
  assert.equal(grid.goldOf(1), 0, "a lone port earns nothing from trade");
});

test("tradeShipSpawnRate follows OpenFront: rejections speed it up, a full sea throttles it", () => {
  // With an empty sea the base rate is 100 attempts between dispatches.
  assert.equal(tradeShipSpawnRate(0, 0), 100, "empty sea, no rejections → rate 100");
  // A port that keeps failing lowers its own rate, so it fires sooner.
  assert.equal(tradeShipSpawnRate(9, 0), 10, "rejections drop the rate toward firing");
  assert.ok(tradeShipSpawnRate(20, 0) < tradeShipSpawnRate(0, 0), "more rejections → lower rate");
  // The soft cap: at the sigmoid midpoint the rate doubles (spawns throttle), and
  // it keeps climbing as the sea fills — there is no hard fleet cap.
  assert.equal(tradeShipSpawnRate(0, TRADE_SHIP_SOFTCAP_MIDPOINT), 200, "midpoint doubles the rate");
  assert.ok(
    tradeShipSpawnRate(0, TRADE_SHIP_SOFTCAP_MIDPOINT * 2) > tradeShipSpawnRate(0, TRADE_SHIP_SOFTCAP_MIDPOINT),
    "the fuller the sea, the harder new spawns are throttled",
  );
});

test("a port dispatches on OpenFront's cadence, not instantly", () => {
  // Two partnered ports: the first ship should NOT appear in the opening ticks
  // (the rejection counter has to climb to the rate first), but must by ~tick 110.
  const grid = new TerritoryGrid(rowMap("##  ##"));
  grid.addPlayer(1, 0);
  grid.claim(1, 1);
  grid.claim(4, 1);
  grid.placeBuilding(1, "port");
  grid.placeBuilding(4, "port");
  const trade = new TradeSystem(grid);
  for (let tick = 0; tick <= 50; tick += 1) trade.advance(tick);
  assert.equal(trade.shipCount, 0, "no ship in the opening cadence window");
  for (let tick = 51; tick <= 120; tick += 1) trade.advance(tick);
  assert.ok(trade.shipCount > 0 || grid.goldOf(1) > 0, "a ship dispatched (or already arrived) by ~tick 110");
});
