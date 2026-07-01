/**
 * Trade-ship economy over the player ports.
 *
 * OpenFront's ports exist to trade: a port periodically dispatches a trade ship
 * to another port reachable across a shared body of water, and on arrival BOTH
 * the source and destination port owners are paid `tradeShipGold(dist)` (see the
 * Trade Ship wiki / `TradeShipExecution`). This class owns that simulation — it
 * keeps a port roster in sync, dispatches and moves ships, and banks the payouts
 * — all deterministically (fixed spawn cadence, route picks break ties by tile
 * ref, a BFS water route; no `Math.random`), so it stays replay-stable like the
 * rail economy. `RasterConflict` ticks it once per tick and reads
 * {@link tradeViews} for the snapshot.
 *
 * Routing matches OpenFront's naval model: two ports may trade only if they
 * border the *same* connected body of water, and a dispatched ship sails the
 * actual water route between them ({@link TerritoryGrid.findWaterRoute}) — the
 * shortest shore-to-shore path through the sea — rather than cutting a straight
 * line across intervening land. Trip *gold* is still priced on the ports'
 * Manhattan separation (OpenFront's `tradeShipGold(dist)`), independent of how
 * far the ship actually has to sail to hug the coastline.
 */
import type { TileRef } from "./GameMap.js";
import { type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  TRADE_MAX_PER_PLAYER,
  TRADE_SHIP_SPAWN_INTERVAL_TICKS,
  TRADE_SHIP_TILES_PER_TICK,
  tradeShipGold,
} from "./buildings.js";

/** A port on the trade roster: its tile, owner, and the sea body it opens onto. */
interface TradePort {
  ref: TileRef;
  owner: PlayerId;
  /** Water-component id of an adjacent water tile, or -1 if landlocked. */
  sea: number;
}

/** A trade ship sailing from port `from` to port `to`. */
interface TradeShip {
  id: number;
  /** The dispatching (source) port's owner — used only to cap the fleet size. */
  owner: PlayerId;
  from: TileRef;
  to: TileRef;
  /** Water route `[from, water…water, to]` the ship follows shore-to-shore. */
  path: TileRef[];
  /** Tiles sailed so far along {@link path}. */
  progress: number;
  /** Manhattan separation of the two ports — the basis for the trade payout. */
  dist: number;
}

/** Wire-ready view of one trade ship: its owner and fractional tile position. */
export interface TradeView {
  owner: PlayerId;
  x: number;
  y: number;
}

export class TradeSystem {
  private readonly grid: TerritoryGrid;
  private ports: TradePort[] = [];
  private ships: TradeShip[] = [];
  private nextShipId = 1;
  /** Signature of the port set the roster was last built from. */
  private signature = "";

  constructor(grid: TerritoryGrid) {
    this.grid = grid;
  }

  /**
   * Advance the trade economy one tick: refresh the port roster if it changed,
   * move every ship (paying out on arrivals), then dispatch new ships on the
   * fixed cadence. `tick` is the simulation tick being processed.
   */
  advance(tick: number): void {
    this.sync();
    this.moveShips();
    if (tick % TRADE_SHIP_SPAWN_INTERVAL_TICKS === 0) this.dispatch(tick);
  }

  /** Every live trade ship as a fractional-tile position, owner-tagged. */
  tradeViews(): TradeView[] {
    return this.ships.map((ship) => {
      const { x, y } = this.shipPosition(ship);
      return { owner: ship.owner, x, y };
    });
  }

  /** Number of live trade ships (for tests). */
  get shipCount(): number {
    return this.ships.length;
  }

  /**
   * Live trade ships as integer-tile positions for a warship to hunt: each ship's
   * id, owner, and the tile it currently occupies. Rounded from the fractional
   * position, which is enough for a Chebyshev range check.
   */
  raidableShips(): Array<{ id: number; owner: PlayerId; tile: TileRef }> {
    const map = this.grid.map;
    return this.ships.map((ship) => {
      const { x, y } = this.shipPosition(ship);
      return { id: ship.id, owner: ship.owner, tile: map.ref(Math.round(x), Math.round(y)) };
    });
  }

  /**
   * A warship captures trade ship `id`: it never reaches port, and the raider
   * pockets the cargo — OpenFront pays the captor the trip's gold. Returns the
   * gold awarded, or 0 if the ship was already gone (e.g. captured this tick).
   */
  capture(id: number, capturer: PlayerId): number {
    const i = this.ships.findIndex((s) => s.id === id);
    if (i < 0) return 0;
    const [ship] = this.ships.splice(i, 1);
    const gold = tradeShipGold(ship.dist);
    this.grid.addGold(capturer, gold);
    return gold;
  }

  /** Rebuild the port roster only when the port set actually changed. */
  private sync(): void {
    const ports = this.collectPorts();
    const signature = ports.map((p) => `${p.ref}:${p.owner}:${p.sea}`).join(",");
    if (signature === this.signature) return;
    this.signature = signature;
    this.ports = ports;
    // Drop ships whose endpoints are no longer ports.
    const live = new Set(ports.map((p) => p.ref));
    this.ships = this.ships.filter((s) => live.has(s.from) && live.has(s.to));
  }

  /** Snapshot the ports with owner + the sea body they open onto. */
  private collectPorts(): TradePort[] {
    const out: TradePort[] = [];
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type !== "port") continue;
      let sea = -1;
      for (const n of this.grid.map.neighbors(ref)) {
        if (this.grid.map.isWater(n)) {
          sea = this.grid.waterComponentId(n);
          break;
        }
      }
      out.push({ ref, owner: this.grid.ownerOf(ref), sea });
    }
    return out;
  }

  /**
   * Move every trade ship along its straight lane. On arrival it pays both port
   * owners (if both ports still stand) `tradeShipGold(dist)` and retires.
   */
  private moveShips(): void {
    const survivors: TradeShip[] = [];
    for (const ship of this.ships) {
      ship.progress += TRADE_SHIP_TILES_PER_TICK;
      // The ship has arrived once it has walked to the last tile of its water
      // route (the destination port). Route length is one less than the tile
      // count: an N-tile path has N-1 hops between tiles.
      if (ship.progress < ship.path.length - 1) {
        survivors.push(ship);
        continue;
      }
      // Arrived: pay both ports their gold, provided each still exists. The
      // owners are read live so a port captured mid-voyage pays its new owner.
      const gold = tradeShipGold(ship.dist);
      if (this.grid.buildingAt(ship.from) === "port") this.grid.addGold(this.grid.ownerOf(ship.from), gold);
      if (this.grid.buildingAt(ship.to) === "port") this.grid.addGold(this.grid.ownerOf(ship.to), gold);
    }
    this.ships = survivors;
  }

  /**
   * Dispatch one trade ship from each eligible port whose owner is under the
   * fleet cap. The destination is another of the owner's reach: any port sharing
   * the source's sea body (different tile), chosen by a tick-derived epoch so
   * successive dispatches fan out across partners rather than always the first.
   */
  private dispatch(tick: number): void {
    if (this.ports.length < 2) return;
    const epoch = Math.floor(tick / TRADE_SHIP_SPAWN_INTERVAL_TICKS);
    const liveByOwner = new Map<PlayerId, number>();
    for (const ship of this.ships) liveByOwner.set(ship.owner, (liveByOwner.get(ship.owner) ?? 0) + 1);

    const sorted = [...this.ports].sort((a, b) => a.ref - b.ref);
    for (const src of sorted) {
      if (src.sea < 0) continue;
      if ((liveByOwner.get(src.owner) ?? 0) >= TRADE_MAX_PER_PLAYER) continue;
      // Partners: any other port on the same sea body (any owner — trade flows
      // even between rivals, as in OpenFront, enriching both ends).
      const partners = sorted.filter((p) => p.ref !== src.ref && p.sea === src.sea);
      if (partners.length === 0) continue;
      const dst = partners[epoch % partners.length];
      const dist = Math.abs(this.grid.map.x(src.ref) - this.grid.map.x(dst.ref)) +
        Math.abs(this.grid.map.y(src.ref) - this.grid.map.y(dst.ref));
      if (dist <= 0) continue;
      // Sail the real water route between the ports; skip the pairing if — despite
      // sharing a sea component — no shore-to-shore path can be traced (defensive).
      const path = this.grid.findWaterRoute(src.ref, dst.ref);
      if (!path || path.length < 2) continue;
      this.ships.push({ id: this.nextShipId++, owner: src.owner, from: src.ref, to: dst.ref, path, progress: 0, dist });
      liveByOwner.set(src.owner, (liveByOwner.get(src.owner) ?? 0) + 1);
    }
  }

  /**
   * A trade ship's position as a fractional tile, interpolated between the two
   * water-route tiles it currently sits between. Following the path tile-by-tile
   * (rather than lerping straight from port to port) is what keeps the dot on the
   * water and off the land.
   */
  private shipPosition(ship: TradeShip): { x: number; y: number } {
    const map = this.grid.map;
    const last = ship.path.length - 1;
    const clamped = Math.max(0, Math.min(last, ship.progress));
    const i = Math.min(last - 1, Math.floor(clamped));
    const frac = clamped - i;
    const a = ship.path[i];
    const b = ship.path[i + 1];
    return {
      x: map.x(a) + (map.x(b) - map.x(a)) * frac,
      y: map.y(a) + (map.y(b) - map.y(a)) * frac,
    };
  }
}
