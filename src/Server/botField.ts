import type { RasterBotPersonality } from "./RasterBotController.js";
import type { RasterDifficulty } from "../Core/messages.js";

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
 */
export type RasterPlayerKind = "human" | "bot" | "nation";

/**
 * Deterministic split of an AI field into passive Bot filler vs. full-strategy
 * Nation opponents: OpenFront controls the two with independent sliders (Bot
 * count 0–400, Nation count from the map manifest); lacking a manifest, this
 * project instead reserves a fixed fraction of the scaled field for Bots — our
 * own clean-room choice, not a sourced ratio. One seat in three is a Bot, so a
 * field is mostly real opponents with a lighter-weight crowd mixed in.
 */
export const kindForSeat = (seatIndex: number): RasterPlayerKind => (seatIndex % 3 === 2 ? "bot" : "nation");

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
 * Most opponents a solo match can seat (the session caps total nations at 48, so
 * up to 47 bots alongside the human). Difficulty picks how many actually spawn.
 * The cap is high so the larger Earth maps fill with an OpenFront-style crowd
 * rather than topping out early.
 */
export const MAX_RASTER_BOTS = 47;

/**
 * Smallest field seated per difficulty — the floor used on the smallest maps and
 * the procedural fallback. Bigger maps grow well past this (see {@link scaleBotCount}).
 */
export const DIFFICULTY_BOT_COUNT: Record<RasterDifficulty, number> = {
  easy: 4,
  medium: 6,
  hard: 8,
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
};

/** Multiplier on an AI nation's max-population ceiling, by difficulty. */
export const NATION_TROOP_CAP_MULTIPLIER: Record<RasterDifficulty, number> = {
  easy: 0.5,
  medium: 0.75,
  hard: 1,
};

/** Multiplier on an AI nation's troop growth (the income modifier), by difficulty. */
export const NATION_GROWTH_MULTIPLIER: Record<RasterDifficulty, number> = {
  easy: 0.9,
  medium: 0.95,
  hard: 1,
};

/**
 * Land-per-nation density as a square-root divisor, by difficulty: the field
 * grows with the square root of the capturable land divided by this, so a 4×
 * larger map roughly doubles the field rather than quadrupling it. Smaller =
 * denser, so Hard packs more rival nations onto the same map than Easy.
 */
const DIFFICULTY_FIELD_DIVISOR: Record<RasterDifficulty, number> = {
  easy: 24,
  medium: 16,
  hard: 11,
};

/**
 * Number of rival nations to seat for a map of `capturableTiles` land, scaled to
 * the map so small maps (the Classic sketch) stay a readable handful while the
 * large real-world Earth maps fill up with many more nations. The count climbs
 * with the square root of the land available, is floored per difficulty so even
 * tiny maps field some opponents, and is capped at the session's seat limit.
 */
export const scaleBotCount = (capturableTiles: number, difficulty: RasterDifficulty): number => {
  const byLand = Math.round(Math.sqrt(Math.max(0, capturableTiles)) / DIFFICULTY_FIELD_DIVISOR[difficulty]);
  return Math.max(DIFFICULTY_BOT_COUNT[difficulty], Math.min(byLand, MAX_RASTER_BOTS));
};

/**
 * Tilt a personality by difficulty: Easy bots react slower and pick fewer
 * fights; Hard bots react faster and press harder. Medium keeps the preset.
 */
export const scalePersonality = (
  p: RasterBotPersonality,
  difficulty: RasterDifficulty,
): RasterBotPersonality => {
  if (difficulty === "hard") {
    return {
      ...p,
      decisionCooldownTicks: Math.max(4, Math.round(p.decisionCooldownTicks * 0.7)),
      aggression: Math.min(1, p.aggression * 1.3),
    };
  }
  if (difficulty === "easy") {
    return {
      ...p,
      decisionCooldownTicks: Math.round(p.decisionCooldownTicks * 1.4),
      aggression: p.aggression * 0.6,
    };
  }
  return p;
};
