// ---------------------------------------------------------------------------
// Raster (openfront-style) protocol.
//
// The game is a pixel-raster territorial RTS. The server holds the master
// terrain + ownership state and ships:
//   - terrain bytes (one-time, base64-encoded — terrain never changes mid-match)
//   - owner array (every tick, base64-encoded Uint16 little-endian)
//   - per-player standings (troops pool, tile count)
//   - amphibious crossings resolved that tick (for client-side boat animation)
//
// The terrain hash lets the client cache the static raster and detect when a
// new match is started on the same socket. Client expand intents address tiles
// directly: "expand my border toward (x, y) with N percent of my pool".
// ---------------------------------------------------------------------------

import type { PerkClientMessage, PerkServerMessage } from "./messages.js";

/** Per-player snapshot row for raster mode. */
export interface RasterPlayerInfo {
  /** Engine-side numeric id (1+). 0 reserved for NEUTRAL. */
  playerId: number;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Hex color string, e.g. "#3b82f6". */
  color: string;
  /** Current troop pool. */
  troops: number;
  /** Number of capturable tiles currently owned. */
  tiles: number;
  /**
   * Troops generated per second at the current territory size — what the
   * leaderboard renders as "(+N/s)". Server-computed from tile count so every
   * client shows the same figure.
   */
  troopsPerSecond: number;
  /**
   * Tile column of the player's capital ("Hauptstadt"). The capital is the
   * player's founding tile; losing it eliminates the player. `-1` when unknown
   * (e.g. snapshots built without capital data, only in tests).
   */
  capitalX: number;
  /** Tile row of the player's capital. `-1` when unknown. */
  capitalY: number;
  /**
   * True once this player's capital has been captured. Eliminated players hold
   * no tiles (all were turned neutral on capture) and are dropped from the
   * active leaderboard / no longer draw a capital marker.
   */
  eliminated: boolean;
}

/**
 * An amphibious landing resolved on a tick: troops crossed water from the
 * coastal tile (`fromX`,`fromY`) to land on (`toX`,`toY`). The client uses these
 * to animate boats travelling over the water/rivers.
 */
export interface RasterCrossing {
  playerId: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/** Snapshot of a raster-mode match. */
export interface RasterSnapshot {
  tick: number;
  mapName: string;
  /** Grid width in tiles. */
  width: number;
  /** Grid height in tiles. */
  height: number;
  /** Stable hash of the terrain. Same hash = same terrain. */
  terrainHash: string;
  /**
   * Base64-encoded `Uint8Array` of length width*height. Only ever sent on the
   * first snapshot and when terrainHash changes; otherwise omitted to save
   * bandwidth.
   */
  terrainBase64?: string;
  /**
   * Full ownership raster: base64-encoded little-endian `Uint16Array` of length
   * width*height holding the player id owning each tile (0 = NEUTRAL). Sent on
   * the first snapshot (to seed the client) and whenever a delta would be
   * larger than a full resend; otherwise omitted in favour of `ownerDeltaBase64`.
   */
  ownerBase64?: string;
  /**
   * Incremental ownership update relative to the last snapshot this client
   * received. Base64-encoded packed records of 6 bytes each: a little-endian
   * `Uint32` tile index followed by a little-endian `Uint16` new owner. Keeps
   * per-tick bandwidth proportional to the churn at the front rather than to the
   * whole map, which is what makes million-tile maps playable. Exactly one of
   * `ownerBase64` / `ownerDeltaBase64` is present on any snapshot.
   */
  ownerDeltaBase64?: string;
  /** Player standings in deterministic ascending playerId order. */
  players: RasterPlayerInfo[];
  /** Total capturable (passable land) tiles — convenience for victory bars. */
  capturableCount: number;
  /** Winning playerId once the match has ended, else null. */
  winnerPlayerId: number | null;
  /** Most recent gameplay events, newest first. */
  recentEvents: string[];
  /** Amphibious landings resolved this tick (empty on most ticks). */
  crossings: RasterCrossing[];
}

/** Reasons the server can reject a raster expand intent. */
export type RasterRejectReason =
  | "INVALID_MESSAGE_FORMAT"
  | "INVALID_TILE"
  | "INVALID_PERCENT"
  | "NO_FRONTIER"
  | "INSUFFICIENT_TROOPS"
  | "MATCH_ENDED";

/** Sent by the client to expand its border toward a clicked tile. */
export interface RasterExpandIntent {
  /** Tile column (0..width-1) the player clicked. */
  targetX: number;
  /** Tile row (0..height-1) the player clicked. */
  targetY: number;
  /** Percentage of the player's pool to commit (1..100). */
  percent: number;
}

export interface RasterActionRejectedEvent {
  reason: RasterRejectReason;
  message: string;
  intent: RasterExpandIntent;
}

/** Assignment payload for raster mode. */
export interface RasterPlayerAssignedPayload {
  playerId: number;
  name: string;
  color: string;
}

/** Why a match ended. */
export type RasterMatchEndReason =
  /** A single player came to own every capturable tile. */
  | "conquest"
  /** The match clock ran out; the territory leader is declared the winner. */
  | "timeLimit";

/**
 * End-of-run statistics for a single player, shown on the post-match screen.
 * Built per-recipient so each client sees its own run.
 */
export interface RasterRunStats {
  playerId: number;
  /** Most tiles this player ever held during the match. */
  peakTiles: number;
  /** Tiles held at the final tick. */
  finalTiles: number;
  /** Opponents this player eliminated by capturing their capital. */
  kills: number;
  /** Ticks the player survived (until eliminated, else the full match). */
  survivedTicks: number;
  /** True if the player's capital was captured before the match ended. */
  eliminated: boolean;
  /** True if this player is the declared winner. */
  won: boolean;
}

/** Payload broadcast when a raster match ends. */
export interface RasterMatchEndedPayload {
  /** Declared winner, or null if no player held any territory. */
  winnerPlayerId: number | null;
  reason: RasterMatchEndReason;
  /** Total ticks the match ran. */
  durationTicks: number;
  /** Simulation tick rate, so the client can convert ticks to seconds. */
  tickRate: number;
  /** The receiving player's own run statistics. */
  stats: RasterRunStats;
}

/** Messages the client can send to the server. */
export type RasterClientMessage =
  | { type: "CLIENT_RASTER_EXPAND"; payload: RasterExpandIntent }
  | PerkClientMessage;

/** Messages the server can send to the client. */
export type RasterServerMessage =
  | { type: "SERVER_RASTER_LOBBY_WAITING" }
  | { type: "SERVER_RASTER_PLAYER_ASSIGNED"; payload: RasterPlayerAssignedPayload }
  | { type: "SERVER_RASTER_SNAPSHOT"; payload: RasterSnapshot }
  | { type: "SERVER_RASTER_ACTION_REJECTED"; payload: RasterActionRejectedEvent }
  | { type: "SERVER_RASTER_MATCH_ENDED"; payload: RasterMatchEndedPayload }
  | PerkServerMessage;
