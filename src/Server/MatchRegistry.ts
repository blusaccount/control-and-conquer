import {
  RasterBotController,
  RASTER_BOT_PERSONALITIES,
  type RasterBotPersonality,
} from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { RasterBuildIntent, RasterExpandIntent } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";

/**
 * Most opponents a solo match can seat (the session caps total nations at 32, so
 * up to 31 bots alongside the human). Difficulty picks how many actually spawn.
 */
export const MAX_RASTER_BOTS = 31;

/** Default field of AI opponents — a multi-bot FFA rather than a 1v1 duel. */
export const DEFAULT_RASTER_BOT_COUNT = 12;

/** Rival nations seated per difficulty — more, harder opponents as it rises. */
export const DIFFICULTY_BOT_COUNT: Record<RasterDifficulty, number> = {
  easy: 6,
  medium: 12,
  hard: 20,
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
   * server-side bots with varied personalities (an FFA, not a duel). `botCount`
   * is clamped to the seats the session can actually fill.
   */
  public joinRasterSolo(
    clientId: string,
    send: RasterMessageHandler,
    options: RasterGameSessionOptions = {},
    botCount: number = DEFAULT_RASTER_BOT_COUNT,
    difficulty: RasterDifficulty = "medium",
  ): () => void {
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-raster-solo`;
    const session = new RasterGameSession(options);
    this.activeMatches.set(matchId, session);

    // The human is seated only once they pick a start position (autoSpawn=false).
    const unsubHuman = session.subscribe(clientId, send, false);
    this.clientToSession.set(clientId, session);

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
