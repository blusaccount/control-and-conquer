import type { RasterBotConfig } from "./RasterBotController.js";
import type { RasterDifficulty } from "../Core/messages.js";
import type { RasterPlayerKind } from "../Core/types.js";

/**
 * Bot-field sizing and difficulty tuning — the rules that decide how many rival
 * nations a solo match seats and how aggressive they are.
 *
 * Split out of {@link MatchRegistry} (which pulls in the Node-only AI HTTP API)
 * so the exact same field logic can run inside a browser Web Worker that hosts a
 * solo match locally. This module is dependency-free and Node-free.
 */

/**
 * OpenFront seats two distinct AI player types: a passive **Bot** ("Tribe") —
 * a low-threat map-filler with a flat, difficulty-independent handicap and a
 * two-word tribal name — and a full-strategy **Nation**, sourced from the map
 * manifest, that builds/allies/expands and takes OpenFront's per-difficulty
 * handicaps (see {@link NATION_START_MANPOWER} et al.). This engine has no
 * map manifest to draw Nations from, so both tiers are procedurally seated
 * here; `"human"` is the connecting player, never an AI seat.
 *
 * The union itself lives in `Core/types.ts` (it is public wire data — every
 * snapshot names each player's class, as OpenFront's player overlay does);
 * re-exported here so seat-plumbing callers keep their import path.
 */
export type { RasterPlayerKind } from "../Core/types.js";

/**
 * Which tier the seat at `seatIndex` plays, given how many **Nation** seats the
 * field opens with. OpenFront seats the two independently — a `bots` count
 * (0–400, default 400) of passive Tribe fillers plus a `nations` count from the
 * map manifest (e.g. 75 on World, 25% on a compact map) — so a real game is
 * **bot-heavy** (~84% Tribes: 400 bots vs 75 nations). We mirror that split:
 * the first `nations` seats are full Nations (they take the most-spread spawn
 * tiles), the rest are Tribe fillers, so the world reads as a dense crowd of
 * passive tribes sprinkled with a handful of dangerous nations — not the
 * even-strength melee an even split produces. See {@link splitField}.
 */
export const kindForSeat = (seatIndex: number, nations: number): RasterPlayerKind =>
  seatIndex < nations ? "nation" : "bot";

/**
 * Fraction of an AI field that is full **Nations** (the rest are Tribe
 * fillers), matching OpenFront's default density: World seats 75 nations
 * alongside 400 bots → 75/475 ≈ 0.16. So a field is ~1 nation per ~5 bots — a
 * few real powers amid a passive crowd.
 */
export const NATION_FIELD_FRACTION = 0.16;

/**
 * Split a total AI field of `total` opponents into {nations, bots} at
 * OpenFront's ~1:5 ratio ({@link NATION_FIELD_FRACTION}), with at least one
 * Nation whenever the field isn't empty (an all-Tribe world has nobody who
 * builds/allies/nukes, which never happens in OpenFront).
 */
export const splitField = (total: number): { nations: number; bots: number } => {
  const t = Math.max(0, Math.floor(total));
  if (t === 0) return { nations: 0, bots: 0 };
  const nations = Math.max(1, Math.round(t * NATION_FIELD_FRACTION));
  return { nations: Math.min(nations, t), bots: t - Math.min(nations, t) };
};

/**
 * Starting troops a **Bot** (Tribe) is seated with — OpenFront's flat
 * `startManpower` for `PlayerType.Bot` (10 000), independent of difficulty
 * (only Nation start manpower scales with difficulty, see
 * {@link NATION_START_MANPOWER}).
 */
export const BOT_START_MANPOWER = 10_000;

/**
 * A Bot's population-ceiling multiplier relative to the same territory-scaled
 * `maxTroops` formula a Nation/human uses — OpenFront divides a Bot's
 * computed ceiling by 3.
 */
export const BOT_TROOP_CAP_MULTIPLIER = 1 / 3;

/** A Bot's troop-growth multiplier — OpenFront halves a Bot's growth rate. */
export const BOT_GROWTH_MULTIPLIER = 0.5;

/**
 * Two-word tribal names for Bot seats (e.g. "Roman Empire", "Hittite
 * Alliance") — civilization-style prefix + suffix, distinct from the curated
 * Nation name list so a Bot reads as a different kind of opponent at a
 * glance. Deterministic (no RNG): combined by seat index with decorrelated
 * strides so nearby seats don't share a prefix or suffix in lockstep.
 */
const TRIBE_NAME_PREFIXES: readonly string[] = [
  "Roman", "Hittite", "Sumerian", "Akkadian", "Babylonian", "Phoenician",
  "Greek", "Persian", "Egyptian", "Numidian", "Thracian", "Scythian",
  "Gothic", "Frankish", "Norman", "Saxon", "Celtic", "Iberian",
  "Mongol", "Khazar", "Cuman", "Avar", "Bulgar", "Magyar",
];

const TRIBE_NAME_SUFFIXES: readonly string[] = [
  "Empire", "Dynasty", "Kingdom", "Sultanate", "Republic", "Caliphate",
  "Realm", "Duchy", "Alliance", "Tribe", "Horde", "League",
];

/** Deterministic two-word tribal name for a Bot seated at `seatIndex` (0-based, seat order). */
export const tribeName = (seatIndex: number): string => {
  const prefix = TRIBE_NAME_PREFIXES[seatIndex % TRIBE_NAME_PREFIXES.length];
  // A stride coprime with the suffix list length decorrelates the pairing
  // from the prefix's own cycle, so consecutive seats don't repeat a pair.
  const suffix = TRIBE_NAME_SUFFIXES[(seatIndex * 5 + 3) % TRIBE_NAME_SUFFIXES.length];
  return `${prefix} ${suffix}`;
};

/**
 * Most AI opponents a solo match seats. OpenFront routinely fields ~475 AI on
 * World (400 bots + 75 nations); our engine caps lower for the browser
 * renderer, but 200 is far past the old 47 and (measured) ~3 ms/tick with 120
 * passive seats, so the world reads as a genuine OpenFront-style crowd rather
 * than a sparse handful. The field scales with the map up to this ceiling
 * (see {@link scaleFieldCount}).
 */
export const MAX_FIELD = 400;

/**
 * @deprecated Kept as an alias of {@link MAX_FIELD} for callers/tests that
 * still import the old name. The 47-seat cap it named is gone.
 */
export const MAX_RASTER_BOTS = MAX_FIELD;

/**
 * Smallest field seated per difficulty — the floor used on the smallest maps and
 * the procedural fallback. Bigger maps grow well past this (see {@link scaleFieldCount}).
 */
export const DIFFICULTY_BOT_COUNT: Record<RasterDifficulty, number> = {
  easy: 20,
  medium: 30,
  hard: 40,
  impossible: 50,
};

// --- AI strength by difficulty ---------------------------------------------
//
// Our AI opponents behave like OpenFront's **nations** (they expand, build and
// fight), so they take OpenFront's per-difficulty nation handicaps rather than
// the passive-bot ÷3. Mapped to our easy/medium/hard onto OpenFront's
// Easy/Medium/Hard tiers: a weaker tier starts smaller, has a lower population
// ceiling, and grows a touch slower. (Hard = full strength, exactly a human.)

/** Starting troops an AI nation is seated with, by difficulty (OpenFront's `startManpower`). */
export const NATION_START_MANPOWER: Record<RasterDifficulty, number> = {
  easy: 12_500,
  medium: 18_750,
  hard: 25_000,
  impossible: 31_250,
};

/** Multiplier on an AI nation's max-population ceiling, by difficulty. */
export const NATION_TROOP_CAP_MULTIPLIER: Record<RasterDifficulty, number> = {
  easy: 0.5,
  medium: 0.75,
  hard: 1,
  impossible: 1.25,
};

/** Multiplier on an AI nation's troop growth (the income modifier), by difficulty. */
export const NATION_GROWTH_MULTIPLIER: Record<RasterDifficulty, number> = {
  easy: 0.9,
  medium: 0.95,
  hard: 1,
  impossible: 1.05,
};

/**
 * Ticks between a **Nation**'s attack decisions, drawn per seat (from the
 * seat's own PRNG, in {@link RasterBotController}) out of OpenFront's
 * per-difficulty `nextInt` bounds — Easy 65–100, Medium 55–70, Hard 45–60,
 * Impossible 30–50 (max exclusive). Nations act deliberately (every ~3–10 s),
 * with Impossible reacting roughly twice as often as Easy. Each seat also
 * rolls a phase offset inside its cadence, so a large field never decides in
 * lockstep (OpenFront's `attackTick`).
 */
export const NATION_DECISION_TICKS: Record<RasterDifficulty, readonly [number, number]> = {
  easy: [65, 100],
  medium: [55, 70],
  hard: [45, 60],
  impossible: [30, 50],
};

/** Ticks between a passive **Bot** (Tribe)'s decisions — OpenFront's `nextInt(40, 80)`. */
export const BOT_DECISION_TICKS: readonly [number, number] = [40, 80];

/**
 * **Land tiles per AI seat**, by difficulty — the field's density anchor,
 * calibrated against the real OpenFront World FFA: 651,609 land tiles
 * (`resources/maps/world/manifest.json`) shared by ~475 AI seats (400 bots +
 * ~75 nations) ≈ **1,370 land tiles per seat**. Medium pins that exact
 * density; Easy spreads seats a little thinner and Hard/Impossible pack them
 * tighter (their harder feel is partly a more crowded map). The old
 * square-root scaling over-seated small maps ~2× (earth-standard came out at
 * ~600 land tiles/seat), which made the opening land-grab end in well under a
 * minute — half the first-five-minutes experience was simply missing.
 */
const LAND_TILES_PER_SEAT: Record<RasterDifficulty, number> = {
  easy: 1600,
  medium: 1370,
  hard: 1150,
  impossible: 1000,
};

/**
 * Total AI opponents to seat for a map of `capturableTiles` land — bots plus
 * nations combined (split bot-heavy by {@link splitField}). **Linear** in the
 * capturable land at the per-difficulty {@link LAND_TILES_PER_SEAT} density,
 * so every map size plays at OpenFront's World density instead of small maps
 * running twice as crowded as large ones; floored per difficulty and capped at
 * {@link MAX_FIELD} (OpenFront's default bot count).
 */
export const scaleFieldCount = (capturableTiles: number, difficulty: RasterDifficulty): number => {
  const byLand = Math.round(Math.max(0, capturableTiles) / LAND_TILES_PER_SEAT[difficulty]);
  return Math.max(DIFFICULTY_BOT_COUNT[difficulty], Math.min(byLand, MAX_FIELD));
};

/**
 * @deprecated Old name for {@link scaleFieldCount}. The field is no longer
 * "bots only" (it's a bot-heavy mix of bots + nations); kept so existing
 * callers/tests keep compiling.
 */
export const scaleBotCount = scaleFieldCount;

/**
 * Build the ordered {@link RasterBotConfig} list for an AI field — the single
 * source of truth both seating paths (the authoritative {@link MatchRegistry}
 * and the browser solo worker) use, so they can never drift.
 *
 * `total` is the AI opponent count (from the lobby's `fieldSize` or
 * {@link scaleFieldCount}); {@link splitField} carves it bot-heavy. The first
 * `nations` seats are full **Nations**, the rest passive **Bot** fillers —
 * there are no per-seat personalities (OpenFront has none): each controller
 * rolls its own cadence, phase and attack ratios from a per-seat PRNG, and the
 * match `difficulty` drives every behavioural gate. `idPrefix` namespaces the
 * bot ids; the seat index doubles as PRNG seed entropy.
 */
export const buildFieldConfigs = (
  total: number,
  difficulty: RasterDifficulty,
  idPrefix: string,
): RasterBotConfig[] => {
  const { nations, bots } = splitField(total);
  const configs: RasterBotConfig[] = [];
  const seats = nations + bots;
  for (let i = 0; i < seats; i += 1) {
    configs.push({
      botId: `${idPrefix}-bot-${i + 1}`,
      kind: kindForSeat(i, nations),
      difficulty,
      seed: i,
    });
  }
  return configs;
};

/**
 * Resolve the AI opponent count for a match: the lobby's explicit `fieldSize`
 * when given (clamped to `[0, MAX_FIELD]`), else the map-scaled default.
 */
export const resolveFieldSize = (
  capturableTiles: number,
  difficulty: RasterDifficulty,
  requested: number | undefined,
): number => {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(0, Math.min(Math.floor(requested), MAX_FIELD));
  }
  return scaleFieldCount(capturableTiles, difficulty);
};
