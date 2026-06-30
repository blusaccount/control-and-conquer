import {
  RasterBotController,
  RASTER_BOT_PERSONALITIES,
} from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { resolveHeightmapSessionMap } from "./sessionMap.js";
import { RasterBuildIntent, RasterExpandIntent } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";
import { SIMULATION_TICK_RATE, SPAWN_PHASE_SECONDS } from "./simulationConfig.js";
import { AiGameSession } from "./aiApi.js";
import { DIFFICULTY_BOT_COUNT, MAX_RASTER_BOTS, scaleBotCount, scalePersonality } from "./botField.js";

// Re-exported for callers (e.g. the server entry) that import the field rules
// from here; the rules themselves live in the Node-free `botField` module so a
// browser worker can seat an identical bot field for a local solo match.
export { DIFFICULTY_BOT_COUNT, MAX_RASTER_BOTS, scaleBotCount };

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
  /** Headless AI sessions — keyed by gameId, ticked alongside normal matches. */
  public readonly aiSessions = new Map<string, AiGameSession>();

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
    // Heightmap maps (e.g. "earth") are built here, server-side, and injected as
    // a prebuilt map so the session itself stays free of the Node map loaders.
    const heightmap = resolveHeightmapSessionMap(options.realMapId, options.mapSize);
    // Open every solo match with a start phase: the human gets time to choose a
    // spawn before the game (and the bots) begin taking territory. A caller may
    // still override the length via `options.spawnPhaseTicks`.
    const session = new RasterGameSession({
      spawnPhaseTicks: SPAWN_PHASE_SECONDS * SIMULATION_TICK_RATE,
      ...options,
      ...(heightmap ? { prebuiltMap: heightmap.map, mapName: options.mapName ?? heightmap.name } : {}),
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

  public proposeRasterAlliance(clientId: string, targetId: number): void {
    this.clientToSession.get(clientId)?.proposeAlliance(clientId, targetId);
  }

  public respondRasterAlliance(clientId: string, targetId: number, accept: boolean): void {
    this.clientToSession.get(clientId)?.respondAlliance(clientId, targetId, accept);
  }

  public breakRasterAlliance(clientId: string, targetId: number): void {
    this.clientToSession.get(clientId)?.breakAlliance(clientId, targetId);
  }

  public tickAll(): void {
    for (const session of this.activeMatches.values()) {
      session.tick();
    }
    // Tick AI sessions; remove ones that have ended or been abandoned.
    for (const [gameId, aiSession] of this.aiSessions) {
      aiSession.getSession().tick();
      // Clean up sessions idle for more than 30 minutes
      if (Date.now() - aiSession.createdAt > 30 * 60 * 1000) {
        aiSession.destroy();
        this.aiSessions.delete(gameId);
      }
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
