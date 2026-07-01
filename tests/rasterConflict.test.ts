import assert from "node:assert/strict";
import { test } from "node:test";
import { GameMap } from "../src/Core/GameMap.js";
import { NEUTRAL_PLAYER, TerritoryGrid } from "../src/Core/TerritoryGrid.js";
import { RasterConflict, type AttackIntent } from "../src/Core/RasterConflict.js";
import { encodeTile } from "../src/Core/terrainCodec.js";
import { IDENTITY_MODIFIERS } from "../src/Core/playerModifiers.js";
import {
  DEFENDER_STRENGTH_MAX,
  DEFENDER_STRENGTH_MIN,
  maxTroops,
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  TERRAIN_COMBAT_HIGHLAND,
  TERRAIN_COMBAT_MOUNTAIN,
  TERRAIN_COMBAT_PLAINS,
  attackTilesPerTick,
  attackerLossPerTile,
  largeDefenderLossFactor,
  largeAttackerLossFactor,
  LARGE_ATTACKER_TILES,
  LARGE_DEFENDER_MIDPOINT,
  LARGE_DEFENDER_LOSS_FLOOR,
  defenderLossPerTile,
  defenderStrengthFactor,
  neutralLossPerTile,
  terrainCombat,
  terrainPriorityWeight,
  TRAITOR_DURATION_TICKS,
} from "../src/Core/rasterCombatConfig.js";

const flatLand = (width: number, height: number): GameMap => {
  const terrain = new Uint8Array(width * height);
  terrain.fill(encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 }));
  return new GameMap(width, height, terrain);
};

/**
 * Freeze every seated player's troop income (income modifier 0) so a combat test
 * measures only combat. The economy's bell-curve growth is verified on its own in
 * income.test.ts; at this small scale it would otherwise add ~10 troops/tick and
 * perturb the exact troop accounting these combat assertions rely on.
 */
const freezeIncome = (grid: TerritoryGrid): void => {
  for (const id of grid.players()) grid.setModifiers(id, { ...IDENTITY_MODIFIERS, income: 0 });
};

/** Run `n` empty ticks. */
const runTicks = (conflict: RasterConflict, n: number): void => {
  for (let i = 0; i < n; i += 1) conflict.processTick();
};

test("income grows the pool toward its territory-scaled ceiling", () => {
  const grid = new TerritoryGrid(flatLand(10, 10));
  grid.addPlayer(1, 0);
  for (let ref = 0; ref < 10; ref += 1) grid.claim(ref, 1); // 10 tiles, far from victory
  const conflict = new RasterConflict(grid);

  // OpenFront's bell-curve growth lifts the pool from empty toward maxTroops(10);
  // it must climb above zero yet never breach the territory-scaled ceiling.
  runTicks(conflict, 50);
  const cap = maxTroops(10, 0);
  assert.ok(grid.troopsOf(1) > 0, "the pool grows from empty");
  assert.ok(grid.troopsOf(1) <= cap, "the pool stays under the territory ceiling");
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

test("a directed attack takes the click-side tile first", () => {
  // A 1-row strip: player 1 seeds the middle (tile 10) with neutral land on both
  // sides and commits just enough for a single tile. A purely radial front would
  // pick a side arbitrarily — but a `toward` target makes the lone affordable
  // capture land on the side facing the click (neutral land costs mag/5 = 16, so
  // 20 troops afford exactly one tile).
  const make = (toward: number): TerritoryGrid => {
    const grid = new TerritoryGrid(flatLand(21, 1));
    grid.addPlayer(1, 20);
    grid.claim(10, 1);
    freezeIncome(grid);
    const conflict = new RasterConflict(grid);
    conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 20, toward });
    conflict.processTick();
    return grid;
  };

  const right = make(20);
  assert.equal(right.ownerOf(11), 1, "the tile toward the click (right) is taken");
  assert.equal(right.ownerOf(9), NEUTRAL_PLAYER, "the away side (left) is left untouched");

  // Pointing the other way mirrors the result.
  const left = make(0);
  assert.equal(left.ownerOf(9), 1, "the tile toward the click (left) is taken");
  assert.equal(left.ownerOf(11), NEUTRAL_PLAYER, "the away side (right) is left untouched");
});

test("neutral expansion claims a line of tiles ring by ring until troops run out", () => {
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 80);
  grid.claim(0, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  // Commit 80 troops toward the 4 neutral tiles (mag/5 = 16 each on flat land).
  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 80 }), null);
  assert.equal(grid.troopsOf(1), 0, "committed troops leave the pool immediately");

  // The line has a one-tile-wide frontier, so each tick takes the next ring.
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
  grid.addPlayer(1, 2000);
  grid.addPlayer(2, 100);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(2, 2);
  grid.claim(3, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  const defenderBefore = grid.troopsOf(2);
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 2000 }), null);
  runTicks(conflict, 30);

  assert.equal(grid.tileCountOf(2), 0, "defender loses all tiles");
  assert.equal(grid.tileCountOf(1), 4);
  // Each captured tile bleeds the defender's density from its pool.
  assert.ok(grid.troopsOf(2) < defenderBefore, `defender pool should drop, got ${grid.troopsOf(2)}`);
  assert.equal(conflict.winner, 1);
});

test("defender bleed is density-based: a dense defender loses more per tile", () => {
  // 5x1 land: player 1 holds tile 0; player 2 holds tiles 1-4 (4 tiles) with a
  // dense pool (4000 troops -> density 1000/tile), far above the 1-troop floor.
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 20_000);
  grid.addPlayer(2, 4000);
  grid.claim(0, 1);
  for (let ref = 1; ref < 5; ref += 1) grid.claim(ref, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 20_000 }), null);
  const before = grid.troopsOf(2);
  conflict.processTick(); // captures the single frontier tile (tile 1)

  assert.equal(grid.ownerOf(1), 1, "the bordering enemy tile is taken");
  // One tile captured should bleed ~density (1000), not the flat 1-troop floor.
  assert.ok(before - grid.troopsOf(2) >= 100, `dense defender should bleed hard, lost ${before - grid.troopsOf(2)}`);
});

test("a traitor is marked for a fixed window, then clears (OpenFront traitorDuration)", () => {
  const grid = new TerritoryGrid(flatLand(4, 1));
  grid.addPlayer(1, 100);
  grid.claim(0, 1);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.isTraitor(1), false, "nobody starts a traitor");
  conflict.markTraitor(1);
  assert.equal(conflict.isTraitor(1), true, "betrayal marks the player");
  runTicks(conflict, TRAITOR_DURATION_TICKS - 1);
  assert.equal(conflict.isTraitor(1), true, "still a traitor just before the window ends");
  runTicks(conflict, 1);
  assert.equal(conflict.isTraitor(1), false, "the mark clears after traitorDuration ticks");
});

test("a traitor defender is cheaper to conquer (OpenFront traitorDefenseDebuff)", () => {
  // Same assault against the same defender captures MORE of its land when the
  // defender is a marked traitor, because its tiles cost half the magnitude.
  const conquer = (betray: boolean): number => {
    const grid = new TerritoryGrid(flatLand(12, 1));
    grid.addPlayer(1, 6000); // attacker
    grid.addPlayer(2, 60_000); // dense defender holds tiles 1..11 (costly to take)
    grid.claim(0, 1);
    for (let ref = 1; ref < 12; ref += 1) grid.claim(ref, 2);
    freezeIncome(grid);
    const conflict = new RasterConflict(grid);
    if (betray) conflict.markTraitor(2);
    assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 6000 }), null);
    runTicks(conflict, 60);
    return grid.tileCountOf(1) - 1; // tiles taken from the defender
  };

  const normal = conquer(false);
  const vsTraitor = conquer(true);
  assert.ok(normal > 0 && normal < 11, `the baseline assault should stall partway, took ${normal}`);
  assert.ok(vsTraitor > normal, `a traitor loses more ground: ${vsTraitor} vs ${normal}`);
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

test("largeDefenderLossFactor eases a huge empire's tiles cheaper to take (anti-snowball)", () => {
  // A small empire defends at ~full strength; a huge one eases toward the floor.
  assert.ok(largeDefenderLossFactor(0) > 0.95 && largeDefenderLossFactor(0) <= 1, "a tiny empire is barely debuffed");
  // At the midpoint the sigmoid is 0.5, so the factor is 0.7 + 0.3·0.5 = 0.85.
  assert.ok(Math.abs(largeDefenderLossFactor(LARGE_DEFENDER_MIDPOINT) - 0.85) < 1e-9, "midpoint halves the debuff");
  assert.ok(
    largeDefenderLossFactor(1_000_000) >= LARGE_DEFENDER_LOSS_FLOOR && largeDefenderLossFactor(1_000_000) < 0.72,
    "a huge empire eases toward the floor",
  );
  // Monotonic: the bigger the defender, the cheaper each of its tiles is to take.
  assert.ok(largeDefenderLossFactor(500_000) < largeDefenderLossFactor(100_000), "bigger = cheaper to chip");
});

test("largeAttackerLossFactor makes a huge empire's tiles cheaper to take (OpenFront largeAttackBonus)", () => {
  // At or below the threshold there is no discount (normal games/maps unaffected).
  assert.equal(largeAttackerLossFactor(0), 1, "a small attacker pays full price");
  assert.equal(largeAttackerLossFactor(LARGE_ATTACKER_TILES), 1, "no discount right at the threshold");
  // Past the threshold the factor eases below 1 as sqrt(100000/att)^0.7 = (100000/att)^0.35.
  const f = largeAttackerLossFactor(LARGE_ATTACKER_TILES * 4);
  assert.ok(Math.abs(f - Math.pow(0.25, 0.35)) < 1e-9, "matches (100000/att)^0.35");
  assert.ok(f < 1, "a huge attacker projects force more cheaply");
  // Monotonic: the bigger the attacker, the cheaper each tile it takes.
  assert.ok(
    largeAttackerLossFactor(LARGE_ATTACKER_TILES * 9) < largeAttackerLossFactor(LARGE_ATTACKER_TILES * 4),
    "bigger attacker = cheaper conquest",
  );
});

test("terrainCombat buckets elevation into plains/highland/mountain mag/speed bands", () => {
  assert.equal(terrainCombat(0), TERRAIN_COMBAT_PLAINS);
  assert.equal(terrainCombat(9), TERRAIN_COMBAT_PLAINS);
  assert.equal(terrainCombat(10), TERRAIN_COMBAT_HIGHLAND);
  assert.equal(terrainCombat(19), TERRAIN_COMBAT_HIGHLAND);
  assert.equal(terrainCombat(20), TERRAIN_COMBAT_MOUNTAIN);
  assert.equal(terrainCombat(30), TERRAIN_COMBAT_MOUNTAIN);
  // OpenFront's exact mag/speed pairs: higher ground costs more and (nominally)
  // advances faster per loss.
  assert.deepEqual(TERRAIN_COMBAT_PLAINS, { mag: 80, speed: 16.5 });
  assert.deepEqual(TERRAIN_COMBAT_HIGHLAND, { mag: 100, speed: 20 });
  assert.deepEqual(TERRAIN_COMBAT_MOUNTAIN, { mag: 120, speed: 25 });
  assert.ok(TERRAIN_COMBAT_MOUNTAIN.mag > TERRAIN_COMBAT_PLAINS.mag, "mountains cost the attacker more");
});

test("neutral land costs mag/5, and an enemy tile costs more against a denser, stronger garrison", () => {
  // Neutral: a flat mag/5 with no defender to overcome.
  assert.equal(neutralLossPerTile(80), 16);
  assert.equal(neutralLossPerTile(120), 24);
  // Enemy: a stronger defender (worse troop ratio) and a denser one both raise
  // the attacker's per-tile loss.
  const weak = attackerLossPerTile(/*defTroops*/ 100, /*density*/ 10, /*attack*/ 10_000, 80);
  const strong = attackerLossPerTile(/*defTroops*/ 100_000, /*density*/ 5_000, /*attack*/ 10_000, 80);
  assert.ok(strong > weak, "a dense, well-garrisoned tile is dearer to take");
  // Higher ground (greater mag) costs more for the same garrison.
  assert.ok(
    attackerLossPerTile(1000, 100, 10_000, 120) > attackerLossPerTile(1000, 100, 10_000, 80),
    "mountains cost more than plains",
  );
});

test("attackTilesPerTick rolls faster the bigger the attacker's troop advantage", () => {
  // Neutral land: a flat multiple of the contested border width.
  assert.equal(attackTilesPerTick(0, 5000, 4, false), 8);
  // Against a player: a stronger assault clears more of the border per tick, a
  // weaker one less — both clamped into OpenFront's band.
  const strongPush = attackTilesPerTick(/*def*/ 1000, /*atk*/ 100_000, /*border*/ 4, true);
  const weakPush = attackTilesPerTick(/*def*/ 100_000, /*atk*/ 1000, /*border*/ 4, true);
  assert.ok(strongPush > weakPush, "an overwhelming assault advances faster");
  assert.ok(weakPush > 0, "even an outmatched poke creeps forward");
});

test("maxShipsOf scales the ship cap by the shipCapacity modifier, floored at 1", () => {
  const grid = new TerritoryGrid(flatLand(4, 1));
  grid.addPlayer(1, 0);
  // Baseline (identity modifiers) is exactly the base cap — no behaviour change.
  assert.equal(grid.maxShipsOf(1), MAX_TRANSPORT_SHIPS_PER_PLAYER, "baseline equals the base cap");
  // A perk that doubles capacity doubles the cap — the same per-player hook seaRangeOf uses.
  grid.setModifiers(1, { ...grid.modifiersOf(1), shipCapacity: 2 });
  assert.equal(grid.maxShipsOf(1), MAX_TRANSPORT_SHIPS_PER_PLAYER * 2);
  // It never collapses to zero, so a player can always put at least one ship out.
  grid.setModifiers(1, { ...grid.modifiersOf(1), shipCapacity: 0 });
  assert.equal(grid.maxShipsOf(1), 1, "never drops below one ship");
});

test("mountain ground costs an attacker more troops to take than plains", () => {
  // Two identical neutral grabs differing only in the target tile's elevation:
  // a high mountain tile must drain more of the committed force than flat plains.
  const run = (elevation: number): number => {
    // 3-wide so a frontier remains after the middle tile falls and the front is
    // still reported (its leftover committed troops reveal what the capture cost).
    const terrain = new Uint8Array(3);
    terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
    terrain[1] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: elevation });
    terrain[2] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
    const grid = new TerritoryGrid(new GameMap(3, 1, terrain));
    grid.addPlayer(1, 200);
    grid.claim(0, 1);
    freezeIncome(grid);
    const conflict = new RasterConflict(grid);
    assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 200 }), null);
    conflict.processTick(); // capture the adjacent neutral tile (tile 1)
    assert.equal(grid.ownerOf(1), 1, "the tile is taken either way");
    // Leftover committed troops sit on the front; 200 minus them is what tile 1 cost.
    const front = conflict.activeFronts()[0];
    return 200 - (front ? front.troops : 0);
  };

  assert.ok(run(30) > run(0), "the mountain capture costs more than the plains one");
});

test("a strong garrison repels the very assault a weak one cannot", () => {
  // 3x1 line: player 1 (tile 0) attacks player 2 (tiles 1-2) with the same small
  // force in both runs. The only difference is how heavily player 2 is garrisoned
  // — which is exactly what should decide whether the attack breaks through.
  const build = (defenderTroops: number) => {
    const grid = new TerritoryGrid(flatLand(3, 1));
    grid.addPlayer(1, 4000);
    grid.addPlayer(2, defenderTroops);
    grid.claim(0, 1);
    grid.claim(1, 2);
    grid.claim(2, 2);
    freezeIncome(grid);
    return { grid, conflict: new RasterConflict(grid) };
  };

  // Weak garrison: a 4000-troop assault can afford the thinly-held border tile and
  // bites into player 2's territory.
  const weak = build(500);
  assert.equal(weak.conflict.launchAttack({ attacker: 1, target: 2, troops: 4000 }), null);
  runTicks(weak.conflict, 30);
  assert.ok(weak.grid.tileCountOf(2) < 2, `a thinly-held nation loses ground, holds ${weak.grid.tileCountOf(2)}`);

  // Strong garrison: the identical 4000-troop assault can't afford a single tile
  // against a dense pool and is repelled outright — holding troops now provides
  // real defensive value.
  const strong = build(100_000);
  assert.equal(strong.conflict.launchAttack({ attacker: 1, target: 2, troops: 4000 }), null);
  runTicks(strong.conflict, 30);
  assert.equal(strong.grid.tileCountOf(2), 2, "a well-garrisoned nation holds its ground");
  assert.equal(strong.conflict.activeAttackCount, 0, "the repelled assault ends");
});

test("two fronts dismantle a defender faster than one (each captured tile bleeds the shared pool)", () => {
  // 5x1 line: player 1 (tile 0) and player 2 (tile 4) flank defender player 3,
  // who holds tiles 1-3 with a pool both assaults can afford to chip. Mirroring
  // OpenFront, the dilution is emergent: every tile a front takes bleeds the
  // defender's shared pool, so two fronts capturing at once drain it faster than
  // one — the pincer eats more ground in the same number of ticks.
  const build = () => {
    const grid = new TerritoryGrid(flatLand(5, 1));
    grid.addPlayer(1, 4000);
    grid.addPlayer(2, 4000);
    grid.addPlayer(3, 3000);
    grid.claim(0, 1);
    grid.claim(1, 3);
    grid.claim(2, 3);
    grid.claim(3, 3);
    grid.claim(4, 2);
    freezeIncome(grid);
    return { grid, conflict: new RasterConflict(grid) };
  };

  // One front nibbles from a single side.
  const solo = build();
  assert.equal(solo.conflict.launchAttack({ attacker: 1, target: 3, troops: 4000 }), null);
  solo.conflict.processTick();
  const soloHeld = solo.grid.tileCountOf(3);

  // A pincer eats from both sides at once, so the defender holds strictly fewer
  // tiles after the same single tick.
  const pincer = build();
  assert.equal(pincer.conflict.launchAttack({ attacker: 1, target: 3, troops: 4000 }), null);
  assert.equal(pincer.conflict.launchAttack({ attacker: 2, target: 3, troops: 4000 }), null);
  pincer.conflict.processTick();
  assert.ok(
    pincer.grid.tileCountOf(3) < soloHeld,
    `a two-front pincer dismantles faster: pincer left ${pincer.grid.tileCountOf(3)}, solo left ${soloHeld}`,
  );
});

test("frontier priority captures easy low ground before high ground", () => {
  // 3x1 line: tile 0 is high ground (mag 10), the attacker sits on tile 1, tile 2
  // is flat. By raw tile order the elevated tile 0 comes first; priority ordering
  // must instead grab the flat tile 2 first. Budget is tuned to one tile per tick.
  const terrain = new Uint8Array(3);
  terrain[0] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 25 });
  terrain[1] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  terrain[2] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: 0 });
  const grid = new TerritoryGrid(new GameMap(3, 1, terrain));
  // Just enough troops for one plains tile (mag/5 = 16), so the front must choose:
  // priority ordering takes the easy flat tile, leaving the dear mountain.
  grid.addPlayer(1, 16);
  grid.claim(1, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 16 }), null);
  conflict.processTick();

  assert.equal(grid.ownerOf(2), 1, "flat low ground is taken first");
  assert.equal(grid.ownerOf(0), NEUTRAL_PLAYER, "dear mountain ground is left for last");
});

test("terrainPriorityWeight buckets elevation into OpenFront's 1 / 1.5 / 2 bands", () => {
  assert.equal(terrainPriorityWeight(0), 1, "plains");
  assert.equal(terrainPriorityWeight(9), 1, "top of the plains band");
  assert.equal(terrainPriorityWeight(10), 1.5, "highland");
  assert.equal(terrainPriorityWeight(19), 1.5, "top of the highland band");
  assert.equal(terrainPriorityWeight(20), 2, "mountain");
  assert.equal(terrainPriorityWeight(30), 2, "top of the mountain band");
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
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 2 }), null);
  assert.equal(grid.troopsOf(1), 0, "committed troops leave the pool");
  conflict.processTick();

  assert.equal(grid.tileCountOf(2), 1, "the defended tile is not taken");
  assert.equal(grid.troopsOf(1), 1.5, "2 committed troops return as 1.5 (25% malus)");
  assert.equal(conflict.activeAttackCount, 0, "the blocked attack ends");
});

test("a front blocked against neutral land refunds troops in full", () => {
  // tile 1 is heavily fortified neutral land (a strong defense post drives its
  // capture cost above 3); 3 committed troops can't take it. Retreating from
  // neutral land (TerraNullius) is free — full refund, no malus.
  const grid = new TerritoryGrid(flatLand(2, 1));
  grid.addPlayer(1, 3);
  grid.claim(0, 1);
  grid.addDefensePost(1, 1, 5); // factor 5 at the tile -> cost ceil(1*0.9*0.8*5)=4
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 3 }), null);
  conflict.processTick();

  assert.equal(grid.ownerOf(1), NEUTRAL_PLAYER, "the fortified tile is not taken");
  assert.equal(grid.troopsOf(1), 3, "all 3 troops return — neutral retreat is free");
});

test("a defense post fortifies the ground around it, slowing a conquest", () => {
  // 6x1 flat line, player 1 on tile 0 with exactly enough troops (5 tiles ×
  // mag/5 = 80) to walk the five neutral tiles — and win — on open ground.
  const build = () => {
    const grid = new TerritoryGrid(flatLand(6, 1));
    grid.addPlayer(1, 80);
    grid.claim(0, 1);
    freezeIncome(grid);
    return grid;
  };

  const open = build();
  const openConflict = new RasterConflict(open);
  assert.equal(openConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 80 }), null);
  runTicks(openConflict, 30);
  assert.equal(open.tileCountOf(1), 6, "on open ground the whole line falls");
  assert.equal(openConflict.winner, 1);

  // Same troops, but tile 5 is a defense post (radius 2, strength 3): tiles 4 and
  // 5 now cost more, so the troops can't reach the far end.
  const fortified = build();
  fortified.addDefensePost(5, 2, 3);
  const fortConflict = new RasterConflict(fortified);
  assert.equal(fortConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 80 }), null);
  runTicks(fortConflict, 30);
  assert.equal(fortified.ownerOf(5), NEUTRAL_PLAYER, "the fortified tile holds out");
  assert.ok(fortified.tileCountOf(1) < 6, `the post stalls the conquest, owns ${fortified.tileCountOf(1)}`);
  assert.equal(fortConflict.winner, null);
});

test("a freshly-seated nation is immune from attack until its window elapses", () => {
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1, 5000);
  grid.addPlayer(2, 5000);
  grid.claim(0, 1);
  grid.claim(1, 2);
  grid.claim(2, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  // Player 2 is granted a 5-tick spawn immunity: assaults on them are refused.
  conflict.grantImmunity(2, 5);
  assert.equal(conflict.isImmune(2), true, "player 2 is immune");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 5000 }), "IMMUNE");

  // Once the window elapses, the same assault is accepted.
  for (let i = 0; i < 5; i += 1) conflict.processTick();
  assert.equal(conflict.isImmune(2), false, "immunity has lapsed");
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 5000 }), null, "the attack is now allowed");
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
