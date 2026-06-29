import {
  RasterBotController,
  RASTER_BOT_PERSONALITIES,
  type RasterBotPersonality,
} from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { RasterBuildIntent, RasterExpandIntent } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";
import { SIMULATION_TICK_RATE, SPAWN_PHASE_SECONDS } from "./simulationConfig.js";

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
const scalePersonality = (p: RasterBotPersonality, difficulty: RasterDifficulty): RasterBotPersonality => {
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

/**
 * Manages isolated raster (openfront-style) matches. Each connecting client is
 * dropped straight into its own solo match against a field of server-side bots,
 * so many players can play simultaneously without sharing state.
 *
 * Sessions live keyed by match id and tick together on each scheduler step.
 */
export class MatchRegistry {
  private readonly activeMatches = new Map<string, RasterGameSession>();
  private readonly clientToSession = new Map<string, RasterGameSession>();
  private matchSequence = 0;

  /**
   * Start a SOLO raster match immediately: the human versus a field of
   * server-side bots with varied personalities (an FFA, not a duel). The field
   * size scales with the chosen map — small maps stay a readable handful, large
   * ones fill up (see {@link scaleBotCount}). Pass `botOverride` to force a fixed
   * count instead (e.g. the `RASTER_BOTS` env override); it is clamped to the
   * seats the session can actually fill.
   */
  public joinRasterSolo(
    clientId: string,
    send: RasterMessageHandler,
    options: RasterGameSessionOptions = {},
    difficulty: RasterDifficulty = "medium",
    botOverride?: number,
  ): () => void {
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-raster-solo`;
    // Open every solo match with a start phase: the human gets time to choose a
    // spawn before the game (and the bots) begin taking territory. A caller may
    // still override the length via `options.spawnPhaseTicks`.
    const session = new RasterGameSession({
      spawnPhaseTicks: SPAWN_PHASE_SECONDS * SIMULATION_TICK_RATE,
      ...options,
    });
    this.activeMatches.set(matchId, session);

    // The human is seated only once they pick a start position (autoSpawn=false).
    const unsubHuman = session.subscribe(clientId, send, false);
    this.clientToSession.set(clientId, session);

    // Field size: a fixed override when supplied, otherwise scaled to the land
    // the map actually offers (read straight off the freshly built grid).
    const botCount = botOverride ?? scaleBotCount(session.peekGrid().capturableCount, difficulty);
    const seats = Math.max(0, Math.min(Math.floor(botCount) || 0, MAX_RASTER_BOTS));
    const unsubBots: Array<() => void> = [];
    for (let i = 0; i < seats; i += 1) {
      const base = RASTER_BOT_PERSONALITIES[i % RASTER_BOT_PERSONALITIES.length];
      const personality = scalePersonality(base, difficulty);
      const bot = new RasterBotController({ botId: `${matchId}-bot-${i + 1}`, personality });
      unsubBots.push(bot.attach(session));
    }

    return () => {
      unsubHuman();
      for (const unsubBot of unsubBots) unsubBot();
      this.clientToSession.delete(clientId);
      this.removeMatchIfEmpty(matchId, session);
    };
  }

  public queueRasterExpand(clientId: string, intent: RasterExpandIntent): void {
    this.clientToSession.get(clientId)?.queueExpand(clientId, intent);
  }

  public queueRasterBuild(clientId: string, intent: RasterBuildIntent): void {
    this.clientToSession.get(clientId)?.queueBuild(clientId, intent);
  }

  public selectRasterSpawn(clientId: string, x: number, y: number): void {
    this.clientToSession.get(clientId)?.selectSpawn(clientId, x, y);
  }

  public tickAll(): void {
    for (const session of this.activeMatches.values()) {
      session.tick();
    }
  }

  public getActiveRasterMatchCount(): number {
    return this.activeMatches.size;
  }

  public getPendingRasterExpandCount(): number {
    let total = 0;
    for (const session of this.activeMatches.values()) {
      total += session.getPendingExpandCount();
    }
    return total;
  }

  private removeMatchIfEmpty(matchId: string, session: RasterGameSession): void {
    if (session.getSubscriberCount() === 0) {
      this.activeMatches.delete(matchId);
    }
  }
}
