// ---------------------------------------------------------------------------
// Raster lobby message types.
//
// Kept in a dedicated module (per the project's message-type convention) so new
// gameplay messages don't bloat the core `types.ts`. The raster client/server
// message unions in `types.ts` import and fold these in.
// ---------------------------------------------------------------------------

/**
 * Match difficulty — scales the number of rival nations and how hard they play.
 * Four tiers like OpenFront's Easy/Medium/Hard/Impossible: Impossible nations
 * start bigger, grow past full strength and decide roughly twice as often.
 */
export type RasterDifficulty = "easy" | "medium" | "hard" | "impossible";

export const RASTER_DIFFICULTIES: readonly RasterDifficulty[] = ["easy", "medium", "hard", "impossible"];

/** Runtime guard: is `value` a known difficulty id? */
export const isRasterDifficulty = (value: unknown): value is RasterDifficulty =>
  typeof value === "string" && (RASTER_DIFFICULTIES as readonly string[]).includes(value);

/**
 * Client → server: join a match. Sent once when the client connects; the server
 * seats the player only after receiving it.
 */
export interface RasterJoinPayload {
  /**
   * Selected map-choice id (see `mapCatalog`). Optional on the wire: when
   * absent (or unknown) the server falls back to its default map choice.
   */
  mapId?: string;
  /**
   * Chosen difficulty. Optional: when absent (or unknown) the server uses its
   * default. Controls the size and aggression of the AI field.
   */
  difficulty?: RasterDifficulty;
  /**
   * Total AI opponents to seat (bots + nations combined), OpenFront's `bots`
   * slider analogue. Optional: when absent the server auto-scales the field to
   * the map (`scaleFieldCount`). Clamped to `[0, MAX_FIELD]` and split
   * bot-heavy by `splitField`. 0 seats an empty world (sandbox).
   */
  fieldSize?: number;
  /**
   * Join in lockstep mode: instead of streaming snapshots/owner rasters, the
   * server sends a `SERVER_RASTER_LOCKSTEP_START` setup followed by one
   * `SERVER_RASTER_TURN` per tick, and the client simulates locally (see
   * `Core/lockstep.ts`). The server still simulates as the referee.
   */
  lockstep?: boolean;
}

export type RasterJoinClientMessage = { type: "CLIENT_RASTER_JOIN"; payload: RasterJoinPayload };

// ---------------------------------------------------------------------------
// Private lobbies (PvP).
//
// A lobby is a pre-match waiting room identified by a short share code: the
// host creates it with the match settings, friends join with the code, and the
// host starts the match — at which point every member is seated into ONE
// shared lockstep session and receives its `SERVER_RASTER_LOCKSTEP_START`.
// Seats are fixed at start (the replica protocol needs a complete seat list),
// which is why joining is only possible while the lobby is still waiting.
// ---------------------------------------------------------------------------

/** Characters a player display name may use (letters, digits, space, _.'-). */
export const PLAYER_NAME_PATTERN = /^[\p{L}\p{N} _.'-]{1,24}$/u;

/**
 * Shape of a lobby share code on the wire — the single definition the client
 * form, the server validator and tests all check against. (The generator
 * emits 6 chars from a reduced look-alike-free alphabet; the pattern accepts
 * the general shape so the alphabet can evolve without breaking validators.)
 */
export const LOBBY_CODE_PATTERN = /^[A-Z0-9]{4,8}$/;

/** Client → server: open a new lobby with these match settings (sender = host). */
export interface RasterLobbyCreatePayload {
  mapId?: string;
  difficulty?: RasterDifficulty;
  fieldSize?: number;
  /** The host's display name, shown to other members and in-game. */
  name?: string;
}

export type RasterLobbyCreateClientMessage = {
  type: "CLIENT_RASTER_LOBBY_CREATE";
  payload: RasterLobbyCreatePayload;
};

/** Client → server: join the lobby with this share code. */
export interface RasterLobbyJoinPayload {
  code: string;
  name?: string;
}

export type RasterLobbyJoinClientMessage = {
  type: "CLIENT_RASTER_LOBBY_JOIN";
  payload: RasterLobbyJoinPayload;
};

/** Client → server: start the match (host only). */
export type RasterLobbyStartClientMessage = { type: "CLIENT_RASTER_LOBBY_START" };

/** Client → server: leave the lobby before it starts. */
export type RasterLobbyLeaveClientMessage = { type: "CLIENT_RASTER_LOBBY_LEAVE" };

/**
 * Client → server: resume a seat in a running lockstep match after a dropped
 * connection, using the secret token issued in `SERVER_RASTER_LOCKSTEP_START`.
 * The server re-binds the seat to the new socket and replays the full turn
 * backlog so a fresh replica can fast-forward to the live state.
 */
export interface RasterResumePayload {
  token: string;
}

export type RasterResumeClientMessage = { type: "CLIENT_RASTER_RESUME"; payload: RasterResumePayload };

/** One member as shown in the lobby waiting room. */
export interface RasterLobbyMember {
  name: string;
  isHost: boolean;
  /** True on the copy sent to this member (so the client can mark "you"). */
  you: boolean;
}

/** Server → client: the lobby's current waiting-room state (sent on every change). */
export interface RasterLobbyStatePayload {
  code: string;
  mapName: string;
  difficulty: RasterDifficulty;
  members: RasterLobbyMember[];
  /** True on the host's copy — only the host sees the start button. */
  youAreHost: boolean;
}

export type RasterLobbyStateServerMessage = {
  type: "SERVER_RASTER_LOBBY_STATE";
  payload: RasterLobbyStatePayload;
};

/**
 * Server → client: a lobby/resume command failed. `fatal: true` means the
 * client no longer has (or never got) a room or seat on this connection —
 * the UI should drop back to the lobby form instead of string-matching the
 * message text. Non-fatal errors (e.g. a guest pressing start) leave the
 * membership intact.
 */
export type RasterLobbyErrorServerMessage = {
  type: "SERVER_RASTER_LOBBY_ERROR";
  payload: { message: string; fatal?: boolean };
};

/**
 * Client → server: the tile a player picked as their start position during the
 * spawn phase. Sent on the first map click of a run, before they hold any land.
 */
export interface RasterSpawnPayload {
  x: number;
  y: number;
}

export type RasterSpawnClientMessage = {
  type: "CLIENT_RASTER_SELECT_SPAWN";
  payload: RasterSpawnPayload;
};

// ---------------------------------------------------------------------------
// Diplomacy (alliances).
//
// Each carries the *other* nation's engine playerId. The server resolves the
// sender from their socket, so the client only ever names the counterparty.
// ---------------------------------------------------------------------------

/** Client → server: offer an alliance to `targetId` (or accept a crossing offer). */
export interface RasterAllyProposePayload {
  targetId: number;
}

export type RasterAllyProposeClientMessage = {
  type: "CLIENT_RASTER_ALLY_PROPOSE";
  payload: RasterAllyProposePayload;
};

/** Client → server: accept (`accept: true`) or decline a proposal from `targetId`. */
export interface RasterAllyRespondPayload {
  targetId: number;
  accept: boolean;
}

export type RasterAllyRespondClientMessage = {
  type: "CLIENT_RASTER_ALLY_RESPOND";
  payload: RasterAllyRespondPayload;
};

/** Client → server: break an existing alliance with `targetId` (a betrayal). */
export interface RasterAllyBreakPayload {
  targetId: number;
}

export type RasterAllyBreakClientMessage = {
  type: "CLIENT_RASTER_ALLY_BREAK";
  payload: RasterAllyBreakPayload;
};

/**
 * Client → server: vote to renew the alliance with `targetId`. Alliances are
 * time-limited (OpenFront's 5-minute pacts); both sides must vote for the
 * pact's clock to restart.
 */
export interface RasterAllyRenewPayload {
  targetId: number;
}

export type RasterAllyRenewClientMessage = {
  type: "CLIENT_RASTER_ALLY_RENEW";
  payload: RasterAllyRenewPayload;
};

/**
 * Client → server: manually retreat the active attack against `targetId`
 * (0 = neutral land) — OpenFront's ordered retreat (the white flag on an
 * outgoing attack): the front dissolves and its committed troops come home,
 * taxed 25% when pulling off a player, free off neutral land.
 */
export interface RasterRetreatPayload {
  targetId: number;
}

export type RasterRetreatClientMessage = {
  type: "CLIENT_RASTER_RETREAT";
  payload: RasterRetreatPayload;
};

/**
 * Client → server: donate a slice of your own resource to an ally — troops or
 * gold, `percent` (1..100) of your current pool. OpenFront's ally donation;
 * only ever between standing allies.
 */
export interface RasterDonatePayload {
  targetId: number;
  resource: "troops" | "gold";
  percent: number;
}

export type RasterDonateClientMessage = {
  type: "CLIENT_RASTER_DONATE";
  payload: RasterDonatePayload;
};

/**
 * Client → server: set (`on: true`) or lift a trade embargo against
 * `targetId` — no trade ships will route between your ports and theirs while
 * it stands. OpenFront's embargo; also raised automatically on betrayal.
 */
export interface RasterEmbargoPayload {
  targetId: number;
  on: boolean;
}

export type RasterEmbargoClientMessage = {
  type: "CLIENT_RASTER_EMBARGO";
  payload: RasterEmbargoPayload;
};

/**
 * Client → server: ask an ally (`allyId`) to attack `targetId` — OpenFront's
 * target request. The ally sees it as an event/marker and its AI weights the
 * named target; a human ally is simply informed.
 */
export interface RasterTargetRequestPayload {
  allyId: number;
  targetId: number;
}

export type RasterTargetRequestClientMessage = {
  type: "CLIENT_RASTER_TARGET_REQUEST";
  payload: RasterTargetRequestPayload;
};

/**
 * Client → server: flash an emoji over a player's territory — `targetId` is
 * the reacted-to player (yourself for a broadcast). `emoji` is an index into
 * the client's shared emoji set (validated server-side). Pure social signal;
 * it never touches the simulation, only the transient reactions in the snapshot.
 */
export interface RasterEmojiPayload {
  targetId: number;
  emoji: number;
}

export type RasterEmojiClientMessage = {
  type: "CLIENT_RASTER_EMOJI";
  payload: RasterEmojiPayload;
};

/** The emoji set a client may flash, by index (server validates the index range). */
export const RASTER_EMOJIS: readonly string[] = ["👍", "👎", "😂", "😡", "🤝", "🫡", "💀", "🔥"];
