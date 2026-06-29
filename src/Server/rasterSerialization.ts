import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { GameMap } from "../Core/GameMap.js";
import type { TerritoryGrid } from "../Core/TerritoryGrid.js";
import type { RasterCrossing, RasterPlayerInfo, RasterSnapshot } from "../Core/types.js";

/**
 * Serialize a `GameMap`'s static terrain into base64 plus a stable hash.
 *
 * Hash is SHA-256 truncated to 12 hex chars — collisions are astronomically
 * unlikely for our use case (client-side terrain cache key) and the short
 * string keeps wire size down.
 */
export const encodeTerrain = (map: GameMap): { terrainBase64: string; terrainHash: string } => {
  const terrainBase64 = Buffer.from(map.terrain).toString("base64");
  const terrainHash = createHash("sha256").update(map.terrain).digest("hex").slice(0, 12);
  return { terrainBase64, terrainHash };
};

/**
 * Serialize the current owner array (`Uint16Array`) to base64. We write
 * little-endian explicitly so the client decoder doesn't depend on the host's
 * native byte order (browsers can disagree with the server's V8).
 */
export const encodeOwners = (owner: ArrayLike<number>): string => {
  const buffer = Buffer.alloc(owner.length * 2);
  for (let i = 0; i < owner.length; i += 1) {
    buffer.writeUInt16LE(owner[i], i * 2);
  }
  return buffer.toString("base64");
};

/**
 * Diff `curr` against the `prev` baseline and encode the changed tiles as a
 * packed delta (6 bytes per change: LE Uint32 index + LE Uint16 owner). The
 * `prev` array is updated in place to match `curr`, so the caller's baseline is
 * advanced as a side effect. Returns the base64 payload plus the change count
 * (so the caller can fall back to a full resend when churn is high).
 */
export const encodeOwnerDelta = (
  prev: Uint16Array,
  curr: ArrayLike<number>,
): { deltaBase64: string; changed: number } => {
  let changed = 0;
  for (let i = 0; i < curr.length; i += 1) if (prev[i] !== curr[i]) changed += 1;

  const buffer = Buffer.alloc(changed * 6);
  let pos = 0;
  for (let i = 0; i < curr.length; i += 1) {
    if (prev[i] !== curr[i]) {
      buffer.writeUInt32LE(i, pos);
      buffer.writeUInt16LE(curr[i], pos + 4);
      pos += 6;
      prev[i] = curr[i];
    }
  }
  return { deltaBase64: buffer.toString("base64"), changed };
};

/** Per-player metadata needed to build a `RasterPlayerInfo`. */
export interface PlayerMeta {
  name: string;
  color: string;
}

/**
 * Build a `RasterSnapshot` from the engine state plus optional inclusion of
 * the static terrain. The terrain bytes are large and never change, so the
 * caller drops them on every snapshot except the first one for a new client.
 */
export interface BuildSnapshotInput {
  tick: number;
  mapName: string;
  map: GameMap;
  grid: TerritoryGrid;
  playerMeta: Map<number, PlayerMeta>;
  includeTerrain: boolean;
  terrainHash: string;
  terrainBase64: string;
  winnerPlayerId: number | null;
  recentEvents: string[];
  /** Amphibious landings resolved this tick (for client boat animation). */
  crossings: RasterCrossing[];
  /**
   * When set, the snapshot carries this incremental ownership update instead of
   * the full owner raster. When omitted, the full raster is encoded and sent.
   */
  ownerDeltaBase64?: string;
}

export const buildRasterSnapshot = (input: BuildSnapshotInput): RasterSnapshot => {
  const { tick, mapName, map, grid, playerMeta, includeTerrain, terrainHash, terrainBase64, winnerPlayerId, recentEvents, crossings, ownerDeltaBase64 } = input;

  const players: RasterPlayerInfo[] = [];
  for (const id of grid.players()) {
    const meta = playerMeta.get(id) ?? { name: `Player ${id}`, color: "#888" };
    players.push({
      playerId: id,
      name: meta.name,
      color: meta.color,
      troops: Math.floor(grid.troopsOf(id)),
      tiles: grid.tileCountOf(id),
    });
  }

  return {
    tick,
    mapName,
    width: map.width,
    height: map.height,
    terrainHash,
    ...(includeTerrain ? { terrainBase64 } : {}),
    // Exactly one ownership representation: an incremental delta when the caller
    // supplies one, otherwise the full raster.
    ...(ownerDeltaBase64 !== undefined
      ? { ownerDeltaBase64 }
      : { ownerBase64: encodeOwners(grid.owner) }),
    players,
    capturableCount: grid.capturableCount,
    winnerPlayerId,
    recentEvents,
    crossings,
  };
};
