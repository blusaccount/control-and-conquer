/**
 * Train economy over the auto-routed {@link RailNetwork}.
 *
 * OpenFront's rails exist to run trains: a factory cluster periodically spawns a
 * train that rides the network and pays the owner gold each time it reaches a
 * city or port (see the Train wiki). This class owns that simulation — it keeps
 * the network in sync with the current stations, spawns and moves trains, and
 * banks the payouts — all deterministically (spawn timing is a fixed tick
 * cadence, route choices break ties by tile ref; no `Math.random`), so it stays
 * replay-stable like the rest of the engine. `RasterConflict` ticks it once per
 * tick and reads {@link railViews}/{@link trainViews} for the snapshot.
 */
import type { TileRef } from "./GameMap.js";
import { type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  type BuildingType,
  RAIL_PAYOUT_TYPES,
  RAIL_STATION_TYPES,
  trainGold,
  trainSpawnRate,
  TRAIN_MAX_PER_PLAYER,
  TRAIN_MAX_VISITS,
  TRAIN_SPAWN_MIN_COOLDOWN_TICKS,
  TRAIN_TILES_PER_TICK,
} from "./buildings.js";
import {
  computeRailNetwork,
  railPairKey,
  type RailEdge,
  type RailNetwork,
  type RailStation,
} from "./railNetwork.js";

/** A train riding the network from station `from` toward station `to`. */
interface Train {
  id: number;
  owner: PlayerId;
  /** The station it departed (one end of the current edge). */
  from: TileRef;
  /** The station it is heading to (the other end). */
  to: TileRef;
  /** Tiles of track travelled along the current edge so far. */
  progress: number;
  /** Stations reached so far; the train retires at {@link TRAIN_MAX_VISITS}. */
  visits: number;
}

/** Wire-ready view of one rail link: its owner and the corner points to draw. */
export interface RailView {
  owner: PlayerId;
  points: Array<[number, number]>;
}

/** Wire-ready view of one train: its owner and fractional tile position. */
export interface TrainView {
  owner: PlayerId;
  x: number;
  y: number;
}

export class RailSystem {
  private readonly grid: TerritoryGrid;
  private network: RailNetwork = { edges: [], adjacency: new Map() };
  /** Edge lookup by unordered station pair, rebuilt whenever the network is. */
  private edgeByPair = new Map<string, RailEdge>();
  /** Current station kind per tile, for payout checks. */
  private stationType = new Map<TileRef, BuildingType>();
  private trains: Train[] = [];
  private nextTrainId = 1;
  /** Signature of the station set the current network was built from. */
  private signature = "";
  /** Per-factory rejection counter for OpenFront's `trainSpawnRate` (reset on spawn). */
  private trainRejections = new Map<TileRef, number>();
  /** Tick a factory last launched a train, for the spawn cooldown. */
  private lastTrainSpawn = new Map<TileRef, number>();

  constructor(grid: TerritoryGrid) {
    this.grid = grid;
  }

  /**
   * Advance the rail economy one tick: recompute the network if stations
   * changed, move every train (paying out on arrivals), then spawn new trains on
   * the fixed cadence. `tick` is the simulation tick being processed.
   */
  advance(tick: number): void {
    this.sync();
    if (this.network.edges.length === 0) {
      this.trains.length = 0;
      return;
    }
    this.moveTrains();
    this.attemptTrainSpawns(tick);
  }

  /** Every rail link as drawable corner-point polylines, owner-tagged. */
  railViews(): RailView[] {
    return this.network.edges.map((edge) => ({
      owner: edge.owner,
      points: edge.corners.map((ref) => [this.grid.map.x(ref), this.grid.map.y(ref)] as [number, number]),
    }));
  }

  /** Every live train as a fractional-tile position, owner-tagged. */
  trainViews(): TrainView[] {
    return this.trains.map((train) => {
      const { x, y } = this.trainPosition(train);
      return { owner: train.owner, x, y };
    });
  }

  /** Number of live trains (for tests). */
  get trainCount(): number {
    return this.trains.length;
  }

  /** Number of rail links (for tests). */
  get edgeCount(): number {
    return this.network.edges.length;
  }

  /**
   * Recompute the network only when the station set actually changed (cheap
   * signature compare), and drop any train whose current edge no longer exists.
   */
  private sync(): void {
    const stations = this.collectStations();
    const signature = stations.map((s) => `${s.ref}:${s.type}:${s.owner}`).join(",");
    if (signature === this.signature) return;
    this.signature = signature;
    this.stationType = new Map(stations.map((s) => [s.ref, s.type]));
    this.network = computeRailNetwork(this.grid.map, stations);
    this.edgeByPair = new Map(this.network.edges.map((e) => [railPairKey(e.a, e.b), e]));
    this.trains = this.trains.filter((t) => this.edgeByPair.has(railPairKey(t.from, t.to)));
    // Forget spawn state for stations that no longer exist.
    for (const ref of [...this.trainRejections.keys()]) if (!this.stationType.has(ref)) this.trainRejections.delete(ref);
    for (const ref of [...this.lastTrainSpawn.keys()]) if (!this.stationType.has(ref)) this.lastTrainSpawn.delete(ref);
  }

  /** Snapshot the station buildings (factory/city/port) with owner + kind. */
  private collectStations(): RailStation[] {
    const out: RailStation[] = [];
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (RAIL_STATION_TYPES.includes(type)) {
        out.push({ ref, owner: this.grid.ownerOf(ref), type });
      }
    }
    return out;
  }

  /**
   * Move every train along its current edge. On reaching the far station it pays
   * out (city/port only, and only if the owner still holds it), then either
   * retires or rolls onto the next edge, carrying any leftover step distance.
   */
  private moveTrains(): void {
    const survivors: Train[] = [];
    for (const train of this.trains) {
      const edge = this.edgeByPair.get(railPairKey(train.from, train.to));
      if (!edge) continue; // Edge vanished mid-tick; drop the train.
      train.progress += TRAIN_TILES_PER_TICK;
      if (train.progress < edge.length) {
        survivors.push(train);
        continue;
      }

      // Arrived. A city/port still owned by the train's owner pays out, with
      // OpenFront's per-stop decay: the payout eases the longer the train runs.
      const arrivedType = this.stationType.get(train.to);
      if (arrivedType && RAIL_PAYOUT_TYPES.includes(arrivedType) && this.grid.ownerOf(train.to) === train.owner) {
        this.grid.addGold(train.owner, trainGold(train.visits));
      }
      train.visits += 1;
      if (train.visits >= TRAIN_MAX_VISITS) continue;

      const next = this.nextHop(train.to, train.from);
      if (next === null) continue; // Isolated station; retire.
      const overshoot = train.progress - edge.length;
      train.from = train.to;
      train.to = next;
      train.progress = overshoot;
      survivors.push(train);
    }
    this.trains = survivors;
  }

  /**
   * The station a train continues to from `station`, having arrived from
   * `cameFrom`. Prefers any neighbour other than where it came from (lowest ref
   * for determinism) so it threads through the network; reverses at a dead end.
   */
  private nextHop(station: TileRef, cameFrom: TileRef): TileRef | null {
    const neighbors = this.network.adjacency.get(station);
    if (!neighbors || neighbors.length === 0) return null;
    let best: TileRef | null = null;
    for (const n of neighbors) {
      if (n === cameFrom) continue;
      if (best === null || n < best) best = n;
    }
    return best ?? cameFrom;
  }

  /**
   * Run one spawn *attempt* per connected factory each tick, mirroring OpenFront's
   * `trainSpawnRate` = `(numFactories + 10) · 15`: a factory launches a train once
   * its rejection counter reaches that rate, then resets — so the more factories an
   * owner runs, the *less* often each one launches (the network shares the spawn
   * budget). A per-factory cooldown floors the gap between two trains, the owner's
   * live-train cap still applies, and the departure neighbour rotates by tick so
   * successive trains fan out across a hub's links.
   */
  private attemptTrainSpawns(tick: number): void {
    const liveByOwner = new Map<PlayerId, number>();
    for (const train of this.trains) {
      liveByOwner.set(train.owner, (liveByOwner.get(train.owner) ?? 0) + 1);
    }

    const factories: TileRef[] = [];
    for (const [ref, type] of this.stationType) {
      if (type === "factory" && (this.network.adjacency.get(ref)?.length ?? 0) > 0) {
        factories.push(ref);
      }
    }
    factories.sort((a, b) => a - b);

    // Factories each owner runs — feeds OpenFront's per-owner spawn rate.
    const factoriesByOwner = new Map<PlayerId, number>();
    for (const factory of factories) {
      const owner = this.grid.ownerOf(factory);
      factoriesByOwner.set(owner, (factoriesByOwner.get(owner) ?? 0) + 1);
    }

    for (const factory of factories) {
      const owner = this.grid.ownerOf(factory);
      if ((liveByOwner.get(owner) ?? 0) >= TRAIN_MAX_PER_PLAYER) continue;
      // Respect the minimum gap between two trains from the same factory.
      const last = this.lastTrainSpawn.get(factory);
      if (last !== undefined && tick - last < TRAIN_SPAWN_MIN_COOLDOWN_TICKS) continue;

      const rate = trainSpawnRate(factoriesByOwner.get(owner) ?? 1);
      const rejected = this.trainRejections.get(factory) ?? 0;
      if (rejected < rate) {
        this.trainRejections.set(factory, rejected + 1);
        continue;
      }

      const neighbors = [...this.network.adjacency.get(factory)!].sort((a, b) => a - b);
      const to = neighbors[tick % neighbors.length];
      this.trains.push({ id: this.nextTrainId++, owner, from: factory, to, progress: 0, visits: 0 });
      this.trainRejections.set(factory, 0);
      this.lastTrainSpawn.set(factory, tick);
      liveByOwner.set(owner, (liveByOwner.get(owner) ?? 0) + 1);
    }
  }

  /** Interpolate a train's position (fractional tile) along its current edge. */
  private trainPosition(train: Train): { x: number; y: number } {
    const map = this.grid.map;
    const edge = this.edgeByPair.get(railPairKey(train.from, train.to));
    if (!edge) return { x: map.x(train.from), y: map.y(train.from) };
    // Corner tiles in travel order (the edge stores them a→b).
    const corners = edge.a === train.from ? edge.corners : [...edge.corners].reverse();
    let remaining = train.progress;
    for (let i = 0; i < corners.length - 1; i += 1) {
      const px = map.x(corners[i]);
      const py = map.y(corners[i]);
      const qx = map.x(corners[i + 1]);
      const qy = map.y(corners[i + 1]);
      const segLen = Math.abs(qx - px) + Math.abs(qy - py);
      if (remaining <= segLen || i === corners.length - 2) {
        const f = segLen === 0 ? 0 : Math.min(1, remaining / segLen);
        return { x: px + (qx - px) * f, y: py + (qy - py) * f };
      }
      remaining -= segLen;
    }
    return { x: map.x(train.to), y: map.y(train.to) };
  }
}
