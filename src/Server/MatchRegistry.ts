import { RasterBotController, RASTER_BOT_PERSONALITIES } from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { RasterExpandIntent } from "../Core/types.js";

/**
 * Most opponents a solo match can seat. The session palette holds 6 player
 * slots; the human takes one, leaving 5 for bots.
 */
export const MAX_RASTER_BOTS = 5;

/** Default field of AI opponents — a multi-bot FFA rather than a 1v1 duel. */
export const DEFAULT_RASTER_BOT_COUNT = 4;

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
  ): () => void {
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-raster-solo`;
    const session = new RasterGameSession(options);
    this.activeMatches.set(matchId, session);

    const unsubHuman = session.subscribe(clientId, send);
    this.clientToSession.set(clientId, session);

    const seats = Math.max(0, Math.min(Math.floor(botCount) || 0, MAX_RASTER_BOTS));
    const unsubBots: Array<() => void> = [];
    for (let i = 0; i < seats; i += 1) {
      const personality = RASTER_BOT_PERSONALITIES[i % RASTER_BOT_PERSONALITIES.length];
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
