/**
 * AI REST API — headless game sessions for external AI agents.
 *
 * An AI agent creates a game via HTTP, receives a gameId, then polls the state
 * and submits actions (expand, build, ally) through simple JSON endpoints.
 * The session runs on the same deterministic server tick loop as normal matches.
 *
 * ## Endpoints (all under /api/games)
 *
 *   POST   /api/games                         Create a new game
 *   GET    /api/games/:id                     Get current game state
 *   POST   /api/games/:id/spawn               Select spawn position
 *   POST   /api/games/:id/expand              Expand toward a tile
 *   POST   /api/games/:id/build               Build a structure
 *   POST   /api/games/:id/ally                Alliance action
 *   DELETE /api/games/:id                     Leave / destroy game
 *
 * ## Game state response
 *
 * Every GET /api/games/:id returns an AiGameState object with:
 *   - tick, phase, mapWidth, mapHeight
 *   - me: the AI player's stats
 *   - players: all players' stats
 *   - frontier: tiles the AI can expand toward (the "move list")
 *   - alliances, allianceRequests, recentEvents, winner, matchEnded
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { RasterGameSession, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { RasterBotController, RASTER_BOT_PERSONALITIES } from "./RasterBotController.js";
import { NEUTRAL_PLAYER, type PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterServerMessage,
  RasterSnapshot,
  RasterExpandIntent,
  RasterBuildIntent,
  RasterAlliancePair,
  RasterAllianceRequest,
} from "../Core/types.js";
import { SPAWN_PHASE_SECONDS, SIMULATION_TICK_RATE } from "./simulationConfig.js";
import { resolveHeightmapSessionMap } from "./sessionMap.js";
import { getMapChoice } from "../Core/mapCatalog.js";

export const MAX_AI_SESSIONS = 50;

// ---- Game State Types -------------------------------------------------------

/** Per-player summary included in every state response. */
export interface AiPlayerSummary {
  playerId: number;
  name: string;
  color: string;
  troops: number;
  gold: number;
  tiles: number;
  troopsPerSecond: number;
  goldPerSecond: number;
  cities: number;
  ports: number;
  forts: number;
  factories: number;
  eliminated: boolean;
}

/** A tile the AI agent can expand toward this tick. */
export interface AiFrontierTile {
  /** Tile column. */
  x: number;
  /** Tile row. */
  y: number;
  /**
   * Owner of this frontier tile: 0 = neutral land, positive = a rival player.
   * The AI should prefer 0 (cheap neutral expansion) early and attack rivals
   * once it has a troop advantage.
   */
  targetId: number;
}

/** Full game state returned by GET /api/games/:id. */
export interface AiGameState {
  /** Unique game identifier. */
  gameId: string;
  /** This agent's assigned player id. */
  playerId: number;
  /** Current simulation tick (advances at 10 TPS). */
  tick: number;
  /** "spawn" — pick your start; "playing" — territory is live. */
  phase: string;
  /** Whole seconds left in the spawn phase (0 once playing). */
  spawnRemainingSeconds: number;
  mapWidth: number;
  mapHeight: number;
  /**
   * True once the agent has picked a spawn position (or the spawn phase ended
   * and auto-seating placed them). Before this, `me` will be null and
   * `frontier` will be empty.
   */
  spawned: boolean;
  /** This agent's own player stats, null before spawn is selected. */
  me: AiPlayerSummary | null;
  /** All players (including eliminated ones). */
  players: AiPlayerSummary[];
  /** Active alliances as [lowId, highId] pairs. */
  alliances: RasterAlliancePair[];
  /** Pending alliance proposals (directed from→to). */
  allianceRequests: RasterAllianceRequest[];
  /** Recent match events, newest first. */
  recentEvents: string[];
  /** Winning player id once the match is over, else null. */
  winner: number | null;
  /** Whether the match has ended (conquest or time limit). */
  matchEnded: boolean;
  /**
   * Tiles this agent can expand toward right now (land frontier + sea targets).
   * Empty during the spawn phase or after elimination. Use these as valid targets
   * for POST /api/games/:id/expand — clicking anything outside this list will be
   * rejected.
   */
  frontier: AiFrontierTile[];
  /**
   * A sample of valid spawn positions during the spawn phase. Pick one of these
   * and POST it to /api/games/:id/spawn. Empty once the playing phase begins.
   * Up to 20 land tiles are sampled evenly across the map.
   */
  availableSpawns: Array<{ x: number; y: number }>;
}

// ---- AiGameSession ----------------------------------------------------------

/**
 * A single headless game session controlled by an external AI agent.
 *
 * Subscribes to a RasterGameSession exactly like a browser client but stores
 * state for HTTP polling instead of streaming it over WebSocket.
 */
export class AiGameSession {
  public readonly gameId: string;
  private readonly session: RasterGameSession;
  private readonly clientId: string;
  private playerId: PlayerId | null = null;
  private latestSnapshot: RasterSnapshot | null = null;
  private matchEnded = false;
  private readonly unsubBots: Array<() => void> = [];
  private readonly unsub: () => void;
  /** When the session was created. */
  public readonly createdAt: number;
  /**
   * When the agent last polled or acted on this session — the TTL cleanup uses
   * this, not {@link createdAt}, so a long-running match an agent is actively
   * playing isn't force-destroyed just because it's old.
   */
  public lastActivityAt: number;

  constructor(
    gameId: string,
    options: RasterGameSessionOptions = {},
    botCount: number = 4,
    autoSpawn: boolean = false,
    playerName?: string,
  ) {
    this.gameId = gameId;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.session = new RasterGameSession(options);
    this.clientId = `ai-agent-${gameId}`;

    // Subscribe the AI agent as a player (autoSpawn=false: agent picks spawn via API).
    // A brand-new session always has a free seat for its first subscriber, so
    // the null case is unreachable — guarded defensively rather than trusting it.
    this.unsub = this.session.subscribe(
      this.clientId,
      (msg: RasterServerMessage) => this.onMessage(msg),
      autoSpawn,
      true,
      playerName,
    ) ?? (() => {});

    // Seat bots as opponents
    const botSlots = Math.max(0, Math.min(botCount, 31));
    for (let i = 0; i < botSlots; i++) {
      const personality = RASTER_BOT_PERSONALITIES[i % RASTER_BOT_PERSONALITIES.length];
      const bot = new RasterBotController({ botId: `${gameId}-bot-${i + 1}`, personality });
      this.unsubBots.push(bot.attach(this.session));
    }
  }

  private onMessage(msg: RasterServerMessage): void {
    if (msg.type === "SERVER_RASTER_PLAYER_ASSIGNED") {
      this.playerId = msg.payload.playerId;
    } else if (msg.type === "SERVER_RASTER_SNAPSHOT") {
      this.latestSnapshot = msg.payload;
    } else if (msg.type === "SERVER_RASTER_MATCH_ENDED") {
      if (msg.payload.winnerPlayerId !== null || msg.payload.reason === "timeLimit") {
        this.matchEnded = true;
      }
    }
  }

  /** The underlying game session — exposed so MatchRegistry can tick it. */
  getSession(): RasterGameSession {
    return this.session;
  }

  getPlayerId(): PlayerId | null {
    return this.playerId;
  }

  isEnded(): boolean {
    return this.matchEnded;
  }

  /** Build the full game state snapshot for the HTTP response. */
  getState(): AiGameState {
    const snap = this.latestSnapshot;
    const pid = this.playerId ?? 0;
    const grid = this.session.peekGrid();
    const map = this.session.peekMap();

    const spawned = pid !== 0 && grid.hasPlayer(pid);
    const me = snap?.players.find((p) => p.playerId === pid) ?? null;

    // Compute the frontier: all tiles this agent can expand toward right now.
    // We expose every adjacent capturable tile (not just one sample per target)
    // so the AI has full spatial information about where it can move.
    const frontier: AiFrontierTile[] = [];
    if (spawned && !this.matchEnded && snap?.phase === "playing" && grid.tileCountOf(pid) > 0) {
      const targets = grid.frontierTargets(pid);
      for (const t of targets) {
        const allTiles = grid.frontierOf(pid, t.target);
        for (const ref of allTiles) {
          frontier.push({ x: map.x(ref), y: map.y(ref), targetId: t.target });
        }
      }
    }

    // During the spawn phase, sample open land tiles the agent can spawn on.
    // Up to 20 tiles, evenly strided across the map so they cover the whole map.
    const availableSpawns: Array<{ x: number; y: number }> = [];
    if (snap?.phase === "spawn" && !spawned) {
      const SAMPLE_TARGET = 20;
      const candidates: number[] = [];
      for (let ref = 0; ref < map.size; ref++) {
        if (map.isLand(ref) && !map.isImpassable(ref) && grid.ownerOf(ref) === NEUTRAL_PLAYER) {
          candidates.push(ref);
        }
      }
      const stride = Math.max(1, Math.floor(candidates.length / SAMPLE_TARGET));
      for (let i = 0; i < candidates.length && availableSpawns.length < SAMPLE_TARGET; i += stride) {
        availableSpawns.push({ x: map.x(candidates[i]), y: map.y(candidates[i]) });
      }
    }

    const toSummary = (p: typeof me): AiPlayerSummary | null => {
      if (!p) return null;
      return {
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        troops: p.troops,
        gold: p.gold,
        tiles: p.tiles,
        troopsPerSecond: p.troopsPerSecond,
        goldPerSecond: p.goldPerSecond,
        cities: p.cities,
        ports: p.ports,
        forts: p.forts,
        factories: p.factories,
        eliminated: p.eliminated,
      };
    };

    return {
      gameId: this.gameId,
      playerId: pid,
      tick: snap?.tick ?? 0,
      phase: snap?.phase ?? "spawn",
      spawnRemainingSeconds: snap?.spawnRemainingSeconds ?? 0,
      mapWidth: snap?.width ?? map.width,
      mapHeight: snap?.height ?? map.height,
      spawned,
      me: toSummary(me),
      players: (snap?.players ?? []).map((p) => toSummary(p)!),
      alliances: snap?.alliances ?? [],
      allianceRequests: snap?.allianceRequests ?? [],
      recentEvents: snap?.recentEvents ?? [],
      winner: snap?.winnerPlayerId ?? null,
      matchEnded: this.matchEnded,
      frontier,
      availableSpawns,
    };
  }

  selectSpawn(x: number, y: number): void {
    this.session.selectSpawn(this.clientId, x, y);
  }

  queueExpand(intent: RasterExpandIntent): void {
    this.session.queueExpand(this.clientId, intent);
  }

  queueBuild(intent: RasterBuildIntent): void {
    this.session.queueBuild(this.clientId, intent);
  }

  proposeAlliance(targetId: PlayerId): void {
    this.session.proposeAlliance(this.clientId, targetId);
  }

  respondAlliance(targetId: PlayerId, accept: boolean): void {
    this.session.respondAlliance(this.clientId, targetId, accept);
  }

  breakAlliance(targetId: PlayerId): void {
    this.session.breakAlliance(this.clientId, targetId);
  }

  destroy(): void {
    this.unsub();
    for (const u of this.unsubBots) u();
  }
}

// ---- HTTP Handler -----------------------------------------------------------

/**
 * Reads the full request body as a UTF-8 string. Rejects if body exceeds 64 KB.
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 65536) reject(new Error("Request body too large."));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

const jsonOk = (res: ServerResponse, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
};

const jsonError = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
};

let sessionSequence = 0;

/**
 * Handle all HTTP requests under /api/games/*.
 *
 * Returns true if the request was handled, false if it should fall through
 * to the normal file-serving handler.
 */
export const handleAiApiRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, AiGameSession>,
): Promise<boolean> => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS headers so browser-based AI clients can call without a proxy
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (!path.startsWith("/api/games")) return false;

  // POST /api/games — create a new headless game for an AI agent
  if (path === "/api/games" && method === "POST") {
    if (sessions.size >= MAX_AI_SESSIONS) {
      jsonError(res, 503, "Too many active AI sessions. Try again later.");
      return true;
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      jsonError(res, 400, "Invalid JSON body.");
      return true;
    }

    // Build session options from the request body
    const mapId = typeof body.mapId === "string" ? body.mapId : "earth-standard";
    const botCount = typeof body.botCount === "number" ? Math.max(0, Math.min(31, body.botCount)) : 4;
    const autoSpawn = body.autoSpawn === true;
    const spawnPhase = body.spawnPhase === false ? 0 : SPAWN_PHASE_SECONDS * SIMULATION_TICK_RATE;
    const playerName = typeof body.playerName === "string" && body.playerName.trim()
      ? body.playerName.trim().slice(0, 32)
      : undefined;

    const sessionOpts: RasterGameSessionOptions = { spawnPhaseTicks: spawnPhase };

    // Resolve map choice
    const choice = getMapChoice(mapId);
    if (choice) {
      if (choice.options.realMapId) {
        sessionOpts.realMapId = choice.options.realMapId;
        sessionOpts.mapSize = choice.options.mapSize;
      } else if (choice.options.width) {
        sessionOpts.width = choice.options.width;
        sessionOpts.height = choice.options.height;
        sessionOpts.seed = choice.options.seed;
      }
    } else {
      // Fallback: small procedural map good for fast AI testing
      sessionOpts.width = 80;
      sessionOpts.height = 50;
    }

    // Heightmap maps (e.g. "earth") are built here and injected as a prebuilt map,
    // so the session class stays free of the Node map loaders.
    const heightmap = resolveHeightmapSessionMap(sessionOpts.realMapId, sessionOpts.mapSize);
    if (heightmap) {
      sessionOpts.prebuiltMap = heightmap.map;
      sessionOpts.mapName = sessionOpts.mapName ?? heightmap.name;
    }

    sessionSequence += 1;
    const gameId = `ai-${sessionSequence}-${Date.now()}`;

    try {
      const session = new AiGameSession(gameId, sessionOpts, botCount, autoSpawn, playerName);
      sessions.set(gameId, session);
      jsonOk(res, {
        gameId,
        playerId: session.getPlayerId(),
        message: autoSpawn
          ? "Game started. Your nation was auto-spawned. Poll GET /api/games/:id for state."
          : "Game started. POST /api/games/:id/spawn with {x, y} to choose your start position.",
      });
    } catch (err) {
      jsonError(res, 500, `Failed to create game: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    return true;
  }

  // All other routes need a game id: /api/games/:id[/action]
  const parts = path.split("/");
  // parts: ["", "api", "games", ":id", ":action?"]
  if (parts.length < 4) return false;

  const gameId = parts[3];
  const action = parts[4] ?? "";

  const session = sessions.get(gameId);
  if (session) session.lastActivityAt = Date.now();

  // GET /api/games/:id — current game state
  if (!action && method === "GET") {
    if (!session) {
      jsonError(res, 404, `Game "${gameId}" not found.`);
      return true;
    }
    jsonOk(res, session.getState());
    return true;
  }

  // DELETE /api/games/:id — leave / destroy game
  if (!action && method === "DELETE") {
    if (session) {
      session.destroy();
      sessions.delete(gameId);
    }
    jsonOk(res, { ok: true });
    return true;
  }

  // All POST actions require a valid session
  if (method !== "POST") return false;
  if (!session) {
    jsonError(res, 404, `Game "${gameId}" not found.`);
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    jsonError(res, 400, "Invalid JSON body.");
    return true;
  }

  // POST /api/games/:id/spawn — select spawn position
  if (action === "spawn") {
    const x = typeof body.x === "number" ? Math.round(body.x) : null;
    const y = typeof body.y === "number" ? Math.round(body.y) : null;
    if (x === null || y === null) {
      jsonError(res, 400, "Body must include integer {x, y} coordinates.");
      return true;
    }
    session.selectSpawn(x, y);
    jsonOk(res, { ok: true, message: `Spawn selected at (${x}, ${y}).` });
    return true;
  }

  // POST /api/games/:id/expand — expand toward a tile
  if (action === "expand") {
    const targetX = typeof body.targetX === "number" ? Math.round(body.targetX) : null;
    const targetY = typeof body.targetY === "number" ? Math.round(body.targetY) : null;
    const percent = typeof body.percent === "number" ? Math.round(body.percent) : 50;
    if (targetX === null || targetY === null) {
      jsonError(res, 400, "Body must include {targetX, targetY} tile coordinates and optional percent (1-100).");
      return true;
    }
    session.queueExpand({ targetX, targetY, percent: Math.max(1, Math.min(100, percent)) });
    jsonOk(res, { ok: true, message: `Expand toward (${targetX}, ${targetY}) at ${percent}% queued.` });
    return true;
  }

  // POST /api/games/:id/build — build a structure on an owned tile
  if (action === "build") {
    const targetX = typeof body.targetX === "number" ? Math.round(body.targetX) : null;
    const targetY = typeof body.targetY === "number" ? Math.round(body.targetY) : null;
    const building = typeof body.building === "string" ? body.building : null;
    if (targetX === null || targetY === null || !building) {
      jsonError(res, 400, 'Body must include {targetX, targetY, building}. building: "city"|"port"|"fort"|"factory".');
      return true;
    }
    if (!["city", "port", "fort", "factory"].includes(building)) {
      jsonError(res, 400, 'Unknown building type. Use "city", "port", "fort", or "factory".');
      return true;
    }
    session.queueBuild({ targetX, targetY, building: building as "city" | "port" | "fort" | "factory" });
    jsonOk(res, { ok: true, message: `Build ${building} at (${targetX}, ${targetY}) queued.` });
    return true;
  }

  // POST /api/games/:id/ally — alliance action
  if (action === "ally") {
    const allyAction = typeof body.action === "string" ? body.action : null;
    const targetId = typeof body.targetId === "number" ? Math.round(body.targetId) : null;
    if (!allyAction || targetId === null) {
      jsonError(res, 400, 'Body must include {action, targetId}. action: "propose"|"accept"|"decline"|"break".');
      return true;
    }
    switch (allyAction) {
      case "propose":
        session.proposeAlliance(targetId);
        jsonOk(res, { ok: true, message: `Alliance proposal sent to player ${targetId}.` });
        break;
      case "accept":
        session.respondAlliance(targetId, true);
        jsonOk(res, { ok: true, message: `Alliance with player ${targetId} accepted.` });
        break;
      case "decline":
        session.respondAlliance(targetId, false);
        jsonOk(res, { ok: true, message: `Alliance offer from player ${targetId} declined.` });
        break;
      case "break":
        session.breakAlliance(targetId);
        jsonOk(res, { ok: true, message: `Alliance with player ${targetId} broken.` });
        break;
      default:
        jsonError(res, 400, `Unknown ally action "${allyAction}". Use "propose", "accept", "decline", or "break".`);
    }
    return true;
  }

  return false;
};
