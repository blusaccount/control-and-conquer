import { generateTerrain } from "../Core/terrainGenerator.js";
import { NEUTRAL_PLAYER, TerritoryGrid, type PlayerId } from "../Core/TerritoryGrid.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { RasterConflict, type AttackIntent } from "../Core/RasterConflict.js";
import type {
  RasterActionRejectedEvent,
  RasterExpandIntent,
  RasterRejectReason,
  RasterServerMessage,
} from "../Core/types.js";
import { buildRasterSnapshot, encodeTerrain, type PlayerMeta } from "./rasterSerialization.js";

export type RasterMessageHandler = (message: RasterServerMessage) => void;

/** Subscriber-internal record: which player they are + whether they have the terrain yet. */
interface RasterSubscriber {
  clientId: string;
  playerId: PlayerId;
  send: RasterMessageHandler;
  /** False until the client has received a snapshot containing terrain bytes. */
  hasTerrain: boolean;
}

interface PendingExpand {
  clientId: string;
  intent: RasterExpandIntent;
}

const MAX_EVENTS = 10;

/** Hex palette used to colour player 1..N. Indexed by playerId - 1. */
const PLAYER_PALETTE: ReadonlyArray<{ name: string; color: string }> = [
  { name: "Blue Empire", color: "#3b82f6" },
  { name: "Red Empire", color: "#ef4444" },
  { name: "Green Empire", color: "#22c55e" },
  { name: "Amber Empire", color: "#f59e0b" },
  { name: "Violet Empire", color: "#a855f7" },
  { name: "Cyan Empire", color: "#06b6d4" },
];

export interface RasterGameSessionOptions {
  /** Width in tiles. Default 64. */
  width?: number;
  /** Height in tiles. Default 40. */
  height?: number;
  /** Integer seed for the terrain generator. Default uses a fixed seed. */
  seed?: number;
  /** Map name shown in the UI. Default "Procedural Continent". */
  mapName?: string;
  /** Starting troop pool every player begins with. Default 50. */
  startingTroops?: number;
}

const DEFAULT_OPTIONS: Required<RasterGameSessionOptions> = {
  width: 64,
  height: 40,
  seed: 1,
  mapName: "Procedural Continent",
  startingTroops: 50,
};

/**
 * A live raster (openfront-style) match.
 *
 * Wraps a generated `GameMap`, the mutable `TerritoryGrid`, and a
 * `RasterConflict` engine. Each `tick()` drains queued expand intents, advances
 * combat, and broadcasts a fresh `RasterSnapshot` to every subscriber.
 *
 * Determinism: the only inputs to the engine are the (player-supplied) intents
 * and the terrain that was generated once at construction from a fixed seed.
 * No `Math.random`, no `Date.now`.
 */
export class RasterGameSession {
  private readonly map: GameMap;
  private readonly grid: TerritoryGrid;
  private readonly conflict: RasterConflict;
  private readonly mapName: string;
  private readonly terrainHash: string;
  private readonly terrainBase64: string;
  private readonly playerMeta = new Map<PlayerId, PlayerMeta>();
  private readonly subscribers = new Map<string, RasterSubscriber>();
  private readonly pendingExpands: PendingExpand[] = [];
  private recentEvents: string[] = ["Match started."];
  /** Determines spawn placement: each new subscriber takes the next slot. */
  private nextPlayerId: PlayerId = 1;
  private matchEndedBroadcast = false;
  /** Cached spawn tiles per player, chosen deterministically from the terrain. */
  private readonly spawnTiles: TileRef[] = [];

  public constructor(options: RasterGameSessionOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.mapName = opts.mapName;
    // Generate terrain. Some (seed × dims) combinations produce a fully
    // water grid (especially small maps), which leaves no playable land.
    // Walk down seaLevel until at least 8% of tiles are passable land — that
    // floor guarantees both a spawn corner and room to expand.
    let map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed });
    const minLand = Math.max(8, Math.floor(opts.width * opts.height * 0.08));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let landTiles = 0;
      for (let i = 0; i < map.terrain.length; i += 1) if (map.isLand(i) && !map.isImpassable(i)) landTiles += 1;
      if (landTiles >= minLand) break;
      const seaLevel = 0.5 - 0.1 * (attempt + 1);
      map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed, seaLevel });
    }
    this.map = map;
    this.grid = new TerritoryGrid(this.map);
    this.conflict = new RasterConflict(this.grid);
    const { terrainBase64, terrainHash } = encodeTerrain(this.map);
    this.terrainBase64 = terrainBase64;
    this.terrainHash = terrainHash;
    this.spawnTiles = this.pickSpawnTiles();
  }

  /**
   * Pre-pick spawn tiles for up to PLAYER_PALETTE.length players.
   *
   * Spread them around the perimeter of the land mass so two players never
   * start touching each other. Deterministic: iterates ascending TileRef and
   * picks the most distant land tile from already-claimed spawns.
   */
  private pickSpawnTiles(): TileRef[] {
    const landTiles: TileRef[] = [];
    for (let ref = 0; ref < this.map.size; ref += 1) {
      if (this.map.isLand(ref) && !this.map.isImpassable(ref)) {
        landTiles.push(ref);
      }
    }
    if (landTiles.length === 0) {
      throw new Error("Generated terrain has no land tiles — cannot start raster match.");
    }

    const chosen: TileRef[] = [];
    // First spawn: the corner-most land tile (low x, low y).
    chosen.push(landTiles[0]);
    // Subsequent spawns: pick the candidate that maximises min-distance to any
    // already-chosen spawn. This produces well-separated start positions even
    // when the land mass is irregular.
    while (chosen.length < PLAYER_PALETTE.length) {
      let bestRef = landTiles[0];
      let bestScore = -1;
      for (const candidate of landTiles) {
        if (chosen.includes(candidate)) continue;
        const cx = this.map.x(candidate);
        const cy = this.map.y(candidate);
        let minDist = Infinity;
        for (const seat of chosen) {
          const sx = this.map.x(seat);
          const sy = this.map.y(seat);
          const dist = Math.hypot(cx - sx, cy - sy);
          if (dist < minDist) minDist = dist;
        }
        if (minDist > bestScore) {
          bestScore = minDist;
          bestRef = candidate;
        }
      }
      chosen.push(bestRef);
    }
    return chosen;
  }

  public subscribe(clientId: string, send: RasterMessageHandler): () => void {
    if (this.nextPlayerId > PLAYER_PALETTE.length) {
      throw new Error(`Raster session is full (max ${PLAYER_PALETTE.length} players).`);
    }
    const playerId = this.nextPlayerId;
    this.nextPlayerId += 1;
    const meta = PLAYER_PALETTE[playerId - 1];
    this.playerMeta.set(playerId, meta);

    // Register the player, give them a starting pool + their spawn tile.
    this.grid.addPlayer(playerId, DEFAULT_OPTIONS.startingTroops);
    const spawn = this.spawnTiles[playerId - 1];
    this.grid.claim(spawn, playerId);

    const subscriber: RasterSubscriber = {
      clientId,
      playerId,
      send,
      hasTerrain: false,
    };
    this.subscribers.set(clientId, subscriber);

    send({
      type: "SERVER_RASTER_PLAYER_ASSIGNED",
      payload: { playerId, name: meta.name, color: meta.color },
    });
    // First snapshot includes the terrain so the client can paint the map.
    this.sendSnapshotTo(subscriber);

    return () => {
      this.subscribers.delete(clientId);
    };
  }

  public queueExpand(clientId: string, intent: RasterExpandIntent): void {
    if (!this.subscribers.has(clientId)) return;
    this.pendingExpands.push({ clientId, intent });
  }

  /**
   * Drive one simulation step: validate queued expands, convert valid ones into
   * `AttackIntent`s, advance the conflict engine, then broadcast snapshots.
   */
  public tick(): void {
    const intents: AttackIntent[] = [];
    const rejections: Array<{ clientId: string; rejection: RasterActionRejectedEvent }> = [];

    for (const pending of this.pendingExpands) {
      const subscriber = this.subscribers.get(pending.clientId);
      if (!subscriber) continue;
      const result = this.validateAndBuildIntent(subscriber.playerId, pending.intent);
      if (result.kind === "rejected") {
        rejections.push({
          clientId: pending.clientId,
          rejection: {
            reason: result.reason,
            message: result.message,
            intent: pending.intent,
          },
        });
      } else {
        intents.push(result.intent);
      }
    }
    this.pendingExpands.length = 0;

    const tickResult = this.conflict.processTick(intents);

    // Append a single event line per capture-rich tick if anything happened.
    if (intents.length > 0) {
      const lines = intents.map((i) => {
        const attackerName = this.playerMeta.get(i.attacker)?.name ?? `Player ${i.attacker}`;
        const targetName = i.target === NEUTRAL_PLAYER
          ? "neutral land"
          : this.playerMeta.get(i.target)?.name ?? `Player ${i.target}`;
        return `${attackerName} committed ${i.troops} troops toward ${targetName}.`;
      });
      this.recentEvents = [...lines.reverse(), ...this.recentEvents].slice(0, MAX_EVENTS);
    }

    for (const { clientId, rejection } of rejections) {
      this.subscribers.get(clientId)?.send({
        type: "SERVER_RASTER_ACTION_REJECTED",
        payload: rejection,
      });
    }

    for (const subscriber of this.subscribers.values()) {
      this.sendSnapshotTo(subscriber);
    }

    if (tickResult.winner !== null && !this.matchEndedBroadcast) {
      this.matchEndedBroadcast = true;
      const winnerName = this.playerMeta.get(tickResult.winner)?.name ?? `Player ${tickResult.winner}`;
      this.recentEvents = [`${winnerName} has conquered the map.`, ...this.recentEvents].slice(0, MAX_EVENTS);
      for (const subscriber of this.subscribers.values()) {
        subscriber.send({
          type: "SERVER_RASTER_MATCH_ENDED",
          payload: { winnerPlayerId: tickResult.winner },
        });
      }
    }
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }

  public getPendingExpandCount(): number {
    return this.pendingExpands.length;
  }

  /** Test/bot helper: peek at the engine state without forcing a tick. */
  public peekGrid(): TerritoryGrid {
    return this.grid;
  }

  public peekMap(): GameMap {
    return this.map;
  }

  private validateAndBuildIntent(
    attacker: PlayerId,
    intent: RasterExpandIntent,
  ): { kind: "ok"; intent: AttackIntent } | { kind: "rejected"; reason: RasterRejectReason; message: string } {
    if (this.conflict.winner !== null) {
      return { kind: "rejected", reason: "MATCH_ENDED", message: "The match has already ended." };
    }
    if (!Number.isInteger(intent.targetX) || !Number.isInteger(intent.targetY) ||
        !this.map.inBounds(intent.targetX, intent.targetY)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Target tile is out of bounds." };
    }
    if (!Number.isInteger(intent.percent) || intent.percent < 1 || intent.percent > 100) {
      return { kind: "rejected", reason: "INVALID_PERCENT", message: "Percent must be an integer 1..100." };
    }

    const ref = this.map.ref(intent.targetX, intent.targetY);
    if (!this.grid.isCapturable(ref)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Target tile is not capturable land." };
    }

    const target = this.grid.ownerOf(ref);
    if (target === attacker) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "You already own that tile." };
    }
    if (!this.grid.hasFrontier(attacker, target)) {
      return {
        kind: "rejected",
        reason: "NO_FRONTIER",
        message: target === NEUTRAL_PLAYER
          ? "Your border doesn't touch any neutral land."
          : "Your border doesn't touch that opponent.",
      };
    }

    const pool = this.grid.troopsOf(attacker);
    const troops = Math.max(1, Math.floor((pool * intent.percent) / 100));
    if (troops > pool) {
      return { kind: "rejected", reason: "INSUFFICIENT_TROOPS", message: "Not enough troops in your pool." };
    }

    return { kind: "ok", intent: { attacker, target, troops } };
  }

  private sendSnapshotTo(subscriber: RasterSubscriber): void {
    const includeTerrain = !subscriber.hasTerrain;
    const snapshot = buildRasterSnapshot({
      tick: this.conflict.tick,
      mapName: this.mapName,
      map: this.map,
      grid: this.grid,
      playerMeta: this.playerMeta,
      includeTerrain,
      terrainHash: this.terrainHash,
      terrainBase64: this.terrainBase64,
      winnerPlayerId: this.conflict.winner,
      recentEvents: this.recentEvents,
    });
    subscriber.send({ type: "SERVER_RASTER_SNAPSHOT", payload: snapshot });
    if (includeTerrain) {
      subscriber.hasTerrain = true;
    }
  }
}
