import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict, type AttackIntent } from "../src/Core/RasterConflict.js";
import { encodeTile } from "../src/Core/terrainCodec.js";
import {
  DEFENDER_STRENGTH_MAX,
  DEFENDER_STRENGTH_MIN,
  INCOME_PER_TILE_PER_TICK,
  defenderLossPerTile,
  defenderStrengthFactor,
} from "../src/Core/rasterCombatConfig.js";

const flatLand = (width: number, height: number): GameMap => {
  const terrain = new Uint8Array(width * height);
  terrain.fill(encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 }));
  return new GameMap(width, height, terrain);
};

/** Run `n` empty ticks. */
const runTicks = (conflict: RasterConflict, n: number): void => {
  for (let i = 0; i < n; i += 1) conflict.processTick();
};

test("income grows the pool proportionally to owned tiles", () => {
  const grid = new TerritoryGrid(flatLand(10, 10));
  grid.addPlayer(1, 0);
  for (let ref = 0; ref < 10; ref += 1) grid.claim(ref, 1); // 10 tiles, far from victory
  const conflict = new RasterConflict(grid);

  // 10 tiles * 0.02 = 0.2 troops/tick -> exactly 1 whole troop after 5 ticks.
  const ticksForOne = Math.round(1 / (10 * INCOME_PER_TILE_PER_TICK));
  runTicks(conflict, ticksForOne);
  assert.equal(grid.troopsOf(1), 1);
});

test("launchAttack rejects invalid intents without mutating state", () => {
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 5);
  grid.addPlayer(2, 5);
  grid.claim(0, 1); // player 1 at the far left
  grid.claim(4, 2); // player 2 at the far right (not adjacent)
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 99, target: 0, troops: 1 }), "UNKNOWN_PLAYER");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 1, troops: 1 }), "INVALID_TARGET");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 77, troops: 1 }), "INVALID_TARGET");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 0, troops: 0 }), "INVALID_TROOP_COUNT");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 0, troops: 1.5 }), "INVALID_TROOP_COUNT");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 0, troops: 999 }), "INSUFFICIENT_TROOPS");
  // Player 2 is not adjacent to player 1, so an attack against it has no frontier.
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 1 }), "NO_FRONTIER");

  // No successful attack was launched and the pool is untouched.
  assert.equal(conflict.activeAttackCount, 0);
  assert.equal(grid.troopsOf(1), 5);
});

test("neutral expansion claims a line of tiles ring by ring until troops run out", () => {
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 4);
  grid.claim(0, 1);
  const conflict = new RasterConflict(grid);

  // Commit all 4 troops toward the 4 neutral tiles (cost 1 each on flat land).
  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 4 }), null);
  assert.equal(grid.troopsOf(1), 0, "committed troops leave the pool immediately");

  // After the first expansion tick only the adjacent tile is taken (ring 1).
  conflict.processTick();
  assert.equal(grid.ownerOf(1), 1);
  assert.equal(grid.ownerOf(2), NEUTRAL_PLAYER);

  // A handful more ticks captures the whole line and wins the (5-tile) map.
  runTicks(conflict, 10);
  for (let ref = 0; ref < 5; ref += 1) assert.equal(grid.ownerOf(ref), 1);
  assert.equal(conflict.winner, 1);
});

test("enemy capture costs more, drains the defender, and transfers tiles", () => {
  // 4x1 land: player 1 holds tiles 0-1, player 2 holds tiles 2-3.
  const grid = new TerritoryGrid(flatLand(4, 1));
  grid.addPlayer(1, 20);
  grid.addPlayer(2, 5);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(2, 2);
  grid.claim(3, 2);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 20 }), null);
  runTicks(conflict, 30);

  assert.equal(grid.tileCountOf(2), 0, "defender loses all tiles");
  assert.equal(grid.tileCountOf(1), 4);
  // Defender lost 1 troop per captured tile (2 tiles) from its starting pool of 5.
  assert.ok(grid.troopsOf(2) <= 3, `defender pool should drop, got ${grid.troopsOf(2)}`);
  assert.equal(conflict.winner, 1);
});

test("defender bleed is density-based: a dense defender loses more per tile", () => {
  // 5x1 land: player 1 holds tile 0; player 2 holds tiles 1-4 (4 tiles) with a
  // dense pool (40 troops -> density 10/tile), far above the 1-troop floor.
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 100);
  grid.addPlayer(2, 40);
  grid.claim(0, 1);
  for (let ref = 1; ref < 5; ref += 1) grid.claim(ref, 2);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 100 }), null);
  const before = grid.troopsOf(2);
  conflict.processTick(); // captures the single frontier tile (tile 1)

  assert.equal(grid.ownerOf(1), 1, "the bordering enemy tile is taken");
  // One tile captured should bleed ~density (10), not the flat 1-troop floor.
  assert.ok(before - grid.troopsOf(2) >= 5, `dense defender should bleed hard, lost ${before - grid.troopsOf(2)}`);
});

test("defenderLossPerTile spreads the pool over territory, floored at 1", () => {
  assert.equal(defenderLossPerTile(100, 4), 25); // dense: 100/4
  assert.equal(defenderLossPerTile(3, 10), 1); // sparse: 0.3 -> floored to 1
  assert.equal(defenderLossPerTile(50, 0), 1); // no tiles -> floor
});

test("defenderStrengthFactor clamps the troop ratio into its band", () => {
  // At parity the factor is ~1; a far stronger defender saturates the max; a far
  // stronger attacker bottoms out at the min; a spent-out assault yields the max.
  assert.equal(defenderStrengthFactor(50, 50), 1);
  assert.equal(defenderStrengthFactor(1000, 10), DEFENDER_STRENGTH_MAX);
  assert.equal(defenderStrengthFactor(1, 1000), DEFENDER_STRENGTH_MIN);
  assert.equal(defenderStrengthFactor(50, 0), DEFENDER_STRENGTH_MAX);
});

test("a strong garrison repels the very assault a weak one cannot", () => {
  // 3x1 line: player 1 (tile 0) attacks player 2 (tiles 1-2) with the same small
  // force in both runs. The only difference is how heavily player 2 is garrisoned
  // — which is exactly what should decide whether the attack breaks through.
  const build = (defenderTroops: number) => {
    const grid = new TerritoryGrid(flatLand(3, 1));
    grid.addPlayer(1, 6);
    grid.addPlayer(2, defenderTroops);
    grid.claim(0, 1);
    grid.claim(1, 2);
    grid.claim(2, 2);
    return { grid, conflict: new RasterConflict(grid) };
  };

  // Weak garrison: 6 committed troops grind through both tiles over a few ticks.
  const weak = build(5);
  assert.equal(weak.conflict.launchAttack({ attacker: 1, target: 2, troops: 6 }), null);
  runTicks(weak.conflict, 30);
  assert.equal(weak.grid.tileCountOf(2), 0, "a thinly-held nation is overrun");

  // Strong garrison: the identical 6-troop assault can't afford a single tile and
  // is repelled outright — holding troops now provides real defensive value.
  const strong = build(100);
  assert.equal(strong.conflict.launchAttack({ attacker: 1, target: 2, troops: 6 }), null);
  runTicks(strong.conflict, 30);
  assert.equal(strong.grid.tileCountOf(2), 2, "a well-garrisoned nation holds its ground");
  assert.equal(strong.conflict.activeAttackCount, 0, "the repelled assault ends");
});

test("frontier priority captures easy low ground before high ground", () => {
  // 3x1 line: tile 0 is high ground (mag 10), the attacker sits on tile 1, tile 2
  // is flat. By raw tile order the elevated tile 0 comes first; priority ordering
  // must instead grab the flat tile 2 first. Budget is tuned to one tile per tick.
  const terrain = new Uint8Array(3);
  terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 10 });
  terrain[1] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  terrain[2] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  const grid = new TerritoryGrid(new GameMap(3, 1, terrain));
  grid.addPlayer(1, 8);
  grid.claim(1, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 8 }), null);
  conflict.processTick();

  assert.equal(grid.ownerOf(2), 1, "flat low ground is taken first");
  assert.equal(grid.ownerOf(0), NEUTRAL_PLAYER, "high ground waits its turn");

  runTicks(conflict, 5);
  assert.equal(grid.ownerOf(0), 1, "the high ground is eventually captured too");
});

test("expansion spreads as an even blob, not a contour-hugging tendril", () => {
  // A front must advance as a roughly radial bulge in every direction, not snake
  // single-file along the lowest ground. We lay an elevation gradient across x
  // (column 0 lowest, column W-1 highest) and let a centred player expand into
  // open neutral land. The smoothing term must dominate elevation, so the
  // territory grows outward on every side rather than threading toward column 0.
  const W = 21;
  const H = 21;
  const cx = 10;
  const cy = 10;
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      terrain[y * W + x] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: x });
    }
  }
  const grid = new TerritoryGrid(new GameMap(W, H, terrain));
  grid.addPlayer(1, 200);
  grid.claim(cy * W + cx, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 200 }), null);
  runTicks(conflict, 12);

  let towardHigh = 0;
  let towardLow = 0;
  let up = 0;
  let down = 0;
  for (const ref of grid.tilesOf(1)) {
    const x = ref % W;
    const y = Math.floor(ref / W);
    if (x > cx) towardHigh += 1;
    if (x < cx) towardLow += 1;
    if (y < cy) up += 1;
    if (y > cy) down += 1;
  }

  // The front advances on the high-ground side too — not just down the gradient.
  // (A pre-fix contour-hugging tendril leaves this near zero.)
  assert.ok(towardHigh > 0, "the front advances onto higher ground, not only the lowest");
  assert.ok(
    towardHigh >= towardLow * 0.3,
    `growth is blob-like, not a low-ground tendril (low=${towardLow}, high=${towardHigh})`,
  );
  // Elevation varies only across x, so the perpendicular (vertical) axis spreads
  // symmetrically — a tendril would collapse one of these to ~0.
  assert.ok(up > 0 && down > 0, "the front also spreads perpendicular to the gradient");
});

test("a front blocked against a player refunds troops minus the retreat malus", () => {
  // 2x1: player 1 (tile 0) attacks player 2 (tile 1) with too few troops to
  // afford the enemy tile (flat enemy cost = 1 + 2 surcharge = 3). The assault
  // makes no progress and recoils, losing 25% of the committed force.
  const grid = new TerritoryGrid(flatLand(2, 1));
  grid.addPlayer(1, 2);
  grid.addPlayer(2, 10);
  grid.claim(0, 1);
  grid.claim(1, 2);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 2 }), null);
  assert.equal(grid.troopsOf(1), 0, "committed troops leave the pool");
  conflict.processTick();

  assert.equal(grid.tileCountOf(2), 1, "the defended tile is not taken");
  assert.equal(grid.troopsOf(1), 1.5, "2 committed troops return as 1.5 (25% malus)");
  assert.equal(conflict.activeAttackCount, 0, "the blocked attack ends");
});

test("a front blocked against neutral land refunds troops in full", () => {
  // tile 1 is a steep neutral peak (mag 30 -> cost 4); 3 committed can't take it.
  // Retreating from neutral land (TerraNullius) is free — full refund, no malus.
  const terrain = new Uint8Array(2);
  terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  terrain[1] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 30 });
  const grid = new TerritoryGrid(new GameMap(2, 1, terrain));
  grid.addPlayer(1, 3);
  grid.claim(0, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 3 }), null);
  conflict.processTick();

  assert.equal(grid.ownerOf(1), NEUTRAL_PLAYER, "the peak is not taken");
  assert.equal(grid.troopsOf(1), 3, "all 3 troops return — neutral retreat is free");
});

test("a defense post fortifies the ground around it, slowing a conquest", () => {
  // 6x1 flat line, player 1 on tile 0 with exactly enough troops (5) to walk the
  // five neutral tiles at cost 1 each — and win — on open ground.
  const build = () => {
    const grid = new TerritoryGrid(flatLand(6, 1));
    grid.addPlayer(1, 5);
    grid.claim(0, 1);
    return grid;
  };

  const open = build();
  const openConflict = new RasterConflict(open);
  assert.equal(openConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 5 }), null);
  runTicks(openConflict, 30);
  assert.equal(open.tileCountOf(1), 6, "on open ground the whole line falls");
  assert.equal(openConflict.winner, 1);

  // Same troops, but tile 5 is a defense post (radius 2, strength 3): tiles 4 and
  // 5 now cost more, so the five troops can't reach the far end.
  const fortified = build();
  fortified.addDefensePost(5, 2, 3);
  const fortConflict = new RasterConflict(fortified);
  assert.equal(fortConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 5 }), null);
  runTicks(fortConflict, 30);
  assert.equal(fortified.ownerOf(5), NEUTRAL_PLAYER, "the fortified tile holds out");
  assert.ok(fortified.tileCountOf(1) < 6, `the post stalls the conquest, owns ${fortified.tileCountOf(1)}`);
  assert.equal(fortConflict.winner, null);
});

test("a finished match ignores further intents", () => {
  const grid = new TerritoryGrid(flatLand(2, 1));
  grid.addPlayer(1, 5);
  grid.addPlayer(2, 5);
  grid.claim(0, 1);
  grid.claim(1, 1); // player 1 already owns everything -> immediate winner
  const conflict = new RasterConflict(grid);

  conflict.processTick();
  assert.equal(conflict.winner, 1);

  const result = conflict.processTick([{ attacker: 2, target: 1, troops: 1 }]);
  assert.equal(result.winner, 1);
  assert.equal(result.activeAttacks, 0);
});

test("simulation is deterministic for identical setup and intents", () => {
  const build = (): { grid: TerritoryGrid; conflict: RasterConflict } => {
    const grid = new TerritoryGrid(flatLand(6, 1));
    grid.addPlayer(1, 6);
    grid.addPlayer(2, 6);
    grid.claim(0, 1);
    grid.claim(5, 2);
    return { grid, conflict: new RasterConflict(grid) };
  };
  const intents: AttackIntent[] = [
    { attacker: 1, target: NEUTRAL_PLAYER, troops: 5 },
    { attacker: 2, target: NEUTRAL_PLAYER, troops: 5 },
  ];

  const a = build();
  const b = build();
  a.conflict.processTick(intents);
  b.conflict.processTick(intents);
  for (let i = 0; i < 20; i += 1) {
    a.conflict.processTick();
    b.conflict.processTick();
  }
  assert.deepEqual(Array.from(a.grid.owner), Array.from(b.grid.owner));
});

test("activeFronts reports each land attack with its committed troops and an anchor", () => {
  const grid = new TerritoryGrid(flatLand(8, 1));
  grid.addPlayer(1, 40);
  grid.claim(0, 1); // player 1 holds the left end
  const conflict = new RasterConflict(grid);

  // No attacks yet -> no fronts.
  assert.equal(conflict.activeFronts().length, 0);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 30 }), null);
  conflict.processTick(); // advance once so the front has an anchor

  const fronts = conflict.activeFronts();
  assert.equal(fronts.length, 1, "the one active expansion is reported as a front");
  assert.equal(fronts[0].attacker, 1);
  assert.equal(fronts[0].target, NEUTRAL_PLAYER);
  assert.ok(fronts[0].troops > 0, "committed troops still on the front are reported");
  // The anchor is a real tile on the contested strip (not the -1 placeholder).
  assert.ok(fronts[0].tile >= 0 && fronts[0].tile < grid.map.size);
});
