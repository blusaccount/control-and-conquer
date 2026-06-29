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
   * Base64-encoded little-endian `Uint16Array` of length width*height holding
   * the player id owning each tile. 0 = NEUTRAL.
   */
  ownerBase64: string;
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

/** Messages the client can send to the server. */
export type RasterClientMessage = {
  type: "CLIENT_RASTER_EXPAND";
  payload: RasterExpandIntent;
};

/** Messages the server can send to the client. */
export type RasterServerMessage =
  | { type: "SERVER_RASTER_LOBBY_WAITING" }
  | { type: "SERVER_RASTER_PLAYER_ASSIGNED"; payload: RasterPlayerAssignedPayload }
  | { type: "SERVER_RASTER_SNAPSHOT"; payload: RasterSnapshot }
  | { type: "SERVER_RASTER_ACTION_REJECTED"; payload: RasterActionRejectedEvent }
  | { type: "SERVER_RASTER_MATCH_ENDED"; payload: { winnerPlayerId: number } };
