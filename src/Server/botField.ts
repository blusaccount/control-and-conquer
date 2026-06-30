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
 * Most opponents a solo match can seat (the session caps total nations at 32, so
 * up to 31 bots alongside the human). Difficulty picks how many actually spawn.
 */
export const MAX_RASTER_BOTS = 31;

/**
 * Smallest field seated per difficulty — the floor used on tiny maps like the
 * Classic world sketch. Bigger maps grow well past this (see {@link scaleBotCount}).
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
