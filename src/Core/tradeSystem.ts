/**
 * Trade-ship economy over the player ports.
 *
 * OpenFront's ports exist to trade: a port periodically dispatches a trade ship
 * to another port reachable across a shared body of water, and on arrival BOTH
 * the source and destination port owners are paid `tradeShipGold(dist)` (see the
 * Trade Ship wiki / `TradeShipExecution`). This class owns that simulation — it
 * keeps a port roster in sync, dispatches and moves ships, and banks the payouts
 * — all deterministically (fixed spawn cadence, route picks break ties by tile
 * ref, straight-line interpolation; no `Math.random`), so it stays replay-stable
 * like the rail economy. `RasterConflict` ticks it once per tick and reads
 * {@link tradeViews} for the snapshot.
 *
 * Routing is simplified relative to OpenFront: eligibility is real (two ports may
 * trade only if they border the *same* connected body of water), but the lane is
 * interpolated straight between the ports and the trip distance is their
 * Manhattan separation, rather than an A* water path. This keeps the system
 * cheap and deterministic; a future pass can sail the actual shoreline route.
 */
import type { TileRef } from "./GameMap.js";
import { type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  TRADE_SHIP_SPAWN_INTERVAL_TICKS,
  TRADE_SHIP_TILES_PER_TICK,
  tradeFleetCap,
  tradePayoutDistance,
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
  /** Tiles sailed so far along the straight lane. */
  progress: number;
  /** Lane length in tiles (Manhattan separation of the two ports). */
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
      if (ship.progress < ship.dist) {
        survivors.push(ship);
        continue;
      }
      // Arrived: pay both ports their gold, provided each still exists. The
      // owners are read live so a port captured mid-voyage pays its new owner.
      // The trip is *priced* at a map-relative distance so trade pays back a port
      // on small maps too, not just OpenFront-scale ones (see tradePayoutDistance).
      const span = this.grid.map.width + this.grid.map.height;
      const gold = tradeShipGold(tradePayoutDistance(ship.dist, span));
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
    // Ports each owner holds — the fleet cap scales with this so more ports means
    // more simultaneous trade (income tracks the coastal empire, as in OpenFront).
    const portsByOwner = new Map<PlayerId, number>();
    for (const p of this.ports) portsByOwner.set(p.owner, (portsByOwner.get(p.owner) ?? 0) + 1);

    const sorted = [...this.ports].sort((a, b) => a.ref - b.ref);
    for (const src of sorted) {
      if (src.sea < 0) continue;
      if ((liveByOwner.get(src.owner) ?? 0) >= tradeFleetCap(portsByOwner.get(src.owner) ?? 0)) continue;
      // Partners: any other port on the same sea body (any owner — trade flows
      // even between rivals, as in OpenFront, enriching both ends).
      const partners = sorted.filter((p) => p.ref !== src.ref && p.sea === src.sea);
      if (partners.length === 0) continue;
      const dst = partners[epoch % partners.length];
      const dist = Math.abs(this.grid.map.x(src.ref) - this.grid.map.x(dst.ref)) +
        Math.abs(this.grid.map.y(src.ref) - this.grid.map.y(dst.ref));
      if (dist <= 0) continue;
      this.ships.push({ id: this.nextShipId++, owner: src.owner, from: src.ref, to: dst.ref, progress: 0, dist });
      liveByOwner.set(src.owner, (liveByOwner.get(src.owner) ?? 0) + 1);
    }
  }

  /** Interpolate a trade ship's position (fractional tile) along its lane. */
  private shipPosition(ship: TradeShip): { x: number; y: number } {
    const map = this.grid.map;
    const f = ship.dist === 0 ? 1 : Math.min(1, ship.progress / ship.dist);
    return {
      x: map.x(ship.from) + (map.x(ship.to) - map.x(ship.from)) * f,
      y: map.y(ship.from) + (map.y(ship.to) - map.y(ship.from)) * f,
    };
  }
}
