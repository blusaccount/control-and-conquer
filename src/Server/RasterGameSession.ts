import { generateTerrain } from "../Core/terrainGenerator.js";
import { buildRealMap, getRealMap } from "../Core/realMaps.js";
import { buildHeightmapGameMap, getHeightmapMap } from "./heightmapMaps.js";
import { NEUTRAL_PLAYER, TerritoryGrid, type PlayerId } from "../Core/TerritoryGrid.js";
import type { GameMap, TileRef } from "../Core/GameMap.js";
import { RasterConflict, type AttackIntent, type AttackRejectReason, type SeaAttackIntent } from "../Core/RasterConflict.js";
import type {
  RasterActionRejectedEvent,
  RasterCrossing,
  RasterExpandIntent,
  RasterMatchEndReason,
  RasterRejectReason,
  RasterRunStats,
  RasterServerMessage,
  RasterShip,
} from "../Core/types.js";
import { RASTER_MATCH_DURATION_SECONDS } from "../Core/rasterCombatConfig.js";
import { SIMULATION_TICK_RATE } from "./simulationConfig.js";
import { buildRasterSnapshot, encodeOwnerDelta, encodeTerrain, type PlayerMeta } from "./rasterSerialization.js";
import { MAX_TRANSPORT_SHIPS_PER_PLAYER } from "../Core/rasterCombatConfig.js";

export type RasterMessageHandler = (message: RasterServerMessage) => void;

/** Subscriber-internal record: which player they are + whether they have the terrain yet. */
interface RasterSubscriber {
  clientId: string;
  playerId: PlayerId;
  send: RasterMessageHandler;
  /** False until the client has received a snapshot containing terrain bytes. */
  hasTerrain: boolean;
  /**
   * Per-subscriber owner baseline: the ownership raster this client last
   * received. Owner snapshots after the first are encoded as a delta against
   * this array, which is then advanced to match. `null` until the first
   * (full-owner) snapshot is sent.
   */
  lastOwner: Uint16Array | null;
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
  /** Width in tiles. Default 64. Ignored when `realMapId` is set. */
  width?: number;
  /** Height in tiles. Default 40. Ignored when `realMapId` is set. */
  height?: number;
  /** Integer seed for the terrain generator. Default uses a fixed seed. */
  seed?: number;
  /** Map name shown in the UI. Default "Procedural Continent". */
  mapName?: string;
  /** Starting troop pool every player begins with. Default 50. */
  startingTroops?: number;
  /**
   * When set to a known map id, the match runs on that map instead of
   * procedural terrain. Resolved in order: heightmap maps (`heightmapMaps`,
   * e.g. `earth`), then hand-authored ASCII maps (`realMaps`, e.g.
   * `mediterranean`). Unknown ids fall back to procedural generation.
   */
  realMapId?: string;
  /**
   * Target width in tiles for heightmap maps (height is derived to keep a
   * geographic aspect ratio). Ignored for ASCII and procedural maps. `0` uses
   * the map's default size.
   */
  mapSize?: number;
  /**
   * Hard match length in ticks. When reached, the match ends on the time limit
   * and the territory leader wins. Defaults to
   * {@link RASTER_MATCH_DURATION_SECONDS} converted at the server tick rate.
   * Exposed mainly so tests can run short matches.
   */
  maxDurationTicks?: number;
}

const DEFAULT_OPTIONS: Required<RasterGameSessionOptions> = {
  width: 64,
  height: 40,
  seed: 1,
  mapName: "Procedural Continent",
  startingTroops: 50,
  realMapId: "",
  mapSize: 0,
  maxDurationTicks: RASTER_MATCH_DURATION_SECONDS * SIMULATION_TICK_RATE,
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
  private readonly startingTroops: number;
  private readonly terrainHash: string;
  private readonly terrainBase64: string;
  private readonly playerMeta = new Map<PlayerId, PlayerMeta>();
  private readonly subscribers = new Map<string, RasterSubscriber>();
  private readonly pendingExpands: PendingExpand[] = [];
  private recentEvents: string[] = ["Match started."];
  /** Transport-ship landings from the most recent tick, broadcast for animation. */
  private lastCrossings: RasterCrossing[] = [];
  /** Transport ships in flight as of the most recent tick, broadcast for animation. */
  private lastShips: RasterShip[] = [];
  /** Determines spawn placement: each new subscriber takes the next slot. */
  private nextPlayerId: PlayerId = 1;
  private matchEndedBroadcast = false;
  /** Cached spawn tiles per player, chosen deterministically from the terrain. */
  private readonly spawnTiles: TileRef[] = [];
  /**
   * Each player's capital ("Hauptstadt") tile — its founding tile. Capturing it
   * eliminates the player. Set when the player joins (capital = spawn tile).
   */
  private readonly capitals = new Map<PlayerId, TileRef>();
  /** Players whose capital has fallen; their territory was turned neutral. */
  private readonly eliminated = new Set<PlayerId>();
  /** Hard tick budget for the run; the match ends on the time limit when hit. */
  private readonly maxDurationTicks: number;
  /** Most tiles each player has held at any point — a run-stat. */
  private readonly peakTiles = new Map<PlayerId, number>();
  /** Capitals each player has captured (eliminations they caused) — a run-stat. */
  private readonly kills = new Map<PlayerId, number>();
  /** Tick at which a player was eliminated, for their survival-time stat. */
  private readonly eliminationTick = new Map<PlayerId, number>();
  /**
   * Players already sent their personal end-of-run summary — either when their
   * capital fell (a defeat screen the instant they die) or at the overall match
   * end. Guards against sending a second summary at match end to someone who was
   * already eliminated mid-match.
   */
  private readonly endedSent = new Set<PlayerId>();

  public constructor(options: RasterGameSessionOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const heightmapDef = opts.realMapId ? getHeightmapMap(opts.realMapId) : undefined;
    const realMap = !heightmapDef && opts.realMapId ? getRealMap(opts.realMapId) : undefined;
    // Prefer the map's own name unless the caller explicitly set one.
    this.mapName =
      options.mapName ?? (heightmapDef ? heightmapDef.name : realMap ? realMap.name : opts.mapName);
    this.startingTroops = opts.startingTroops;
    this.maxDurationTicks = Math.max(1, Math.floor(opts.maxDurationTicks));

    let map;
    if (heightmapDef) {
      // Heightmap maps are downsampled from a real-world topology raster to the
      // requested size; they always contain ample playable land.
      map = buildHeightmapGameMap(heightmapDef, opts.mapSize || undefined);
    } else if (realMap) {
      // Real-world maps already guarantee playable land, so use them verbatim.
      map = buildRealMap(realMap);
    } else {
      // Generate terrain. Some (seed × dims) combinations produce a fully
      // water grid (especially small maps), which leaves no playable land.
      // Walk down seaLevel until at least 8% of tiles are passable land — that
      // floor guarantees both a spawn corner and room to expand.
      map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed });
      const minLand = Math.max(8, Math.floor(opts.width * opts.height * 0.08));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let landTiles = 0;
        for (let i = 0; i < map.terrain.length; i += 1) if (map.isLand(i) && !map.isImpassable(i)) landTiles += 1;
        if (landTiles >= minLand) break;
        const seaLevel = 0.5 - 0.1 * (attempt + 1);
        map = generateTerrain({ width: opts.width, height: opts.height, seed: opts.seed, seaLevel });
      }
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

    // Farthest-point sampling over a strided subset of the land tiles. On big
    // maps the land array holds hundreds of thousands of tiles; scanning all of
    // them per spawn would be wasteful, so we cap the candidate pool with a
    // deterministic stride. The sampling still spreads spawns well because the
    // pool stays evenly distributed across the whole land mass. Distances use
    // squared magnitude (monotonic, so the argmax is identical to Euclidean).
    const MAX_CANDIDATES = 3000;
    const stride = Math.max(1, Math.floor(landTiles.length / MAX_CANDIDATES));
    const candidates: TileRef[] = [];
    for (let k = 0; k < landTiles.length; k += stride) candidates.push(landTiles[k]);

    const chosen: TileRef[] = [];
    // First spawn: the corner-most land tile (low x, low y).
    chosen.push(landTiles[0]);
    while (chosen.length < PLAYER_PALETTE.length) {
      let bestRef = landTiles[0];
      let bestScore = -1;
      for (const candidate of candidates) {
        if (chosen.includes(candidate)) continue;
        const cx = this.map.x(candidate);
        const cy = this.map.y(candidate);
        let minDist = Infinity;
        for (const seat of chosen) {
          const dx = cx - this.map.x(seat);
          const dy = cy - this.map.y(seat);
          const dist = dx * dx + dy * dy;
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

  public subscribe(
    clientId: string,
    send: RasterMessageHandler,
    autoSpawn = true,
  ): () => void {
    if (this.nextPlayerId > PLAYER_PALETTE.length) {
      throw new Error(`Raster session is full (max ${PLAYER_PALETTE.length} players).`);
    }
    const playerId = this.nextPlayerId;
    this.nextPlayerId += 1;
    const meta = PLAYER_PALETTE[playerId - 1];
    this.playerMeta.set(playerId, meta);

    const subscriber: RasterSubscriber = {
      clientId,
      playerId,
      send,
      hasTerrain: false,
      lastOwner: null,
    };
    this.subscribers.set(clientId, subscriber);

    // Bots (and any auto-spawn caller) take their precomputed spawn immediately;
    // a human is left *unspawned* until they pick a start position via
    // {@link selectSpawn}, so the player chooses where their empire begins.
    if (autoSpawn) this.seatPlayer(playerId, this.spawnTiles[playerId - 1]);

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

  /**
   * Place a player on the map at `spawnRef`: their founding (and, at this
   * instant, only) tile becomes their capital — a fortified defense post whose
   * loss later eliminates them.
   */
  private seatPlayer(playerId: PlayerId, spawnRef: TileRef): void {
    this.grid.addPlayer(playerId, this.startingTroops);
    this.grid.claim(spawnRef, playerId);
    this.capitals.set(playerId, spawnRef);
    this.grid.addDefensePost(spawnRef);
    this.peakTiles.set(playerId, this.grid.tileCountOf(playerId));
    this.kills.set(playerId, 0);
  }

  /**
   * Seat an as-yet-unspawned player at the tile they clicked, if it is open land.
   * The first map click of a human's run is a spawn pick (OpenFront's "choose a
   * start position"); ignored once they already hold territory.
   */
  public selectSpawn(clientId: string, x: number, y: number): void {
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber || this.matchEndedBroadcast) return;
    if (this.grid.hasPlayer(subscriber.playerId)) return; // already spawned

    const reject = (message: string): void =>
      subscriber.send({
        type: "SERVER_RASTER_ACTION_REJECTED",
        payload: {
          reason: "INVALID_TILE",
          message,
          intent: { targetX: Math.max(0, x | 0), targetY: Math.max(0, y | 0), percent: 50 },
        },
      });

    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.map.inBounds(x, y)) {
      reject("Pick a tile on the map to start on.");
      return;
    }
    const ref = this.map.ref(x, y);
    if (!this.grid.isCapturable(ref) || this.grid.ownerOf(ref) !== NEUTRAL_PLAYER) {
      reject("Choose open, unclaimed land for your start position.");
      return;
    }
    this.seatPlayer(subscriber.playerId, ref);
    // Push the seated state straight away so the client can zoom to the spawn
    // without waiting for the next tick.
    this.sendSnapshotTo(subscriber);
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
    // Once the match has ended (conquest or time limit) the simulation freezes:
    // no further state changes or broadcasts.
    if (this.matchEndedBroadcast) return;

    const intents: AttackIntent[] = [];
    const eventLines: string[] = [];
    const rejections: Array<{ clientId: string; rejection: RasterActionRejectedEvent }> = [];

    for (const pending of this.pendingExpands) {
      const subscriber = this.subscribers.get(pending.clientId);
      if (!subscriber) continue;
      const attacker = subscriber.playerId;
      const result = this.validateAndBuildIntent(attacker, pending.intent);
      if (result.kind === "rejected") {
        rejections.push({
          clientId: pending.clientId,
          rejection: { reason: result.reason, message: result.message, intent: pending.intent },
        });
      } else if (result.kind === "land") {
        intents.push(result.intent);
        eventLines.push(this.landEventLine(result.intent));
      } else {
        // Sea assault: dispatch a transport ship now (it persists across ticks).
        const reason = this.conflict.launchShip(result.intent);
        if (reason) {
          rejections.push({
            clientId: pending.clientId,
            rejection: { ...this.shipRejection(attacker, reason), intent: pending.intent },
          });
        } else {
          eventLines.push(this.shipEventLine(result.intent));
        }
      }
    }
    this.pendingExpands.length = 0;

    const tickResult = this.conflict.processTick(intents);

    // Track each player's peak territory before any elimination neutralises it.
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      if (tiles > (this.peakTiles.get(id) ?? 0)) this.peakTiles.set(id, tiles);
    }

    // Convert this tick's transport-ship landings to wire coordinates for the
    // landing flash, and snapshot every ship still in flight for animation.
    this.lastCrossings = tickResult.crossings.map((c) => ({
      playerId: c.attacker,
      fromX: this.map.x(c.from),
      fromY: this.map.y(c.from),
      toX: this.map.x(c.to),
      toY: this.map.y(c.to),
    }));
    this.lastShips = this.conflict.activeShips().map((s) => ({
      shipId: s.id,
      playerId: s.attacker,
      x: this.map.x(s.tile),
      y: this.map.y(s.tile),
      troops: s.troops,
    }));

    // Append a single event line per command issued this tick, newest first.
    if (eventLines.length > 0) {
      this.recentEvents = [...eventLines.reverse(), ...this.recentEvents].slice(0, MAX_EVENTS);
    }

    // A capital captured this tick eliminates its owner: the rest of their
    // empire collapses to neutral and an elimination event is broadcast.
    const { lines: eliminationLines, eliminated: justEliminated } = this.resolveCapitalCaptures();
    if (eliminationLines.length > 0) {
      this.recentEvents = [...eliminationLines, ...this.recentEvents].slice(0, MAX_EVENTS);
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

    // Give every player eliminated this tick their own end-of-run summary now —
    // a defeat screen the instant their capital falls, rather than leaving them
    // staring at dead controls until the whole match resolves. Sent after the
    // snapshot so the client first paints their collapse to neutral.
    if (justEliminated.length > 0) {
      const endTick = this.conflict.tick;
      for (const subscriber of this.subscribers.values()) {
        if (!justEliminated.includes(subscriber.playerId) || this.endedSent.has(subscriber.playerId)) continue;
        this.endedSent.add(subscriber.playerId);
        subscriber.send({
          type: "SERVER_RASTER_MATCH_ENDED",
          payload: {
            winnerPlayerId: null,
            reason: "conquest",
            durationTicks: endTick,
            tickRate: SIMULATION_TICK_RATE,
            stats: this.buildRunStats(subscriber.playerId, endTick, null),
          },
        });
      }
    }

    // End the match on conquest (a player owns everything) or when the clock
    // runs out (the territory leader is crowned). Either way, broadcast a
    // per-player run summary for the post-match stats screen.
    const timeUp = this.conflict.tick >= this.maxDurationTicks;
    if (tickResult.winner !== null || timeUp) {
      this.matchEndedBroadcast = true;
      const reason: RasterMatchEndReason = tickResult.winner !== null ? "conquest" : "timeLimit";
      const winnerId = tickResult.winner !== null ? tickResult.winner : this.leaderByTiles();
      const endTick = this.conflict.tick;

      const endLine = winnerId === null
        ? "The match ended with no survivors."
        : reason === "conquest"
          ? `${this.nameOf(winnerId)} has conquered the map.`
          : `Time's up — ${this.nameOf(winnerId)} leads with the most territory.`;
      this.recentEvents = [endLine, ...this.recentEvents].slice(0, MAX_EVENTS);

      for (const subscriber of this.subscribers.values()) {
        // Players eliminated mid-match already got their summary; don't send a second.
        if (this.endedSent.has(subscriber.playerId)) continue;
        this.endedSent.add(subscriber.playerId);
        subscriber.send({
          type: "SERVER_RASTER_MATCH_ENDED",
          payload: {
            winnerPlayerId: winnerId,
            reason,
            durationTicks: endTick,
            tickRate: SIMULATION_TICK_RATE,
            stats: this.buildRunStats(subscriber.playerId, endTick, winnerId),
          },
        });
      }
      return;
    }
  }

  private nameOf(id: PlayerId): string {
    return this.playerMeta.get(id)?.name ?? `Player ${id}`;
  }

  /** The player holding the most tiles, ties broken by lowest id; null if none. */
  private leaderByTiles(): PlayerId | null {
    let leader: PlayerId | null = null;
    let best = 0;
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      if (tiles > best) {
        best = tiles;
        leader = id;
      }
    }
    return leader;
  }

  /** Assemble a player's end-of-run statistics for the post-match screen. */
  private buildRunStats(playerId: PlayerId, endTick: number, winnerId: PlayerId | null): RasterRunStats {
    return {
      playerId,
      peakTiles: this.peakTiles.get(playerId) ?? 0,
      finalTiles: this.grid.hasPlayer(playerId) ? this.grid.tileCountOf(playerId) : 0,
      kills: this.kills.get(playerId) ?? 0,
      survivedTicks: this.eliminationTick.get(playerId) ?? endTick,
      eliminated: this.eliminated.has(playerId),
      won: winnerId === playerId,
    };
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

  /**
   * Detect capitals captured during the tick just processed and eliminate their
   * owners. A capital "falls" the instant its tile is owned by anyone other than
   * the player it belongs to. On elimination every remaining tile that player
   * holds is turned neutral (the conqueror keeps only the capital tile they
   * actually took), so the map reopens as contestable land rather than handing a
   * whole empire to one attacker. Returns the elimination event lines (newest
   * first) for the event feed, plus the ids eliminated this call. Pure
   * bookkeeping otherwise — no broadcast here.
   */
  private resolveCapitalCaptures(): { lines: string[]; eliminated: PlayerId[] } {
    const lines: string[] = [];
    const eliminated: PlayerId[] = [];
    for (const [playerId, capitalRef] of this.capitals) {
      if (this.eliminated.has(playerId)) continue;
      const conqueror = this.grid.ownerOf(capitalRef);
      if (conqueror === playerId) continue; // Capital still held.

      this.eliminated.add(playerId);
      eliminated.push(playerId);
      this.eliminationTick.set(playerId, this.conflict.tick);
      // The fallen capital is no longer a fortified seat — drop its defense aura.
      this.grid.removeDefensePost(capitalRef);
      // Credit the conqueror with a kill (capital captured) for their run stats.
      if (conqueror !== NEUTRAL_PLAYER) {
        this.kills.set(conqueror, (this.kills.get(conqueror) ?? 0) + 1);
      }
      // Neutralise the fallen player's remaining territory (the capital tile is
      // already owned by the conqueror, so it is excluded by ownership).
      for (const ref of this.grid.tilesOf(playerId)) {
        this.grid.claim(ref, NEUTRAL_PLAYER);
      }

      const fallenName = this.playerMeta.get(playerId)?.name ?? `Player ${playerId}`;
      const conquerorName = conqueror === NEUTRAL_PLAYER
        ? "Neutral forces"
        : this.playerMeta.get(conqueror)?.name ?? `Player ${conqueror}`;
      lines.unshift(`${conquerorName} captured ${fallenName}'s capital — ${fallenName} is eliminated!`);
    }
    return { lines, eliminated };
  }

  /**
   * Classify a clicked tile into a land attack or a transport-ship assault.
   *
   * A target the attacker shares a land border with becomes a contiguous land
   * push; one reachable only across water becomes a single transport ship sailing
   * the shortest route to that exact tile. The ship's full validation (path, the
   * three-ship cap, troop count) is left to {@link RasterConflict.launchShip} so
   * a path is only searched once — here we just route and size the commitment.
   */
  private validateAndBuildIntent(
    attacker: PlayerId,
    intent: RasterExpandIntent,
  ):
    | { kind: "land"; intent: AttackIntent }
    | { kind: "sea"; intent: SeaAttackIntent }
    | { kind: "rejected"; reason: RasterRejectReason; message: string } {
    if (this.conflict.winner !== null) {
      return { kind: "rejected", reason: "MATCH_ENDED", message: "The match has already ended." };
    }
    if (!this.grid.hasPlayer(attacker)) {
      return { kind: "rejected", reason: "INVALID_TILE", message: "Choose a starting position first." };
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

    const pool = this.grid.troopsOf(attacker);
    const troops = Math.max(1, Math.floor((pool * intent.percent) / 100));
    if (troops > pool) {
      return { kind: "rejected", reason: "INSUFFICIENT_TROOPS", message: "Not enough troops in your pool." };
    }

    // Same landmass as the attacker → a contiguous land attack can march to it.
    // A different landmass (across open water) → dispatch a transport ship to the
    // exact clicked tile instead.
    if (this.grid.ownsLandComponentOf(attacker, ref)) {
      if (this.grid.hasLandBorderWith(attacker, target)) {
        return { kind: "land", intent: { attacker, target, troops } };
      }
      return {
        kind: "rejected",
        reason: "NO_FRONTIER",
        message: target === NEUTRAL_PLAYER
          ? "Your border doesn't touch any neutral land there yet."
          : "Your border doesn't touch that opponent yet.",
      };
    }
    // The click is on a different landmass. Rather than demanding the player hit
    // an exact in-range coastal tile, land the boat on the reachable shore
    // nearest the click (its own tile wins when that tile is itself reachable).
    const landing = this.grid.resolveSeaLanding(attacker, ref, this.grid.seaRangeOf(attacker));
    if (landing !== null) {
      return { kind: "sea", intent: { attacker, dest: landing, troops } };
    }
    return {
      kind: "rejected",
      reason: "NO_FRONTIER",
      message: "No water route reaches that area (it may be too far across open water).",
    };
  }

  /** Event-log line for a committed land attack. */
  private landEventLine(intent: AttackIntent): string {
    const attackerName = this.playerMeta.get(intent.attacker)?.name ?? `Player ${intent.attacker}`;
    const targetName = intent.target === NEUTRAL_PLAYER
      ? "neutral land"
      : this.playerMeta.get(intent.target)?.name ?? `Player ${intent.target}`;
    return `${attackerName} committed ${intent.troops} troops toward ${targetName}.`;
  }

  /** Event-log line for a dispatched transport ship. */
  private shipEventLine(intent: SeaAttackIntent): string {
    const attackerName = this.playerMeta.get(intent.attacker)?.name ?? `Player ${intent.attacker}`;
    return `${attackerName} launched a transport ship with ${intent.troops} troops.`;
  }

  /** Map a ship-launch reject reason to a wire rejection (without the intent). */
  private shipRejection(
    attacker: PlayerId,
    reason: AttackRejectReason,
  ): { reason: RasterRejectReason; message: string } {
    switch (reason) {
      case "TOO_MANY_SHIPS":
        return {
          reason: "TOO_MANY_SHIPS",
          message: `You already have ${this.conflict.shipCountOf(attacker)} transport ships at sea (max ${MAX_TRANSPORT_SHIPS_PER_PLAYER}).`,
        };
      case "INSUFFICIENT_TROOPS":
        return { reason: "INSUFFICIENT_TROOPS", message: "Not enough troops in your pool." };
      case "NO_FRONTIER":
        return { reason: "NO_FRONTIER", message: "No water route reaches that tile." };
      default:
        return { reason: "INVALID_TILE", message: "That tile can't be reached by sea." };
    }
  }

  private sendSnapshotTo(subscriber: RasterSubscriber): void {
    const includeTerrain = !subscriber.hasTerrain;
    const owner = this.grid.owner;

    // Owner encoding: the first snapshot (and any with no baseline yet) carries
    // the full raster and seeds the baseline. Later snapshots send only the
    // tiles that changed — unless the churn is so high that a full resend would
    // be smaller, in which case we resend in full.
    let ownerDeltaBase64: string | undefined;
    if (subscriber.lastOwner === null) {
      subscriber.lastOwner = Uint16Array.from(owner);
    } else {
      const { deltaBase64, changed } = encodeOwnerDelta(subscriber.lastOwner, owner);
      // 6 bytes/change vs 2 bytes/tile full: a delta only wins below ~1/3 churn.
      if (changed * 3 <= owner.length) ownerDeltaBase64 = deltaBase64;
    }

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
      crossings: this.lastCrossings,
      ships: this.lastShips,
      ownerDeltaBase64,
      capitals: this.capitals,
      eliminated: this.eliminated,
    });
    subscriber.send({ type: "SERVER_RASTER_SNAPSHOT", payload: snapshot });
    if (includeTerrain) {
      subscriber.hasTerrain = true;
    }
  }
}
