// ---------------------------------------------------------------------------
// Raster lobby message types.
//
// Kept in a dedicated module (per the project's message-type convention) so new
// gameplay messages don't bloat the core `types.ts`. The raster client/server
// message unions in `types.ts` import and fold these in.
// ---------------------------------------------------------------------------

/** Match difficulty — scales the number of rival nations and how hard they play. */
export type RasterDifficulty = "easy" | "medium" | "hard";

export const RASTER_DIFFICULTIES: readonly RasterDifficulty[] = ["easy", "medium", "hard"];

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
}

export type RasterJoinClientMessage = { type: "CLIENT_RASTER_JOIN"; payload: RasterJoinPayload };

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
