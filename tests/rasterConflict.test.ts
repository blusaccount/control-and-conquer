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

test("a manual retreat dissolves the front — 25% malus off a player, free off neutral (OpenFront)", () => {
  // OpenFront's ordered retreat (the white flag on an outgoing attack): the
  // committed troops come home immediately, taxed `malusForRetreat` (25%) when
  // pulling off a *player*, in full when pulling off neutral land.
  const vsPlayer = new TerritoryGrid(flatLand(2, 1));
  vsPlayer.addPlayer(1, 1000);
  vsPlayer.addPlayer(2, 10);
  vsPlayer.claim(0, 1);
  vsPlayer.claim(1, 2);
  freezeIncome(vsPlayer);
  const conflict = new RasterConflict(vsPlayer);
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 1000 }), null);
  assert.equal(vsPlayer.troopsOf(1), 0, "committed troops leave the pool");
  assert.equal(conflict.orderRetreat(1, 2), 750, "the retreat returns 75% of the force");
  assert.equal(vsPlayer.troopsOf(1), 750);
  assert.equal(conflict.activeAttackCount, 0, "the front is dissolved");
  assert.equal(conflict.orderRetreat(1, 2), null, "no front left to retreat");

  const vsNeutral = new TerritoryGrid(flatLand(2, 1));
  vsNeutral.addPlayer(1, 20);
  vsNeutral.claim(0, 1);
  freezeIncome(vsNeutral);
  const neutralConflict = new RasterConflict(vsNeutral);
  assert.equal(neutralConflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 20 }), null);
  assert.equal(neutralConflict.orderRetreat(1, NEUTRAL_PLAYER), 20, "a neutral retreat is free");
  assert.equal(vsNeutral.troopsOf(1), 20);
});

test("opposing attacks cancel out at launch (OpenFront incoming-attack netting)", () => {
  // Player 2 is already pushing 300 troops into player 1; player 1 counters
  // with 1000. The two forces annihilate man for man at launch: player 2's
  // front is wiped out and player 1's survives with the 700 difference.
  const grid = new TerritoryGrid(flatLand(2, 1));
  grid.addPlayer(1, 1000);
  grid.addPlayer(2, 300);
  grid.claim(0, 1);
  grid.claim(1, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 2, target: 1, troops: 300 }), null);
  assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 1000 }), null);
  assert.equal(conflict.activeAttackCount, 1, "the smaller opposing front is annihilated");
  assert.equal(conflict.orderRetreat(2, 1), null, "player 2's front no longer exists");
  // The surviving front belongs to player 1 and carries only the 700 surplus
  // (its retreat refund is 75% of that).
  assert.equal(conflict.orderRetreat(1, 2), 700 * 0.75, "player 1's front kept the surplus");
});

test("neutral expansion claims a line of tiles ring by ring until domination ends the match", () => {
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

  // A handful more ticks reaches 4 of 5 tiles — the 80% domination threshold —
  // and the match ends there: the last tile is never mopped up.
  runTicks(conflict, 10);
  for (let ref = 0; ref < 4; ref += 1) assert.equal(grid.ownerOf(ref), 1);
  assert.equal(grid.ownerOf(4), NEUTRAL_PLAYER, "the match freezes at the threshold");
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
  // The defender holds 300 tiles so it stays comfortably above the
  // dead-defender threshold (100) and below the 80% domination line (320/400).
  const conquer = (betray: boolean): number => {
    const grid = new TerritoryGrid(flatLand(400, 1));
    grid.addPlayer(1, 6000); // attacker
    grid.addPlayer(2, 60_000); // dense defender holds tiles 1..300 (costly to take)
    grid.claim(0, 1);
    for (let ref = 1; ref <= 300; ref += 1) grid.claim(ref, 2);
    freezeIncome(grid);
    const conflict = new RasterConflict(grid);
    if (betray) conflict.markTraitor(2);
    assert.equal(conflict.launchAttack({ attacker: 1, target: 2, troops: 6000 }), null);
    runTicks(conflict, 120);
    return grid.tileCountOf(1) - 1; // tiles taken from the defender
  };

  const normal = conquer(false);
  const vsTraitor = conquer(true);
  assert.ok(normal > 0 && normal < 300, `the baseline assault should stall partway, took ${normal}`);
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

test("a strong garrison bleeds out the very assault a weak one cannot", () => {
  // A long line: player 1 (tile 0) attacks player 2 (tiles 1..300) with the same
  // small force in both runs. The only difference is how heavily player 2 is
  // garrisoned — which is exactly what should decide how far the attack gets.
  // Under OpenFront's rules an attack always takes ground while it has a troop
  // left, so a dense garrison shows its value by grinding the assault down to
  // nothing within a handful of tiles, not by blocking the first one.
  const build = (defenderTroops: number) => {
    const grid = new TerritoryGrid(flatLand(400, 1));
    grid.addPlayer(1, 4000);
    grid.addPlayer(2, defenderTroops);
    grid.claim(0, 1);
    for (let ref = 1; ref <= 300; ref += 1) grid.claim(ref, 2);
    freezeIncome(grid);
    return { grid, conflict: new RasterConflict(grid) };
  };

  // Weak garrison: a 4000-troop assault rolls cheaply through thinly-held land.
  const weak = build(500);
  assert.equal(weak.conflict.launchAttack({ attacker: 1, target: 2, troops: 4000 }), null);
  runTicks(weak.conflict, 30);
  const weakLost = 300 - weak.grid.tileCountOf(2);
  assert.ok(weakLost >= 25, `a thinly-held nation loses ground fast, lost ${weakLost}`);

  // Strong garrison: the identical 4000-troop assault pays ~18x more per tile
  // against the dense pool and is spent after a handful of captures.
  const strong = build(100_000);
  assert.equal(strong.conflict.launchAttack({ attacker: 1, target: 2, troops: 4000 }), null);
  runTicks(strong.conflict, 30);
  const strongLost = 300 - strong.grid.tileCountOf(2);
  assert.ok(strongLost > 0 && strongLost <= 25, `a well-garrisoned nation barely bends, lost ${strongLost}`);
  assert.ok(strongLost < weakLost, "garrison density decides how deep the same assault bites");
  assert.equal(strong.conflict.activeAttackCount, 0, "the spent assault dissolves");
});

test("two fronts dismantle a defender faster than one (each captured tile bleeds the shared pool)", () => {
  // A long line: player 1 (tile 0) and player 2 (tile 301) flank defender
  // player 3, who holds tiles 1..300 with a pool both assaults can afford to
  // chip. Mirroring OpenFront, the dilution is emergent: every tile a front
  // takes bleeds the defender's shared pool, so two fronts capturing at once
  // drain it faster than one — the pincer eats more ground in the same ticks.
  const build = () => {
    const grid = new TerritoryGrid(flatLand(400, 1));
    grid.addPlayer(1, 4000);
    grid.addPlayer(2, 4000);
    grid.addPlayer(3, 30_000);
    grid.claim(0, 1);
    for (let ref = 1; ref <= 300; ref += 1) grid.claim(ref, 3);
    grid.claim(301, 2);
    freezeIncome(grid);
    return { grid, conflict: new RasterConflict(grid) };
  };

  // One front nibbles from a single side.
  const solo = build();
  assert.equal(solo.conflict.launchAttack({ attacker: 1, target: 3, troops: 4000 }), null);
  runTicks(solo.conflict, 5);
  const soloHeld = solo.grid.tileCountOf(3);

  // A pincer eats from both sides at once, so the defender holds strictly fewer
  // tiles after the same number of ticks.
  const pincer = build();
  assert.equal(pincer.conflict.launchAttack({ attacker: 1, target: 3, troops: 4000 }), null);
  assert.equal(pincer.conflict.launchAttack({ attacker: 2, target: 3, troops: 4000 }), null);
  runTicks(pincer.conflict, 5);
  assert.ok(
    pincer.grid.tileCountOf(3) < soloHeld,
    `a two-front pincer dismantles faster: pincer left ${pincer.grid.tileCountOf(3)}, solo left ${soloHeld}`,
  );
});

test("frontier priority prefers easy low ground over mountains (OpenFront tile weights)", () => {
  // 21x1 strip, attacker in the middle: flat plains to the left, mountains to
  // the right. OpenFront's priority key weighs mountains 2x on the jitter base
  // (10..16 for plains vs 15..24 for mountains), so the bands *overlap* — a
  // single pair can occasionally invert, exactly as in OpenFront — but over a
  // whole run the front must eat far more low ground than high ground.
  const W = 21;
  const terrain = new Uint8Array(W);
  for (let x = 0; x < W; x += 1) {
    terrain[x] = encodeTile({ land: true, shoreline: false, ocean: false, magnitude: x < 10 ? 0 : x === 10 ? 0 : 25 });
  }
  const grid = new TerritoryGrid(new GameMap(W, 1, terrain));
  // 300 troops: enough for all ten 16-troop plains tiles with change for a few
  // 24-troop mountain tiles — if priority ignored terrain, captures would split
  // roughly evenly instead.
  grid.addPlayer(1, 300);
  grid.claim(10, 1);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 300 }), null);
  runTicks(conflict, 40);

  let low = 0;
  let high = 0;
  for (const ref of grid.tilesOf(1)) {
    if (ref < 10) low += 1;
    if (ref > 10) high += 1;
  }
  assert.ok(low > high, `low ground falls first: ${low} plains vs ${high} mountain tiles`);
  assert.ok(low >= 8, `the plains side is nearly cleared, took ${low}`);
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
  grid.addPlayer(1, 2000);
  grid.claim(cy * W + cx, 1);
  const conflict = new RasterConflict(grid);

  // Under the OpenFront advance model a neutral tile drains 5..100 budget units
  // against a `border·2` budget, so the blob needs real time to grow: commit a
  // large force (fast per-tile pace, ~100 affordable tiles) and let it run.
  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 2000 }), null);
  runTicks(conflict, 60);

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

test("an attack always takes at least one tile; a spent force dies with no refund (OpenFront)", () => {
  // 2x1: player 1 (tile 0) attacks player 2 (tile 1) with a token force far
  // below the tile's price. OpenFront has no affordability gate: any attack
  // with a troop left captures its next tile, overdraws its pool, and the
  // moment the pool dips under 1 the attack simply dies — nothing comes home.
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

  assert.equal(grid.ownerOf(1), 1, "even a token assault takes its first tile");
  assert.equal(grid.troopsOf(1), 0, "the overdrawn force is spent — no refund");
  assert.equal(conflict.activeAttackCount, 0, "the dead attack is gone");
});

test("a front whose ground vanishes retreats free — full refund, no malus (OpenFront)", () => {
  // 3x1: players 1 (tile 0) and 2 (tile 2) race for the single neutral tile 1.
  // Player 1's attack is processed first and takes it; player 2's attack then
  // finds an empty frontier. OpenFront's retreat() on a ran-out-of-ground front
  // charges NO malus — the malus is reserved for deliberate pull-backs — so
  // player 2's committed troops come home in full.
  const grid = new TerritoryGrid(flatLand(3, 1));
  grid.addPlayer(1, 20);
  grid.addPlayer(2, 20);
  grid.claim(0, 1);
  grid.claim(2, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  assert.equal(conflict.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 20 }), null);
  assert.equal(conflict.launchAttack({ attacker: 2, target: NEUTRAL_PLAYER, troops: 20 }), null);
  conflict.processTick();

  assert.equal(grid.ownerOf(1), 1, "player 1's attack takes the contested tile");
  assert.equal(grid.troopsOf(2), 20, "player 2's stranded front refunds in full — no malus");
});

test("a defense post fortifies the ground around it, slowing a conquest", () => {
  // A 200x4 field: player 1 holds column 0, player 2 columns 1..150 (600
  // tiles) with an empty pool (so per-tile costs stay at the strength-factor
  // floor). On open ground a plains tile costs ~23.5 troops
  // (0.6·[0.6·80·0.8] + 0.4·[1.3·1·0.8]); inside a strength-5 post aura it
  // costs ~117 and drains 3x the advance budget, so the same committed force
  // is spent after a fraction of the ground.
  const W = 200;
  const build = () => {
    const grid = new TerritoryGrid(flatLand(W, 4));
    grid.addPlayer(1, 2000);
    grid.addPlayer(2, 0);
    for (let y = 0; y < 4; y += 1) {
      grid.claim(y * W, 1);
      for (let x = 1; x <= 150; x += 1) grid.claim(y * W + x, 2);
    }
    freezeIncome(grid);
    return grid;
  };

  const open = build();
  const openConflict = new RasterConflict(open);
  assert.equal(openConflict.launchAttack({ attacker: 1, target: 2, troops: 2000 }), null);
  runTicks(openConflict, 30);
  const openTaken = open.tileCountOf(1) - 4;
  assert.ok(openTaken >= 30, `on open ground the advance rolls, took ${openTaken}`);

  // Same troops, but player 2 fortifies the near stretch with a defense post
  // at (10, 1) (radius 20, strength 5 — OpenFront's defensePostDefenseBonus):
  // the covered tiles bleed the assault out long before the open run's depth.
  const fortified = build();
  fortified.addDefensePost(W + 10, 20, 5);
  const fortConflict = new RasterConflict(fortified);
  assert.equal(fortConflict.launchAttack({ attacker: 1, target: 2, troops: 2000 }), null);
  runTicks(fortConflict, 30);
  const fortTaken = fortified.tileCountOf(1) - 4;
  assert.ok(fortTaken < openTaken, `the post stalls the conquest: ${fortTaken} vs ${openTaken} open`);
  assert.ok(fortTaken <= 21, `the assault dies inside the aura, took ${fortTaken}`);
  assert.equal(fortConflict.activeAttackCount, 0, "the assault bleeds out against the post");
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

test("domination: holding 80% of the land wins without owning every tile", () => {
  const grid = new TerritoryGrid(flatLand(5, 1));
  grid.addPlayer(1, 10);
  grid.addPlayer(2, 10);
  grid.claim(0, 1);
  grid.claim(1, 1);
  grid.claim(2, 1);
  grid.claim(4, 2);
  freezeIncome(grid);
  const conflict = new RasterConflict(grid);

  conflict.processTick();
  assert.equal(conflict.winner, null, "3 of 5 tiles (60%) is below the threshold");

  grid.claim(3, 1); // 4 of 5 = exactly 80%
  conflict.processTick();
  assert.equal(conflict.winner, 1, "80% of the capturable land wins by domination");
  assert.equal(grid.ownerOf(4), 2, "the hold-out keeps its tile — the match simply ends");
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

test("a Bot claims neutral land at half cost (OpenFront's mag/10)", () => {
  // Two identical 12-tile flat rows. Same committed troops toward neutral land;
  // the Bot (neutralCostMultiplier 0.5) captures roughly twice as far as a
  // normal attacker before the assault is spent out.
  const build = (neutralMult: number): TerritoryGrid => {
    const grid = new TerritoryGrid(flatLand(12, 1));
    grid.addPlayer(1, 80);
    grid.claim(0, 1);
    grid.setModifiers(1, { ...IDENTITY_MODIFIERS, income: 0, neutralCostMultiplier: neutralMult });
    return grid;
  };

  const normal = build(1);
  const nc = new RasterConflict(normal);
  assert.equal(nc.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 80 }), null);
  runTicks(nc, 40);

  const bot = build(0.5);
  const bc = new RasterConflict(bot);
  assert.equal(bc.launchAttack({ attacker: 1, target: NEUTRAL_PLAYER, troops: 80 }), null);
  runTicks(bc, 40);

  assert.ok(
    bot.tileCountOf(1) > normal.tileCountOf(1),
    `the Bot expands further on the same troops (bot ${bot.tileCountOf(1)} vs normal ${normal.tileCountOf(1)})`,
  );
});
