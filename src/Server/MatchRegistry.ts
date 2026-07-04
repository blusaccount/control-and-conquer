import { RasterBotController } from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { resolveHeightmapSessionMap } from "./sessionMap.js";
import { RasterBuildIntent, RasterExpandIntent, RasterNukeIntent } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";
import { SIMULATION_TICK_RATE, SPAWN_PHASE_SECONDS } from "./simulationConfig.js";
import { AiGameSession } from "./aiApi.js";
import { buildFieldConfigs, DIFFICULTY_BOT_COUNT, MAX_FIELD, resolveFieldSize, scaleFieldCount } from "./botField.js";

// Re-exported for callers (e.g. the server entry) that import the field rules
// from here; the rules themselves live in the Node-free `botField` module so a
// browser worker can seat an identical bot field for a local solo match.
export { DIFFICULTY_BOT_COUNT, MAX_FIELD, scaleFieldCount };

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
    fieldOverride?: number,
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
      difficulty,
      ...options,
      ...(heightmap ? { prebuiltMap: heightmap.map, mapName: options.mapName ?? heightmap.name } : {}),
    });
    this.activeMatches.set(matchId, session);

    // The human is seated only once they pick a start position (autoSpawn=false).
    const unsubHuman = session.subscribe(clientId, send, false);
    if (!unsubHuman) {
      // A brand-new session always has a free seat for its first subscriber, so
      // this is unreachable today — guarded defensively rather than trusting it.
      this.activeMatches.delete(matchId);
      return () => {};
    }
    this.clientToSession.set(clientId, session);

    // The AI field: the lobby's requested size (OpenFront's `bots` slider) when
    // given, else scaled to the land the map offers. buildFieldConfigs carves
    // it bot-heavy (a handful of full Nations amid a passive Tribe crowd) and
    // hands each seat its cadence/phase/handicaps — the same logic the browser
    // solo worker uses, so the two seating paths can never drift.
    const total = resolveFieldSize(session.peekGrid().capturableCount, difficulty, fieldOverride);
    const unsubBots: Array<() => void> = [];
    for (const cfg of buildFieldConfigs(total, difficulty, matchId)) {
      unsubBots.push(new RasterBotController(cfg).attach(session));
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

  public queueRasterNuke(clientId: string, intent: RasterNukeIntent): void {
    this.clientToSession.get(clientId)?.queueNuke(clientId, intent);
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

  public renewRasterAlliance(clientId: string, targetId: number): void {
    this.clientToSession.get(clientId)?.renewAlliance(clientId, targetId);
  }

  public donateRaster(clientId: string, targetId: number, resource: "troops" | "gold", percent: number): void {
    this.clientToSession.get(clientId)?.donate(clientId, targetId, resource, percent);
  }

  public retreatRaster(clientId: string, targetId: number): void {
    this.clientToSession.get(clientId)?.retreat(clientId, targetId);
  }

  public setRasterEmbargo(clientId: string, targetId: number, on: boolean): void {
    this.clientToSession.get(clientId)?.setEmbargo(clientId, targetId, on);
  }

  public requestRasterTarget(clientId: string, allyId: number, targetId: number): void {
    this.clientToSession.get(clientId)?.requestTarget(clientId, allyId, targetId);
  }

  public sendRasterEmoji(clientId: string, targetId: number, emoji: number): void {
    this.clientToSession.get(clientId)?.sendEmoji(clientId, targetId, emoji);
  }

  public tickAll(): void {
    for (const session of this.activeMatches.values()) {
      session.tick();
    }
    // Tick AI sessions; remove ones that have ended or been abandoned.
    for (const [gameId, aiSession] of this.aiSessions) {
      aiSession.getSession().tick();
      // Clean up sessions with no agent activity (poll or action) for more than
      // 30 minutes — not sessions merely older than that, so a long-running
      // match an agent is actively playing is never force-destroyed mid-game.
      if (Date.now() - aiSession.lastActivityAt > 30 * 60 * 1000) {
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
