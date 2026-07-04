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
 * border the *same* connected body of water and belong to *different* owners
 * (trade is inter-player — your own second port is never a partner), and a
 * dispatched ship sails the actual water route between them
 * ({@link TerritoryGrid.findWaterRoute}) — the shortest shore-to-shore path
 * through the sea — rather than cutting a straight line across intervening
 * land. Trip *gold* is priced on the tiles the ship actually sails
 * (OpenFront's `tradeShipGold(dist)` over the travelled distance), so a long
 * coast-hugging detour pays like the long haul it is.
 *
 * A warship doesn't sink an enemy trade ship — it **captures** it (OpenFront's
 * piracy): the ship changes owner mid-sea and sails on to the captor's nearest
 * reachable port, which alone is paid on arrival ({@link captureShip}).
 */
import type { TileRef } from "./GameMap.js";
import { type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  TRADE_SPAWN_ATTEMPT_INTERVAL_TICKS,
  TRADE_SHIP_TILES_PER_TICK,
  tradeShipGold,
  tradeShipSpawnRate,
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
  /** The ship's current owner: the dispatching port's owner, or its captor. */
  owner: PlayerId;
  from: TileRef;
  to: TileRef;
  /** Water route `[from, water…water, to]` the ship follows shore-to-shore. */
  path: TileRef[];
  /** Tiles sailed so far along {@link path}. */
  progress: number;
  /**
   * Tiles sailed on earlier, abandoned paths (before a capture redirect).
   * The payout is priced on the *total* travelled distance: this plus the
   * current path's hops.
   */
  sailedBefore: number;
  /** True once a warship captured it — only the destination port is paid then. */
  captured: boolean;
}

/** Wire-ready view of one trade ship: its owner and fractional tile position. */
export interface TradeView {
  owner: PlayerId;
  x: number;
  y: number;
}

/** Targeting view of one live trade ship — id + position, for a warship's target scan. */
export interface TradeShipTarget {
  id: number;
  owner: PlayerId;
  /**
   * Owner of the destination port (read live). The wiki's warships only chase
   * trade ships that are NOT heading to their own owner's ports — an inbound
   * trader is about to pay that port in full, so it is left alone.
   */
  toOwner: PlayerId;
  x: number;
  y: number;
}

export class TradeSystem {
  private readonly grid: TerritoryGrid;
  /**
   * Directed embargo predicate: `isEmbargoed(a, b)` is true when trade between
   * owners `a` and `b` is barred (either side embargoing the other). Injected
   * from the diplomacy graph so a port never dispatches to an embargoed rival.
   * Defaults to "never embargoed" for callers/tests that don't wire diplomacy.
   */
  private readonly isEmbargoed: (a: PlayerId, b: PlayerId) => boolean;
  private ports: TradePort[] = [];
  private ships: TradeShip[] = [];
  private nextShipId = 1;
  /** Signature of the port set the roster was last built from. */
  private signature = "";
  /**
   * Per-port rejection counter for OpenFront's `tradeShipSpawnRate`. Each failed
   * spawn attempt bumps it; a successful dispatch resets it to 0. Keyed by port
   * tile ref; pruned when a port is removed.
   */
  private rejections = new Map<TileRef, number>();

  constructor(grid: TerritoryGrid, isEmbargoed: (a: PlayerId, b: PlayerId) => boolean = () => false) {
    this.grid = grid;
    this.isEmbargoed = isEmbargoed;
  }

  /**
   * Advance the trade economy one tick: refresh the port roster if it changed,
   * move every ship (paying out on arrivals), then run OpenFront's per-port spawn
   * attempts on the fixed 10-tick cadence. `tick` is the tick being processed.
   */
  advance(tick: number): void {
    this.sync();
    this.moveShips();
    if (tick % TRADE_SPAWN_ATTEMPT_INTERVAL_TICKS === 0) this.attemptSpawns(tick);
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

  /** Every live trade ship's id, owner, destination owner and position — a warship's target scan reads this. */
  targetableShips(): TradeShipTarget[] {
    return this.ships.map((ship) => {
      const { x, y } = this.shipPosition(ship);
      return { id: ship.id, owner: ship.owner, toOwner: this.grid.ownerOf(ship.to), x, y };
    });
  }

  /** Sink a trade ship by id — no payout, it just vanishes. Returns whether one was removed. */
  destroyShip(id: number): boolean {
    const before = this.ships.length;
    this.ships = this.ships.filter((s) => s.id !== id);
    return this.ships.length < before;
  }

  /**
   * **Capture** a trade ship for `captor` — OpenFront's piracy: the ship
   * changes owner where it sails and is redirected to the captor's nearest
   * reachable port, which alone is paid `tradeShipGold` of the ship's *total*
   * travelled distance on arrival (the original ports get nothing). When the
   * captor has no port the ship can reach, it is sunk instead — a pirate with
   * no harbour takes no prizes. Returns true if the ship was captured (false:
   * unknown id or sunk-for-lack-of-port).
   */
  captureShip(id: number, captor: PlayerId): boolean {
    const ship = this.ships.find((s) => s.id === id);
    if (!ship) return false;
    const last = ship.path.length - 1;
    const at = Math.max(0, Math.min(last, Math.floor(ship.progress)));
    const cur = ship.path[at];

    // The captor's ports, nearest first (Manhattan) — try each until a water
    // route from the ship's current tile works, so an unreachable port on
    // another sea never strands the prize.
    const map = this.grid.map;
    const candidates = this.ports
      .filter((p) => p.owner === captor && p.ref !== cur)
      .map((p) => ({
        ref: p.ref,
        d: Math.abs(map.x(p.ref) - map.x(cur)) + Math.abs(map.y(p.ref) - map.y(cur)),
      }))
      .sort((a, b) => a.d - b.d || a.ref - b.ref);
    for (const c of candidates) {
      const route = this.grid.findWaterRoute(cur, c.ref);
      if (!route || route.length < 2) continue;
      ship.sailedBefore += at;
      ship.owner = captor;
      ship.from = cur;
      ship.to = c.ref;
      ship.path = route;
      ship.progress = 0;
      ship.captured = true;
      return true;
    }
    this.destroyShip(id);
    return false;
  }

  /** Rebuild the port roster only when the port set actually changed. */
  private sync(): void {
    const ports = this.collectPorts();
    const signature = ports.map((p) => `${p.ref}:${p.owner}:${p.sea}`).join(",");
    if (signature === this.signature) return;
    this.signature = signature;
    this.ports = ports;
    // Drop ships whose endpoints are no longer ports. A captured ship's `from`
    // is open water (the capture point), so only its destination must stand.
    const live = new Set(ports.map((p) => p.ref));
    this.ships = this.ships.filter((s) => live.has(s.to) && (s.captured || live.has(s.from)));
    // Forget rejection counters for ports that no longer exist.
    for (const ref of [...this.rejections.keys()]) if (!live.has(ref)) this.rejections.delete(ref);
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
   * Move every trade ship along its water route. On arrival it pays out
   * `tradeShipGold` of the tiles actually sailed (OpenFront prices the trip on
   * the travelled distance) and retires: a normal trip pays **both** port
   * owners in full; a captured ship pays only its captor's destination port.
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
      // Arrived: the payout is priced on the total distance the ship really
      // sailed (earlier abandoned legs plus this route). Owners are read live
      // so a port captured mid-voyage pays its new owner.
      const gold = tradeShipGold(ship.sailedBefore + ship.path.length - 1);
      if (!ship.captured && this.grid.buildingAt(ship.from) === "port") {
        this.grid.addGold(this.grid.ownerOf(ship.from), gold);
      }
      if (this.grid.buildingAt(ship.to) === "port") this.grid.addGold(this.grid.ownerOf(ship.to), gold);
    }
    this.ships = survivors;
  }

  /**
   * Run one spawn *attempt* per eligible port, mirroring OpenFront's
   * `tradeShipSpawnRate`. A port fires a trade ship once its rejection counter
   * reaches the current rate (which itself depends on that counter and the global
   * fleet's soft cap); otherwise the attempt is "rejected" and the counter grows,
   * so the port fires soon after. There is no hard fleet cap — the soft cap in the
   * rate (sigmoid on the total ships at sea, midpoint ~400) does the throttling.
   * The destination is any port sharing the source's sea body, chosen by a
   * tick-derived epoch so successive dispatches fan out across partners.
   */
  private attemptSpawns(tick: number): void {
    if (this.ports.length < 2) return;
    const epoch = Math.floor(tick / TRADE_SPAWN_ATTEMPT_INTERVAL_TICKS);
    const sorted = [...this.ports].sort((a, b) => a.ref - b.ref);
    for (const src of sorted) {
      if (src.sea < 0) continue;
      // Partners: another *player's* port on the same sea body — trade is
      // inter-player, as in OpenFront (your own second port is never a
      // partner, so there is no risk-free self-trade double payout), and it
      // flows even between rivals, enriching both ends — except owners this
      // port has (or is under) an embargo with, who are skipped.
      const partners = sorted.filter(
        (p) =>
          p.ref !== src.ref &&
          p.owner !== src.owner &&
          p.sea === src.sea &&
          !this.isEmbargoed(src.owner, p.owner),
      );
      if (partners.length === 0) continue; // no reachable partner — not a rejection, just skip

      const rejected = this.rejections.get(src.ref) ?? 0;
      const rate = tradeShipSpawnRate(rejected, this.ships.length);
      if (rejected < rate) {
        // Attempt "fails" this cycle: grow the counter so the port fires
        // sooner. An upgraded port advances by its level per attempt, so a
        // level-2 port reaches its spawn rate twice as fast (per-level station
        // cadence, OpenFront's structure upgrades).
        this.rejections.set(src.ref, rejected + this.grid.buildingLevelOf(src.ref));
        continue;
      }

      const dst = partners[epoch % partners.length];
      // Sail the real water route between the ports (the shore-hugging path);
      // skip the pairing if — despite sharing a sea component — no shore-to-shore
      // path can be traced (defensive). The payout is priced on this route's
      // length when the ship arrives.
      const path = this.grid.findWaterRoute(src.ref, dst.ref);
      if (!path || path.length < 2) continue;
      this.ships.push({
        id: this.nextShipId++,
        owner: src.owner,
        from: src.ref,
        to: dst.ref,
        path,
        progress: 0,
        sailedBefore: 0,
        captured: false,
      });
      // Successful dispatch resets the port's rejection counter (OpenFront spawn rate).
      this.rejections.set(src.ref, 0);
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
