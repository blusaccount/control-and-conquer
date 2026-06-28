export type TeamId = "blue" | "red";

export interface Point {
  x: number;
  y: number;
}

export interface Territory {
  id: string;
  name: string;
  ownerId: TeamId;
  troops: number;
  neighbors: string[];
  polygon: Point[];
  center: Point;
}

export interface TeamState {
  id: TeamId;
  name: string;
  color: string;
}

/**
 * Authored, data-driven description of a single territory. This is the raw
 * input format (e.g. from a JSON map file) before centers are computed and the
 * map is validated into runtime `Territory` objects by the map loader.
 */
export interface MapTerritoryDefinition {
  id: string;
  name: string;
  ownerId: TeamId;
  troops: number;
  neighbors: string[];
  polygon: Point[];
}

/** A complete, authored map: a name plus its territory definitions. */
export interface MapDefinition {
  name: string;
  territories: MapTerritoryDefinition[];
}

export interface GameStateSnapshot {
  tick: number;
  mapName: string;
  teams: Record<TeamId, TeamState>;
  territories: Record<string, Territory>;
  territoryOrder: string[];
  recentEvents: string[];
  activeConflicts: ActiveConflict[];
  /** Set once a single team owns every territory. `null` while the match is live. */
  winnerTeamId: TeamId | null;
}

export interface AttackOrder {
  sourceTerritoryId: string;
  targetTerritoryId: string;
  troops: number;
}

export interface ActiveConflict {
  id: string;
  attackerTeamId: TeamId;
  defenderTeamId: TeamId;
  sourceTerritoryId: string;
  targetTerritoryId: string;
  /** Remaining attacker troops engaged in the fight. */
  attackingTroops: number;
  /** Remaining defender troops in the contested territory. */
  defendingTroops: number;
  /** 0.0 = front at the border, 1.0 = territory fully overrun. */
  progress: number;
}

export type ActionRejectedReason =
  | "INVALID_MESSAGE_FORMAT"
  | "INVALID_TERRITORY"
  | "NOT_OWNER"
  | "NOT_ADJACENT"
  | "INSUFFICIENT_TROOPS"
  | "SAME_OWNER"
  | "INVALID_TROOP_COUNT"
  | "TERRITORY_CONTESTED"
  | "MATCH_ENDED";

export interface ActionRejectedEvent {
  reason: ActionRejectedReason;
  message: string;
  order: AttackOrder;
}

export type ClientMessage = {
  type: "CLIENT_ATTACK_REQUEST";
  payload: AttackOrder;
};

export type ServerMessage =
  | {
      type: "SERVER_LOBBY_WAITING";
    }
  | {
      type: "SERVER_PLAYER_ASSIGNED";
      payload: { teamId: TeamId };
    }
  | {
      type: "SERVER_STATE_SNAPSHOT";
      payload: GameStateSnapshot;
    }
  | {
      type: "SERVER_ACTION_REJECTED";
      payload: ActionRejectedEvent;
    }
  | {
      type: "SERVER_MATCH_ENDED";
      payload: { winnerTeamId: TeamId };
    };


// ---------------------------------------------------------------------------
// Raster mode protocol (PR #2: openfront-style pixel terrain + tile ownership).
//
// In raster mode the snapshot stops shipping polygon territories and instead
// ships:
//   - terrain bytes (one-time, base64-encoded — terrain never changes mid-match)
//   - owner array (every tick, base64-encoded Uint16 little-endian)
//   - per-player standings (troops pool, tile count)
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

/** Assignment payload for raster mode (different shape than TeamId). */
export interface RasterPlayerAssignedPayload {
  playerId: number;
  name: string;
  color: string;
}

/** Discriminated union extending ClientMessage for raster mode. */
export type RasterClientMessage = {
  type: "CLIENT_RASTER_EXPAND";
  payload: RasterExpandIntent;
};

/** Discriminated union extending ServerMessage for raster mode. */
export type RasterServerMessage =
  | { type: "SERVER_RASTER_LOBBY_WAITING" }
  | { type: "SERVER_RASTER_PLAYER_ASSIGNED"; payload: RasterPlayerAssignedPayload }
  | { type: "SERVER_RASTER_SNAPSHOT"; payload: RasterSnapshot }
  | { type: "SERVER_RASTER_ACTION_REJECTED"; payload: RasterActionRejectedEvent }
  | { type: "SERVER_RASTER_MATCH_ENDED"; payload: { winnerPlayerId: number } };
