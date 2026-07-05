import { RasterBotController } from "./RasterBotController.js";
import { RasterGameSession, type RasterMessageHandler, type RasterGameSessionOptions } from "./RasterGameSession.js";
import { resolveHeightmapSessionMap } from "./sessionMap.js";
import { RasterBuildIntent, RasterExpandIntent, RasterNukeIntent } from "../Core/types.js";
import type { RasterDifficulty } from "../Core/messages.js";
import type { RasterLockstepStartPayload } from "../Core/lockstep.js";
import {
  LOBBY_SPAWN_PHASE_SECONDS,
  LOCKSTEP_RECONNECT_GRACE_MS,
  SIMULATION_TICK_RATE,
  SPAWN_PHASE_SECONDS,
} from "./simulationConfig.js";
import { AiGameSession } from "./aiApi.js";
import { buildFieldConfigs, DIFFICULTY_BOT_COUNT, MAX_FIELD, resolveFieldSize, scaleFieldCount } from "./botField.js";

/** One member of a waiting lobby (pre-match). */
interface LobbyMember {
  send: RasterMessageHandler;
  name?: string;
}

/** A private waiting room: match settings + members, until the host starts. */
interface RasterLobby {
  code: string;
  hostClientId: string;
  mapChoiceId: string;
  mapName: string;
  options: RasterGameSessionOptions;
  difficulty: RasterDifficulty;
  fieldOverride?: number;
  members: Map<string, LobbyMember>;
}

/** A running lockstep match: the shared session plus per-seat resume state. */
interface LockstepMatch {
  matchId: string;
  session: RasterGameSession;
  /** Setup payload shared by every seat (yourPlayerId/resumeToken are per-seat). */
  setupBase: Omit<RasterLockstepStartPayload, "yourPlayerId" | "resumeToken">;
  /** Resume token → the client id currently bound to that seat. */
  tokens: Map<string, string>;
  /** Client ids with a live socket right now. */
  connected: Set<string>;
  /** Wall-clock of the last moment at least one human was connected. */
  lastConnectedAt: number;
  /** Teardown hooks (bot detach + seat unsubscribes) for the reaper. */
  unsubs: Array<() => void>;
}

/** Human cap per shared lobby (the session seats the AI field on top). */
const MAX_LOBBY_MEMBERS = 8;

/** Share-code alphabet without look-alikes (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const makeLobbyCode = (): string =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");

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
  /** Waiting lobbies by share code. */
  private readonly lobbies = new Map<string, RasterLobby>();
  /** Which lobby a connected client currently sits in. */
  private readonly clientToLobby = new Map<string, RasterLobby>();
  /** Running lockstep matches by match id. */
  private readonly lockstepMatches = new Map<string, LockstepMatch>();
  /** Resume token → its match (tokens are globally unique). */
  private readonly tokenToMatch = new Map<string, LockstepMatch>();
  /** Which lockstep match a connected client is seated in. */
  private readonly clientToLockstep = new Map<string, LockstepMatch>();
  /** Plain (snapshot-streamed) matches: per-client teardown for socket close. */
  private readonly plainCleanup = new Map<string, () => void>();

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
    lockstepMapId?: string,
  ): () => void {
    // A lockstep join (see `Core/lockstep.ts`): the client simulates locally
    // off relayed turns while this server sim referees. `lockstepMapId` names
    // the catalogue map the client must fetch to mirror the session. Shares
    // the whole seating path with lobby matches — a lockstep solo is simply a
    // one-member match.
    if (lockstepMapId !== undefined) {
      this.startLockstepMatch(
        [{ clientId, send }],
        lockstepMapId,
        options,
        difficulty,
        fieldOverride,
        SPAWN_PHASE_SECONDS,
      );
      return () => this.handleSocketClose(clientId);
    }
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-raster-solo`;
    const session = this.createSession(options, difficulty, SPAWN_PHASE_SECONDS);
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

    const unsubBots = this.attachBotField(session, matchId, difficulty, fieldOverride);

    const cleanup = (): void => {
      unsubHuman();
      for (const unsubBot of unsubBots) unsubBot();
      this.clientToSession.delete(clientId);
      this.plainCleanup.delete(clientId);
      this.removeMatchIfEmpty(matchId, session);
    };
    this.plainCleanup.set(clientId, cleanup);
    return cleanup;
  }

  /**
   * Build a session for a match: heightmap maps (e.g. "earth") are resolved
   * here, server-side, and injected as a prebuilt map so the session itself
   * stays free of the Node map loaders. Every match opens with a start phase;
   * callers may still override the length via `options.spawnPhaseTicks`.
   */
  private createSession(
    options: RasterGameSessionOptions,
    difficulty: RasterDifficulty,
    spawnPhaseSeconds: number,
  ): RasterGameSession {
    const heightmap = resolveHeightmapSessionMap(options.realMapId, options.mapSize);
    return new RasterGameSession({
      spawnPhaseTicks: spawnPhaseSeconds * SIMULATION_TICK_RATE,
      difficulty,
      ...options,
      ...(heightmap ? { prebuiltMap: heightmap.map, mapName: options.mapName ?? heightmap.name } : {}),
    });
  }

  /**
   * Seat the AI field: the lobby's requested size (OpenFront's `bots` slider)
   * when given, else scaled to the land the map offers. buildFieldConfigs
   * carves it bot-heavy and hands each seat its cadence/phase/handicaps — the
   * same logic the browser solo worker uses, so seating paths never drift.
   */
  private attachBotField(
    session: RasterGameSession,
    matchId: string,
    difficulty: RasterDifficulty,
    fieldOverride?: number,
  ): Array<() => void> {
    const total = resolveFieldSize(session.peekGrid().capturableCount, difficulty, fieldOverride);
    const unsubBots: Array<() => void> = [];
    for (const cfg of buildFieldConfigs(total, difficulty, matchId)) {
      unsubBots.push(new RasterBotController(cfg).attach(session));
    }
    return unsubBots;
  }

  /**
   * Seat a full lockstep match: every human member as a lockstep subscriber
   * (no snapshots — turns only), then the AI field, then hand each member its
   * `SERVER_RASTER_LOCKSTEP_START` with the complete seat list and a private
   * resume token. Used by both lockstep solo joins and lobby starts.
   */
  private startLockstepMatch(
    members: Array<{ clientId: string; send: RasterMessageHandler; name?: string }>,
    mapChoiceId: string,
    options: RasterGameSessionOptions,
    difficulty: RasterDifficulty,
    fieldOverride: number | undefined,
    spawnPhaseSeconds: number,
  ): void {
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-raster-lockstep`;
    const session = this.createSession(options, difficulty, spawnPhaseSeconds);
    this.activeMatches.set(matchId, session);

    const match: LockstepMatch = {
      matchId,
      session,
      setupBase: {
        mapId: mapChoiceId,
        mapName: session.peekMapName(),
        terrainHash: session.peekTerrainHash(),
        difficulty,
        spawnPhaseTicks: session.peekSpawnPhaseTicks(),
        startingTroops: session.peekStartingTroops(),
        tickRate: SIMULATION_TICK_RATE,
        seats: [], // filled below, once the whole match is seated
      },
      tokens: new Map(),
      connected: new Set(),
      lastConnectedAt: Date.now(),
      unsubs: [],
    };

    for (const member of members) {
      const unsub = session.subscribe(member.clientId, member.send, false, false, member.name, "human", true);
      if (!unsub) continue; // full session — the member simply isn't seated
      match.unsubs.push(unsub);
      const token = (globalThis.crypto as { randomUUID(): string }).randomUUID();
      match.tokens.set(token, member.clientId);
      match.connected.add(member.clientId);
      this.tokenToMatch.set(token, match);
      this.clientToSession.set(member.clientId, session);
      this.clientToLockstep.set(member.clientId, match);
    }
    match.unsubs.push(...this.attachBotField(session, matchId, difficulty, fieldOverride));

    // The seat list must be complete before any setup goes out — the replica
    // protocol has no seat-add event.
    match.setupBase.seats = session.seatList();
    this.lockstepMatches.set(matchId, match);

    for (const [token, clientId] of match.tokens) {
      const member = members.find((m) => m.clientId === clientId);
      member?.send({
        type: "SERVER_RASTER_LOCKSTEP_START",
        payload: {
          ...match.setupBase,
          yourPlayerId: session.playerIdOf(clientId) ?? 1,
          resumeToken: token,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private lobbies (PvP waiting rooms).
  // -------------------------------------------------------------------------

  /** Push the current waiting-room state to every member. */
  private broadcastLobbyState(lobby: RasterLobby): void {
    for (const [memberId, member] of lobby.members) {
      member.send({
        type: "SERVER_RASTER_LOBBY_STATE",
        payload: {
          code: lobby.code,
          mapName: lobby.mapName,
          difficulty: lobby.difficulty,
          youAreHost: memberId === lobby.hostClientId,
          members: [...lobby.members.entries()].map(([id, m]) => ({
            name: m.name ?? "Anonymous",
            isHost: id === lobby.hostClientId,
            you: id === memberId,
          })),
        },
      });
    }
  }

  /** Open a new lobby; the creator becomes host. Returns the share code. */
  public createLobby(
    clientId: string,
    send: RasterMessageHandler,
    mapChoiceId: string,
    mapName: string,
    options: RasterGameSessionOptions,
    difficulty: RasterDifficulty,
    fieldOverride?: number,
    name?: string,
  ): string {
    // One lobby per connection; a second create replaces nothing.
    if (this.clientToLobby.has(clientId) || this.clientToSession.has(clientId)) {
      send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "You are already in a lobby or match." } });
      return "";
    }
    let code = makeLobbyCode();
    while (this.lobbies.has(code)) code = makeLobbyCode();
    const lobby: RasterLobby = {
      code,
      hostClientId: clientId,
      mapChoiceId,
      mapName,
      options,
      difficulty,
      fieldOverride,
      members: new Map([[clientId, { send, name }]]),
    };
    this.lobbies.set(code, lobby);
    this.clientToLobby.set(clientId, lobby);
    this.broadcastLobbyState(lobby);
    return code;
  }

  /** Join a waiting lobby by share code. */
  public joinLobby(clientId: string, send: RasterMessageHandler, code: string, name?: string): void {
    if (this.clientToLobby.has(clientId) || this.clientToSession.has(clientId)) {
      send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "You are already in a lobby or match." } });
      return;
    }
    const lobby = this.lobbies.get(code.toUpperCase());
    if (!lobby) {
      send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "No lobby with that code — it may have started or closed." } });
      return;
    }
    if (lobby.members.size >= MAX_LOBBY_MEMBERS) {
      send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "That lobby is full." } });
      return;
    }
    lobby.members.set(clientId, { send, name });
    this.clientToLobby.set(clientId, lobby);
    this.broadcastLobbyState(lobby);
  }

  /** Leave a waiting lobby. A departing host closes the room for everyone. */
  public leaveLobby(clientId: string): void {
    const lobby = this.clientToLobby.get(clientId);
    if (!lobby) return;
    lobby.members.delete(clientId);
    this.clientToLobby.delete(clientId);
    if (clientId === lobby.hostClientId || lobby.members.size === 0) {
      for (const [memberId, member] of lobby.members) {
        this.clientToLobby.delete(memberId);
        member.send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "The host closed the lobby." } });
      }
      this.lobbies.delete(lobby.code);
      return;
    }
    this.broadcastLobbyState(lobby);
  }

  /** Start the lobby's match (host only): seats every member into one shared
   * lockstep session and dissolves the waiting room. */
  public startLobby(clientId: string): void {
    const lobby = this.clientToLobby.get(clientId);
    if (!lobby) return;
    if (clientId !== lobby.hostClientId) {
      lobby.members.get(clientId)?.send({
        type: "SERVER_RASTER_LOBBY_ERROR",
        payload: { message: "Only the host can start the match." },
      });
      return;
    }
    const members = [...lobby.members.entries()].map(([id, m]) => ({ clientId: id, send: m.send, name: m.name }));
    for (const [memberId] of lobby.members) this.clientToLobby.delete(memberId);
    this.lobbies.delete(lobby.code);
    this.startLockstepMatch(
      members,
      lobby.mapChoiceId,
      { ...lobby.options },
      lobby.difficulty,
      lobby.fieldOverride,
      LOBBY_SPAWN_PHASE_SECONDS,
    );
  }

  /**
   * Resume a lockstep seat on a new connection: re-bind the seat, then send
   * the setup plus the full turn backlog so a fresh replica fast-forwards to
   * the live state and rejoins the per-tick stream.
   */
  public resumeLockstep(clientId: string, send: RasterMessageHandler, token: string): boolean {
    const match = this.tokenToMatch.get(token);
    const oldClientId = match?.tokens.get(token);
    if (!match || oldClientId === undefined) {
      send({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: "That match is no longer running." } });
      return false;
    }
    if (!match.session.rebindSubscriber(oldClientId, clientId, send)) return false;
    match.tokens.set(token, clientId);
    match.connected.delete(oldClientId);
    match.connected.add(clientId);
    match.lastConnectedAt = Date.now();
    this.clientToSession.delete(oldClientId);
    this.clientToLockstep.delete(oldClientId);
    this.clientToSession.set(clientId, match.session);
    this.clientToLockstep.set(clientId, match);

    send({
      type: "SERVER_RASTER_LOCKSTEP_START",
      payload: {
        ...match.setupBase,
        yourPlayerId: match.session.playerIdOf(clientId) ?? 1,
        resumeToken: token,
      },
    });
    send({ type: "SERVER_RASTER_TURN_BACKLOG", payload: { turns: [...match.session.turnBacklog()] } });
    return true;
  }

  /**
   * A socket died. Lobby members leave their room; lockstep seats go mute but
   * stay seated (the sim must play out identically on every replica whether a
   * human is watching or not) and wait for a resume until the grace expires.
   * Returns true when this client was handled here; plain solo matches return
   * false so the caller runs their own teardown.
   */
  public handleSocketClose(clientId: string): boolean {
    if (this.clientToLobby.has(clientId)) {
      this.leaveLobby(clientId);
      return true;
    }
    const match = this.clientToLockstep.get(clientId);
    if (match) {
      match.session.rebindSubscriber(clientId, clientId, () => {});
      match.connected.delete(clientId);
      match.lastConnectedAt = Date.now();
      this.clientToSession.delete(clientId);
      this.clientToLockstep.delete(clientId);
      return true;
    }
    return false;
  }

  /** Reap lockstep matches whose last human left longer than the grace ago. */
  private reapLockstepMatches(): void {
    const now = Date.now();
    for (const [matchId, match] of this.lockstepMatches) {
      if (match.connected.size > 0) continue;
      if (now - match.lastConnectedAt <= LOCKSTEP_RECONNECT_GRACE_MS) continue;
      for (const unsub of match.unsubs) unsub();
      for (const token of match.tokens.keys()) this.tokenToMatch.delete(token);
      this.lockstepMatches.delete(matchId);
      this.activeMatches.delete(matchId);
    }
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
    this.reapLockstepMatches();
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
