/**
 * Tuning constants for the raster (pixel) conflict engine.
 *
 * Like `conflictConfig.ts` for the polygon engine, these are Core simulation
 * constants and intentionally carry no dependency on server scheduling. They
 * describe *our* organic border-expansion combat model:
 *
 *   - Players hold a single troop **pool**; owning more tiles generates more
 *     income each tick.
 *   - Attacks spend committed troops to capture capturable tiles along the
 *     attacker's border, one BFS "ring" at a time, so fronts grow organically.
 *   - Capturing higher ground or enemy-held tiles costs more troops than
 *     claiming flat neutral land.
 */

import { CITY_MAX_TROOP_INCREASE } from "./buildings.js";

// ---------------------------------------------------------------------------
// Population / troops (OpenFront's max-population + bell-curve growth model).
//
// A single troop **pool** per player (OpenFront has no worker/troop split). Its
// ceiling rises sub-linearly with territory and flatly with cities; growth is a
// bell curve that peaks partway to the ceiling and tapers to zero at it. All
// constants and formula shapes mirror OpenFront's `maxTroops`/`troopIncreaseRate`
// (documented behaviour, not ported code).
// ---------------------------------------------------------------------------

/** Flat floor term inside the max-population formula (OpenFront's 50 000). */
export const MAX_POP_FLAT = 50_000;
/** Per-tile scale inside the max-population formula (OpenFront's 1000). */
export const MAX_POP_LAND_SCALE = 1_000;
/** Sub-linear land exponent in the max-population formula (OpenFront's 0.6). */
export const MAX_POP_LAND_EXPONENT = 0.6;

/**
 * Maximum troop pool for an empire of `tiles` tiles holding `cities` cities,
 * mirroring OpenFront's `maxTroops`: a sub-linear land term (so each extra tile
 * lifts the ceiling by ever less) plus a flat floor, doubled, plus a flat
 * per-city increase. Cities are the deliberate way to raise the cap —
 * {@link CITY_MAX_TROOP_INCREASE} each — not a per-tick troop dividend.
 */
export const maxTroops = (tiles: number, cities = 0): number =>
  2 * (Math.pow(Math.max(0, tiles), MAX_POP_LAND_EXPONENT) * MAX_POP_LAND_SCALE + MAX_POP_FLAT) +
  Math.max(0, cities) * CITY_MAX_TROOP_INCREASE;

/**
 * Troops added to a pool in a single tick, mirroring OpenFront's bell-curve
 * growth: a base that itself rises sub-linearly with the current pool, scaled by
 * how far the pool sits below its ceiling `max`. Growth is therefore slow when
 * the pool is tiny, peaks in the mid-range, and tapers to 0 at the cap. Never
 * negative; the caller clamps the running pool to `max`.
 */
export const troopGrowth = (troops: number, max: number): number => {
  if (max <= 0) return 0;
  const t = Math.max(0, troops);
  const base = 10 + Math.pow(t, 0.73) / 4;
  return Math.max(0, base * (1 - t / max));
};

/**
 * Troops generated per second by a player — the figure the leaderboard shows as
 * "(+N/s)". Derived directly from the real per-tick {@link troopGrowth} at the
 * empire's current pool and territory-scaled ceiling, so the displayed rate
 * matches the growth a player actually sees: it tapers toward 0 as the empire
 * fills up. `incomeMultiplier` folds in any per-player income modifier; `cities`
 * lifts the ceiling; `ticksPerSecond` converts the per-tick add to seconds.
 */
export const troopsPerSecond = (
  tiles: number,
  troops: number,
  ticksPerSecond: number,
  incomeMultiplier = 1,
  cities = 0,
  troopCapMultiplier = 1,
): number =>
  troopGrowth(troops, maxTroops(tiles, cities) * troopCapMultiplier) * incomeMultiplier * ticksPerSecond;

/**
 * Fraction of the map's capturable land a single player must hold to win by
 * **domination**, mirroring OpenFront's FFA win condition (community-documented
 * as controlling 80% of total land; openfrontpro.com/mechanics/winning and the
 * OpenFront wiki, 2026-07). Requiring every last tile made matches drag through
 * a long, foregone mop-up phase; at the threshold the match ends immediately
 * and the leader is crowned. Team modes use a higher bar (OpenFront: 95%) —
 * a future team PR should carry its own constant.
 */
export const WIN_TILE_FRACTION = 0.8;

/**
 * A defender is finished off outright once an attack has pushed it below this
 * many tiles: the attacker sweeps up its remaining territory (bordering tiles
 * to the attacker, isolated pockets to any bordering non-friendly player) —
 * OpenFront's `handleDeadDefender` (`numTilesOwned() < 100` → `conquerPlayer`).
 * Kills feel decisive and matches never drag through a foregone mop-up of a
 * nation's last scraps.
 */
export const DEAD_DEFENDER_MAX_TILES = 100;

/**
 * Radius (in tiles, Euclidean) of the **founding blob** a spawn claims,
 * mirroring OpenFront's `getSpawnTiles` (`euclDistFN(tile, 4)`): picking a
 * start position seats the nation on every connected, capturable, unclaimed
 * land tile within this distance of the pick (~49 tiles on open plains) rather
 * than a single pixel. This is what makes freshly-placed nations *visible* on
 * the map during the spawn phase and gives the opening land-grab its OpenFront
 * scale — a new nation is a small blob with a readable border, not a lone dot.
 * The blob is clipped by coastline/mountains/other owners, exactly as
 * OpenFront clips a shore spawn.
 */
export const SPAWN_BLOB_RADIUS = 4;

/**
 * Seconds of **spawn immunity** a freshly-seated nation gets, mirroring
 * OpenFront's post-spawn protection: for this window the player's tiles can't be
 * attacked (by land or sea), so a new spawn isn't instantly steamrolled by a
 * neighbouring snowball before it can establish a border. Kept in seconds (a pure
 * gameplay rule, independent of tick rate); the engine is granted the equivalent
 * tick count when a player is seated.
 */
export const SPAWN_IMMUNITY_SECONDS = 5;

/**
 * Fraction of troops lost on a **retreat**, mirroring OpenFront's
 * `malusForRetreat` (25). In OpenFront this malus is charged only where a
 * retreat is "your call": a player-ordered pull-back from an enemy, and a
 * transport ship arriving at a shore that already belongs to you (its assault
 * evaporated mid-voyage). An attack that simply runs out of reachable tiles
 * retreats **free** (`retreat()` with malus 0), and one that bleeds out below a
 * single troop just dies — nothing comes home at all.
 */
export const RETREAT_MALUS_FRACTION = 0.25;

/**
 * Combat penalty on **fallout** ground, OpenFront's `falloutDefenseModifier`:
 * both the attacker's per-tile loss magnitude and the tile's advance-budget
 * drain are multiplied by `5 − 2·falloutRatio`, where `falloutRatio` is the
 * fraction of the map's land currently irradiated. Nuked wasteland is
 * reclaimable but dear and slow (×5 on a pristine map, easing toward ×3 as the
 * whole world glows) — the OpenFront denial zone, without ever being
 * permanently un-capturable.
 */
export const FALLOUT_MODIFIER_BASE = 5;
export const FALLOUT_MODIFIER_RATIO_SCALE = 2;
export const falloutCombatModifier = (falloutRatio: number): number =>
  FALLOUT_MODIFIER_BASE - FALLOUT_MODIFIER_RATIO_SCALE * Math.min(1, Math.max(0, falloutRatio));

/**
 * How long (ticks) a player stays a **traitor** after betraying an alliance,
 * mirroring OpenFront's `traitorDuration` (300). Betrayal is powerful but marked:
 * for this window the traitor is punished in combat (see the two debuffs below),
 * so backstabbing an ally carries a real, temporary cost.
 */
export const TRAITOR_DURATION_TICKS = 300;

/**
 * Combat penalty on a **traitor defender**, mirroring OpenFront's
 * `traitorDefenseDebuff` (0.5): while marked, the traitor's tiles cost an attacker
 * only half the usual magnitude — its defence is halved, so an ally it stabbed (or
 * anyone) can punish it far more cheaply. Applied to the tile magnitude for a
 * traitor target.
 */
export const TRAITOR_DEFENSE_DEBUFF = 0.5;

/**
 * The second penalty on a **traitor defender**, mirroring OpenFront's
 * `traitorSpeedDebuff` (0.8): while marked, capturing one of the traitor's tiles
 * consumes only 0.8× the usual advance budget (see {@link enemySpeedCost}), so
 * fronts *roll over a traitor faster* on top of costing less. In OpenFront both
 * traitor debuffs sit on the defender side (`attackLogic` checks
 * `defender.isTraitor()` for each); the traitor's own assaults are unaffected.
 */
export const TRAITOR_SPEED_DEBUFF = 0.8;

// ---------------------------------------------------------------------------
// Combat model
//
// An independent, clean-room reimplementation of the openfront-style combat
// mechanics, written from the publicly documented behaviour (the OpenFront wiki
// and gameplay guides) — NOT ported from OpenFront's source, which is AGPL-3.0.
// No OpenFront code or assets are used here; only the (uncopyrightable) game
// rules and formula shapes are reproduced, with our own constants. This keeps
// the project freely (re)licensable.
//
// Per captured tile the attacker spends `captureCost` troops; the defender (if a
// player) bleeds `defenderLossPerTile` troops. Both mirror OpenFront's
// attacker/defender troop-loss split:
//
//   attackerLoss = base · terrainFactor · ATTACKER_EFFICIENCY · garrisonFactor · fortifications
//   defenderLoss = defenderTroops / defenderTiles            (density)
//
// and the front's advance rate scales with the attacker's troop advantage.
// ---------------------------------------------------------------------------

/**
 * Flat attacker efficiency (OpenFront's ~20% attacker bonus): the attacker loses
 * 0.8× the nominal per-tile magnitude, so committing to an assault is a touch
 * cheaper than the raw terrain/garrison maths imply.
 */
export const ATTACKER_EFFICIENCY = 0.8;

/**
 * Terrain combat profile by elevation band, mirroring OpenFront's
 * plains/highland/mountain `mag`/`speed` pairs. `mag` is the per-tile troop-loss
 * magnitude (higher ground costs the attacker more); `speed` biases how fast the
 * front rolls through. Land elevation runs 0–30 (see `terrainCodec`), bucketed by
 * the two thresholds into three bands; magnitude 31 is impassable (never owned or
 * attacked), matching OpenFront's encoding.
 */
export const TERRAIN_PLAINS_MAX_ELEVATION = 9;
export const TERRAIN_HIGHLAND_MAX_ELEVATION = 19;
export interface TerrainCombat {
  /** Per-tile troop-loss magnitude. */
  readonly mag: number;
  /** Advance-rate bias (higher = the front moves through faster). */
  readonly speed: number;
}
export const TERRAIN_COMBAT_PLAINS: TerrainCombat = { mag: 80, speed: 16.5 };
export const TERRAIN_COMBAT_HIGHLAND: TerrainCombat = { mag: 100, speed: 20 };
export const TERRAIN_COMBAT_MOUNTAIN: TerrainCombat = { mag: 120, speed: 25 };

/** Combat profile (mag/speed) for a tile's terrain, by its land elevation (0–30). */
export const terrainCombat = (elevation: number): TerrainCombat => {
  if (elevation <= TERRAIN_PLAINS_MAX_ELEVATION) return TERRAIN_COMBAT_PLAINS;
  if (elevation <= TERRAIN_HIGHLAND_MAX_ELEVATION) return TERRAIN_COMBAT_HIGHLAND;
  return TERRAIN_COMBAT_MOUNTAIN;
};

/** Divisor for the attacker's per-tile loss when claiming neutral land (mag/5). */
export const NEUTRAL_LOSS_DIVISOR = 5;
/** Weights blending the troop-ratio loss term with the defender-density term. */
export const ATTACK_RATIO_LOSS_WEIGHT = 0.6;
export const ATTACK_DENSITY_LOSS_WEIGHT = 0.4;
/** Multiplier on the density term of the attacker's per-tile loss (OpenFront's 1.3). */
export const ATTACK_DENSITY_FACTOR = 1.3;

/**
 * Garrison-strength clamp bounds for {@link defenderStrengthFactor}. The cost an
 * attacker pays per captured tile scales with the ratio of the *defender's*
 * troops to the attacking force, clamped to a band (OpenFront's clamped troop
 * ratio): a defender holding a large army relative to the assault makes every
 * tile dearer (up to {@link DEFENDER_STRENGTH_MAX}×), grinding an under-committed
 * poke to a halt; an overwhelming assault floors the factor at
 * {@link DEFENDER_STRENGTH_MIN}× and rolls through. This is what gives a
 * stockpiled troop pool real *defensive* value.
 *
 * The {@link DEFENDER_STRENGTH_MAX} cap is **deliberately** tighter than the
 * fort/defense-post ceiling (`FORT_DEFENSE_STRENGTH`× in `buildings.ts`): this axis scales
 * with a raw *troop advantage*, which the runaway leader has in abundance, so
 * capping it keeps a trailing player able to dislodge a stockpiled empire (an
 * uncapped troop-ratio defence would harden the snowball into an unbeatable
 * turtle). Forts are the *uncapped* defensive axis on purpose — they cost gold
 * and a tile, a deliberate investment rather than a side effect of hoarding.
 */
export const DEFENDER_STRENGTH_MIN = 0.6;
export const DEFENDER_STRENGTH_MAX = 2.0;

/**
 * Capture-cost multiplier from the defender's relative strength: the defender's
 * current troop pool divided by the attacking force, clamped to
 * [{@link DEFENDER_STRENGTH_MIN}, {@link DEFENDER_STRENGTH_MAX}]. At parity it is
 * ~1 (no change); a defender far stronger than the assault drives it toward the
 * max (each tile costs the attacker much more); an attacker far stronger drives
 * it toward the min. A spent-out attacking force (`attackerTroops <= 0`) yields
 * the max — there is nothing left to push with.
 */
export const defenderStrengthFactor = (defenderTroops: number, attackerTroops: number): number => {
  if (attackerTroops <= 0) return DEFENDER_STRENGTH_MAX;
  const ratio = Math.max(0, defenderTroops) / attackerTroops;
  return Math.min(DEFENDER_STRENGTH_MAX, Math.max(DEFENDER_STRENGTH_MIN, ratio));
};

/**
 * Troops the attacker loses to capture one *enemy* tile, mirroring OpenFront's
 * `attackLogic`: a blend of (a) the clamped defender/attacker troop ratio times
 * the terrain magnitude and the flat attacker bonus, and (b) the defender's troop
 * density spread over the magnitude. `mag` is the tile's magnitude *after* any
 * defensive multipliers (defense post, fortress wall). A weak, thinly-spread
 * defender is cheap to roll over; a dense, well-garrisoned one is dear — so a
 * stockpiled army has real defensive value and high ground costs more to take.
 */
export const attackerLossPerTile = (
  defenderTroops: number,
  defenderDensity: number,
  attackForce: number,
  mag: number,
): number => {
  const ratioTerm = defenderStrengthFactor(defenderTroops, attackForce) * mag * ATTACKER_EFFICIENCY;
  const densityTerm = ATTACK_DENSITY_FACTOR * defenderDensity * (mag / 100);
  return ATTACK_RATIO_LOSS_WEIGHT * ratioTerm + ATTACK_DENSITY_LOSS_WEIGHT * densityTerm;
};

/** Troops the attacker loses to claim one neutral tile of magnitude `mag` (mag/5). */
export const neutralLossPerTile = (mag: number): number => mag / NEUTRAL_LOSS_DIVISOR;

/**
 * Large-empire defence debuff, mirroring OpenFront's `defenseSig`: a sprawling
 * nation defends each of its tiles *worse*, so the attacker's per-tile loss is
 * scaled down toward {@link LARGE_DEFENDER_LOSS_FLOOR} as the defender's territory
 * grows past {@link LARGE_DEFENDER_MIDPOINT}. This is a deliberate anti-snowball
 * lever: a runaway empire becomes cheaper to chip away at, so it can't harden
 * into an unbeatable turtle. Returns 1 for a small empire (no effect), easing to
 * the floor for a huge one.
 *
 * OpenFront applies the *same* `0.7 + 0.3·defenseSig` curve twice — as
 * `largeDefenderAttackDebuff` on the attacker's troop loss and as
 * `largeDefenderSpeedDebuff` on the tile-budget drain ({@link enemySpeedCost}) —
 * so this one function serves both call sites.
 */
export const LARGE_DEFENDER_MIDPOINT = 150_000;
export const LARGE_DEFENDER_DECAY = Math.LN2 / 50_000;
export const LARGE_DEFENDER_LOSS_FLOOR = 0.7;
const sigmoid = (value: number, decay: number, midpoint: number): number =>
  1 / (1 + Math.exp(-decay * (value - midpoint)));
export const largeDefenderLossFactor = (defenderTiles: number): number => {
  const defenseSig = 1 - sigmoid(Math.max(0, defenderTiles), LARGE_DEFENDER_DECAY, LARGE_DEFENDER_MIDPOINT);
  return LARGE_DEFENDER_LOSS_FLOOR + (1 - LARGE_DEFENDER_LOSS_FLOOR) * defenseSig;
};

/**
 * Large-attacker discount, mirroring OpenFront's `largeAttackBonus`: once an
 * attacker's empire passes {@link LARGE_ATTACKER_TILES}, each tile it takes costs
 * it *less* — `sqrt(LARGE_ATTACKER_TILES / attackerTiles) ^ 0.7`, easing below 1
 * as the empire grows. This is the attacker-side counterpart to the large-empire
 * *defence* debuff: a sprawling power projects force cheaply. Returns 1 for any
 * empire at or below the threshold (no effect on normal-sized games/maps).
 */
export const LARGE_ATTACKER_TILES = 100_000;
export const LARGE_ATTACKER_EXPONENT = 0.7;
export const largeAttackerLossFactor = (attackerTiles: number): number => {
  if (attackerTiles <= LARGE_ATTACKER_TILES) return 1;
  return Math.pow(LARGE_ATTACKER_TILES / attackerTiles, 0.5 * LARGE_ATTACKER_EXPONENT);
};

/**
 * Large-attacker *speed* bonus, mirroring OpenFront's `largeAttackerSpeedBonus`
 * (`(100 000 / attackerTiles)^0.6`): a sprawling attacker's captures consume less
 * of the per-tick advance budget (see {@link enemySpeedCost}), so its fronts roll
 * measurably faster. Separate from {@link largeAttackerLossFactor} — OpenFront
 * applies one to the troop loss and the other to the tile-budget drain. Returns 1
 * at or below the threshold.
 */
export const LARGE_ATTACKER_SPEED_EXPONENT = 0.6;
export const largeAttackerSpeedFactor = (attackerTiles: number): number => {
  if (attackerTiles <= LARGE_ATTACKER_TILES) return 1;
  return Math.pow(LARGE_ATTACKER_TILES / attackerTiles, LARGE_ATTACKER_SPEED_EXPONENT);
};

/**
 * The per-tick **advance budget** of a front, mirroring OpenFront's
 * `attackTilesPerTick`. Against a player the budget scales with the attacker's
 * troop advantage (clamped into a band) and the contested border width; against
 * neutral land it is simply a multiple of the border. `border` is the number of
 * frontier tiles pressed this tick.
 *
 * Crucially this budget is **not** a tile count: each captured tile drains it by
 * that tile's *speed cost* ({@link enemySpeedCost} / {@link neutralSpeedCost},
 * OpenFront's `tilesPerTickUsed`) — typically 3.3–37+ budget units per tile —
 * which is what makes OpenFront fronts creep rather than flood. The engine
 * captures frontier tiles in priority order while the budget stays above zero,
 * so at least one tile falls per tick on an affordable front (OpenFront's
 * `while (numTilesPerTick > 0)` loop behaves identically).
 */
export const ENEMY_TILES_PER_TICK_MIN = 0.01;
export const ENEMY_TILES_PER_TICK_MAX = 0.5;
export const ENEMY_TILES_BORDER_MULT = 3;
export const NEUTRAL_TILES_BORDER_MULT = 2;
export const attackTilesPerTick = (
  defenderTroops: number,
  attackForce: number,
  border: number,
  vsPlayer: boolean,
): number => {
  if (!vsPlayer) return border * NEUTRAL_TILES_BORDER_MULT;
  const advantage = ((5 * attackForce) / Math.max(1, defenderTroops)) * 2;
  const clamped = Math.min(ENEMY_TILES_PER_TICK_MAX, Math.max(ENEMY_TILES_PER_TICK_MIN, advantage));
  return clamped * border * ENEMY_TILES_BORDER_MULT;
};

/**
 * Advance-budget units one captured *enemy* tile drains, mirroring OpenFront's
 * `tilesPerTickUsed` against a player: the defender/attacker troop ratio (over a
 * 5× attacker handicap) clamped to [0.2, 1.5], times the tile's terrain `speed`
 * (16.5/20/25, ×{@link FORT_SPEED_BONUS via buildings} under a defense post).
 * Callers multiply in the defender-side debuffs exactly as OpenFront does:
 * {@link largeDefenderLossFactor} (its `largeDefenderSpeedDebuff`),
 * {@link largeAttackerSpeedFactor} and {@link TRAITOR_SPEED_DEBUFF}. At parity a
 * plains tile drains ~3.3 budget units — against a border·3·0.5 budget that is
 * roughly one tile per 4–5 border tiles per tick, the OpenFront crawl.
 */
export const ENEMY_SPEED_RATIO_MIN = 0.2;
export const ENEMY_SPEED_RATIO_MAX = 1.5;
export const ENEMY_SPEED_RATIO_DIVISOR = 5;
export const enemySpeedCost = (defenderTroops: number, attackForce: number, speed: number): number => {
  const ratio = Math.max(0, defenderTroops) / (ENEMY_SPEED_RATIO_DIVISOR * Math.max(1, attackForce));
  return Math.min(ENEMY_SPEED_RATIO_MAX, Math.max(ENEMY_SPEED_RATIO_MIN, ratio)) * speed;
};

/**
 * Advance-budget units one claimed *neutral* tile drains, mirroring OpenFront's
 * `tilesPerTickUsed` against TerraNullius: `2000·max(10, speed) / attackForce`,
 * clamped to [5, 100]. A big committed force expands markedly faster into empty
 * land than a token grab (cost 5 vs 100 per tile against the flat `border·2`
 * budget), and higher ground is slower to swallow — OpenFront's early-game
 * pacing, where blanketing wilderness takes real time.
 */
export const NEUTRAL_SPEED_NUMERATOR = 2000;
export const NEUTRAL_SPEED_FLOOR = 10;
export const NEUTRAL_SPEED_COST_MIN = 5;
export const NEUTRAL_SPEED_COST_MAX = 100;
export const neutralSpeedCost = (speed: number, attackForce: number): number => {
  const raw = (NEUTRAL_SPEED_NUMERATOR * Math.max(NEUTRAL_SPEED_FLOOR, speed)) / Math.max(1, attackForce);
  return Math.min(NEUTRAL_SPEED_COST_MAX, Math.max(NEUTRAL_SPEED_COST_MIN, raw));
};

/**
 * Floor on the troops a defender loses from their pool for each tile captured
 * from them. The actual bleed is *density-based* (see {@link defenderLossPerTile}):
 * a defender loses troops proportional to how thinly its pool is spread over its
 * territory, mirroring OpenFront's `defender.troops() / defender.numTilesOwned()`.
 * This floor guarantees a captured tile always costs the defender at least this
 * much, so a troop-starved blob still bleeds as it is dismantled.
 */
export const DEFENDER_LOSS_PER_TILE = 1;

/**
 * Density-based troops a defender loses when one of its tiles is captured: its
 * current pool spread over the tiles it holds, floored at {@link DEFENDER_LOSS_PER_TILE}.
 * A dense defender (many troops, little land) bleeds hard per tile lost; a vast,
 * thinly-garrisoned empire barely notices each tile — the OpenFront feel where
 * over-extension is punished. `troops`/`tiles` are the defender's *current* pool
 * and tile count, so the bleed naturally eases as the empire shrinks.
 */
export const defenderLossPerTile = (troops: number, tiles: number): number => {
  if (tiles <= 0) return DEFENDER_LOSS_PER_TILE;
  return Math.max(DEFENDER_LOSS_PER_TILE, troops / tiles);
};

/**
 * Frontier ordering, mirroring OpenFront's tile-capture priority. A land attack
 * captures its frontier in *priority* order (lower = captured sooner), matching
 * OpenFront's `addNeighbors` heap key **exactly**:
 *
 *   priority = (jitter0..7 + 10) · (1 − ownedNeighbours · 0.5 + terrainPriorityWeight/2)
 *            + enqueueTick
 *
 * Three terms, each load-bearing:
 *
 *  - the **surround** term (`ownedNeighbours · 0.5`) pulls a tile hugged by more
 *    of the attacker's own land (a pocket/bay) in first, so the front back-fills
 *    concavities and grows as a smooth radial blob rather than a thin tendril;
 *  - the **terrain** term biases higher ground *later* (plains weight 1,
 *    highland 1.5, mountain 2 → ×1.5/×1.75/×2 on the jitter base), so easy low
 *    ground is eaten before dear peaks;
 *  - the **enqueue-tick** term (`+ tick` when the tile first joined the
 *    frontier) makes the ordering FIFO across frontier generations: a highland
 *    tile that joined the front at tick T outranks any plains tile that joins
 *    ~12+ ticks later, so the front advances layer by layer and never freezes
 *    dead against an elevation contour while low ground remains elsewhere.
 *
 * `jitter` (OpenFront: `nextInt(0, 7)` — an integer 0..6 on a base of 10,
 * rolled once from the attack's own seeded PRNG when the tile is enqueued)
 * scatters captures among otherwise-equal perimeter tiles. Drawn here from the
 * same mechanism: each attack owns a PRNG seeded {@link ATTACK_RNG_SEED}
 * (OpenFront seeds every `AttackExecution` with the same fixed 123), so
 * replays stay identical without any `Math.random`.
 */
export const FRONTIER_SURROUND_WEIGHT = 0.5;
export const FRONTIER_JITTER_BASE = 10;
export const FRONTIER_JITTER_STEPS = 7;

/**
 * Seed of the per-attack PRNG that rolls the frontier tile jitter and the
 * per-tick border jitter — OpenFront seeds every `AttackExecution`'s
 * `PseudoRandom` with this same fixed constant, so each attack replays its
 * jitter stream identically.
 */
export const ATTACK_RNG_SEED = 123;

/**
 * Deterministic border-size jitter added to the frontier width inside the
 * advance-budget formula, OpenFront's `borderSize() + nextInt(0, 5)`: an
 * integer 0..4 rolled per tick from the attack's PRNG.
 */
export const BORDER_JITTER_STEPS = 5;

/**
 * OpenFront's per-band tile-priority weight (plains 1, highland 1.5, mountain 2),
 * which enters the capture-priority key as `weight / 2` — so higher ground sorts
 * *later*. Bucketed by the same elevation thresholds as {@link terrainCombat}.
 */
export const terrainPriorityWeight = (elevation: number): number => {
  if (elevation <= TERRAIN_PLAINS_MAX_ELEVATION) return 1;
  if (elevation <= TERRAIN_HIGHLAND_MAX_ELEVATION) return 1.5;
  return 2;
};

/**
 * Radius (in tiles, Chebyshev) within which a click that lands on un-ownable
 * terrain — open water or impassable rock — snaps to the nearest capturable
 * land tile before the attack is resolved. This is what lets a player target a
 * *territory* rather than pixel-hunt: a click just off a coastline (or on a
 * mountain pixel inside an enemy's land) resolves to the land they obviously
 * meant. Beyond this radius the click is treated as deliberate empty space and
 * rejected, so a tap in the open ocean still does nothing.
 */
export const CLICK_SNAP_RADIUS = 4;

/**
 * How far a *land* attack may reach from the player's territory, in tiles of
 * 4-connected land travel, before a click is treated as an amphibious (boat)
 * order instead.
 *
 * This is the land-vs-boat gate for **neutral** land, mirroring OpenFront's
 * `canAttack`. OpenFront decides a march to a player's tile purely by a shared
 * border (see {@link TerritoryGrid.hasLandBorderWith}); a *neutral* click,
 * though, marches if a bounded corridor of **unowned** land reaches back to the
 * attacker. OpenFront caps that flood fill at ≈200 steps — within it the neutral
 * target is "marchable" and a land attack is launched; beyond it (or when the
 * only corridor threads through someone else's territory) the sensible route is
 * across the water, so a transport ship is sent (see
 * {@link TerritoryGrid.canReachByLand}).
 *
 * On the small procedural/ASCII test maps every tile is well within this radius,
 * so they behave exactly as a contiguous landmass; the bound only bites on the
 * large real-world maps, which is where a coast "across the bay" must become a
 * boat rather than a continent-spanning crawl.
 */
export const LAND_ATTACK_REACH = 200;

/**
 * How many water tiles a bot's amphibious-target scan explores before stopping.
 * A player can boat anywhere within a connected body of water (no distance cap),
 * but a bot autonomously *discovering* targets must bound its search, so it only
 * considers landings reachable within roughly this many tiles of open water of
 * its coast — generous (whole nearby seas and islands), not the entire globe.
 * Only limits bot target discovery; an ordered boat still sails unbounded.
 */
export const SEA_TARGET_SCAN_BUDGET = 3000;

/**
 * How many transport ships a single player may have at sea simultaneously.
 * Mirrors OpenFront's cap of three boats in flight — water assaults are
 * deliberately rationed, so a player commits to a few landings rather than
 * swarming a coast with an unbounded fleet. One ship is launched per click.
 */
export const MAX_TRANSPORT_SHIPS_PER_PLAYER = 3;

/**
 * Tiles a transport ship advances along its water path each tick. The ship
 * crosses visibly over several ticks (at 10 TPS) rather than teleporting, so the
 * shortest route it takes is legible and interceptable in feel.
 */
export const SHIP_TILES_PER_TICK = 1;
