// ---------------------------------------------------------------------------
// Raster lobby message types.
//
// Kept in a dedicated module (per the project's message-type convention) so new
// gameplay messages don't bloat the core `types.ts`. The raster client/server
// message unions in `types.ts` import and fold these in.
// ---------------------------------------------------------------------------

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
