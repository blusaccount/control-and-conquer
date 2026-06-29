import type { TileRef } from "./GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  DEFENDER_LOSS_PER_TILE,
  ELEVATION_COST_PER_LEVEL,
  ENEMY_CAPTURE_SURCHARGE,
  EXPANSION_SPEND_FRACTION,
  INCOME_PER_TILE_PER_TICK,
  MAX_POOL_PER_TILE,
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  NEUTRAL_CAPTURE_COST,
  SEA_CROSSING_SURCHARGE,
  SHIP_TILES_PER_TICK,
} from "./rasterCombatConfig.js";

/** A request to expand from `attacker`'s territory into `target`'s tiles. */
export interface AttackIntent {
  attacker: PlayerId;
  /** Player whose tiles are targeted, or {@link NEUTRAL_PLAYER} for free land. */
  target: PlayerId;
  /** Troops to commit from the attacker's pool. Positive integer. */
  troops: number;
}

/**
 * A request to send a transport ship across water to land on (and capture) a
 * specific tile. Unlike an {@link AttackIntent} this targets one destination
 * rather than a whole player's frontier — the ship sails the shortest water
 * route to `dest` and disembarks there.
 */
export interface SeaAttackIntent {
  attacker: PlayerId;
  /** The capturable tile the ship sails to and lands on. */
  dest: TileRef;
  /** Troops loaded onto the ship from the attacker's pool. Positive integer. */
  troops: number;
}

export type AttackRejectReason =
  | "UNKNOWN_PLAYER"
  | "INVALID_TARGET"
  | "INVALID_TROOP_COUNT"
  | "INSUFFICIENT_TROOPS"
  | "NO_FRONTIER"
  | "TOO_MANY_SHIPS";

/**
 * A single amphibious landing resolved this tick: a player captured tile `to`
 * by crossing water from its coastal tile `from`. Surfaced so the client can
 * flash the moment a transport ship disembarks.
 */
export interface SeaCrossing {
  attacker: PlayerId;
  from: TileRef;
  to: TileRef;
}

/** Public view of one transport ship in flight, for snapshotting/animation. */
export interface TransportShipState {
  id: number;
  attacker: PlayerId;
  /** The tile the ship currently occupies along its route. */
  tile: TileRef;
  /** Troops aboard. */
  troops: number;
}

export interface RasterTickResult {
  tick: number;
  /** Set once a single player owns every capturable tile, else null. */
  winner: PlayerId | null;
  rejections: Array<{ intent: AttackIntent; reason: AttackRejectReason }>;
  /** Number of attacks still in progress after this tick. */
  activeAttacks: number;
  /** Transport-ship landings that happened this tick (empty on most ticks). */
  crossings: SeaCrossing[];
}

/** An in-flight expansion. `committed` troops are drained as tiles are taken. */
interface RasterAttack {
  attacker: PlayerId;
  target: PlayerId;
  committed: number;
}

/** A transport ship en route to its landing tile. */
interface TransportShip {
  id: number;
  attacker: PlayerId;
  /** Troops aboard, disembarked on arrival. */
  troops: number;
  /** Land→water…→land route: [embarkation coast, …open water…, dest]. */
  path: TileRef[];
  /** Index into `path` of the ship's current position. */
  progress: number;
}

/**
 * Autonomous border-expansion conflict engine over a {@link TerritoryGrid}.
 *
 * Each tick: players earn income proportional to territory size, then every
 * active attack spends a slice of its committed troops to capture tiles along
 * the attacker's border — processed one BFS "ring" per tick so fronts grow
 * organically rather than teleporting. Higher ground and enemy-held tiles cost
 * more troops to take. A player who comes to own every capturable tile wins.
 *
 * Combat is autonomous: callers only express *intent* (commit N troops toward a
 * target); the engine resolves the actual frontier advance deterministically.
 */
export class RasterConflict {
  private readonly grid: TerritoryGrid;
  private readonly attacks: RasterAttack[] = [];
  /** Transport ships currently at sea, in launch order. */
  private readonly ships: TransportShip[] = [];
  /** Monotonic id source so each ship has a stable handle for the client. */
  private nextShipId = 1;
  private readonly incomeAccumulator = new Map<PlayerId, number>();
  /** Transport-ship landings resolved during the current tick. */
  private crossings: SeaCrossing[] = [];
  private tickCount = 0;
  private winnerId: PlayerId | null = null;

  constructor(grid: TerritoryGrid) {
    this.grid = grid;
  }

  get tick(): number {
    return this.tickCount;
  }

  get winner(): PlayerId | null {
    return this.winnerId;
  }

  get activeAttackCount(): number {
    return this.attacks.length;
  }

  /** Transport ships `attacker` currently has at sea. */
  shipCountOf(attacker: PlayerId): number {
    let count = 0;
    for (const ship of this.ships) if (ship.attacker === attacker) count += 1;
    return count;
  }

  /** Snapshot of every transport ship in flight, for serialization/animation. */
  activeShips(): TransportShipState[] {
    return this.ships.map((s) => ({
      id: s.id,
      attacker: s.attacker,
      tile: s.path[s.progress],
      troops: s.troops,
    }));
  }

  /**
   * Validate and register an attack intent. On success the committed troops
   * leave the attacker's pool immediately (preventing double-spend) and either
   * start a new attack or reinforce an existing attacker→target one. Returns a
   * reject reason without mutating state on failure.
   */
  launchAttack(intent: AttackIntent): AttackRejectReason | null {
    const { attacker, target, troops } = intent;

    if (!this.grid.hasPlayer(attacker)) return "UNKNOWN_PLAYER";
    if (target === attacker) return "INVALID_TARGET";
    if (target !== NEUTRAL_PLAYER && !this.grid.hasPlayer(target)) return "INVALID_TARGET";
    if (!Number.isInteger(troops) || troops <= 0) return "INVALID_TROOP_COUNT";
    if (troops > this.grid.troopsOf(attacker)) return "INSUFFICIENT_TROOPS";
    // A land attack pushes a contiguous front; it never crosses water (that is
    // the transport ship's job), so it requires a shared land border.
    if (!this.grid.hasLandBorderWith(attacker, target)) return "NO_FRONTIER";

    this.grid.addTroops(attacker, -troops);
    const existing = this.attacks.find((a) => a.attacker === attacker && a.target === target);
    if (existing) {
      existing.committed += troops;
    } else {
      this.attacks.push({ attacker, target, committed: troops });
    }
    return null;
  }

  /**
   * Validate and dispatch one transport ship toward `dest`. On success the
   * loaded troops leave the attacker's pool immediately and the ship begins
   * sailing the shortest water route next tick. A player may have at most
   * {@link MAX_TRANSPORT_SHIPS_PER_PLAYER} ships at sea; further launches are
   * rejected. Returns a reject reason without mutating state on failure.
   */
  launchShip(intent: SeaAttackIntent): AttackRejectReason | null {
    const { attacker, dest, troops } = intent;

    if (!this.grid.hasPlayer(attacker)) return "UNKNOWN_PLAYER";
    if (!this.grid.isCapturable(dest) || this.grid.ownerOf(dest) === attacker) return "INVALID_TARGET";
    if (!Number.isInteger(troops) || troops <= 0) return "INVALID_TROOP_COUNT";
    if (troops > this.grid.troopsOf(attacker)) return "INSUFFICIENT_TROOPS";
    if (this.shipCountOf(attacker) >= MAX_TRANSPORT_SHIPS_PER_PLAYER) return "TOO_MANY_SHIPS";

    const path = this.grid.findSeaPath(attacker, dest);
    if (!path) return "NO_FRONTIER";

    this.grid.addTroops(attacker, -troops);
    this.ships.push({ id: this.nextShipId++, attacker, troops, path, progress: 0 });
    return null;
  }

  /** Advance the simulation by one tick. */
  processTick(intents: AttackIntent[] = []): RasterTickResult {
    const rejections: RasterTickResult["rejections"] = [];

    if (this.winnerId !== null) {
      this.tickCount += 1;
      return { tick: this.tickCount, winner: this.winnerId, rejections, activeAttacks: 0, crossings: [] };
    }

    for (const intent of intents) {
      const reason = this.launchAttack(intent);
      if (reason) rejections.push({ intent, reason });
    }

    this.crossings = [];
    this.applyIncome();
    this.advanceShips();
    this.advanceAttacks();
    this.checkVictory();

    this.tickCount += 1;
    return {
      tick: this.tickCount,
      winner: this.winnerId,
      rejections,
      activeAttacks: this.attacks.length,
      crossings: this.crossings,
    };
  }

  /**
   * Troop cost to capture a single tile across a land border, factoring terrain
   * and ownership. Transport-ship landings price their beachhead separately via
   * {@link beachheadCost}.
   */
  private captureCost(ref: TileRef, target: PlayerId): number {
    const base = target === NEUTRAL_PLAYER
      ? NEUTRAL_CAPTURE_COST
      : NEUTRAL_CAPTURE_COST + ENEMY_CAPTURE_SURCHARGE;
    const elevationCost = this.grid.map.magnitude(ref) * ELEVATION_COST_PER_LEVEL;
    return Math.ceil(base + elevationCost);
  }

  /**
   * Troops a transport ship spends to seize its landing tile — the normal
   * capture cost plus the amphibious {@link SEA_CROSSING_SURCHARGE}, so an
   * opposed landing is dearer than walking the same tile over land.
   */
  private beachheadCost(ref: TileRef, target: PlayerId): number {
    return this.captureCost(ref, target) + SEA_CROSSING_SURCHARGE;
  }

  /**
   * Each player gains income proportional to the tiles they hold, accumulated
   * fractionally and flushed into the integer pool. The pool is capped relative
   * to territory size so it cannot grow without bound.
   */
  private applyIncome(): void {
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      const cap = tiles * MAX_POOL_PER_TILE;
      if (this.grid.troopsOf(id) >= cap) {
        this.incomeAccumulator.set(id, 0);
        continue;
      }
      const accumulated = (this.incomeAccumulator.get(id) ?? 0) + tiles * INCOME_PER_TILE_PER_TICK;
      const whole = Math.floor(accumulated);
      if (whole > 0) {
        const next = Math.min(cap, this.grid.troopsOf(id) + whole);
        this.grid.setTroops(id, next);
      }
      this.incomeAccumulator.set(id, accumulated - whole);
    }
  }

  /**
   * Advance every transport ship one step along its water route. A ship that
   * reaches its destination disembarks: it captures the landing tile (paying the
   * beachhead cost and bleeding the defender), then commits whatever troops
   * remain as a land attack radiating from the new beachhead. Landings are
   * recorded as {@link SeaCrossing}s for the client to flash.
   */
  private advanceShips(): void {
    const survivors: TransportShip[] = [];

    for (const ship of this.ships) {
      const lastIndex = ship.path.length - 1;
      ship.progress = Math.min(lastIndex, ship.progress + SHIP_TILES_PER_TICK);
      if (ship.progress < lastIndex) {
        survivors.push(ship);
        continue;
      }

      // Arrival. `dest` is the final path tile; `from` the open water it sailed
      // in from (or the embarkation coast for a one-hop river).
      const dest = ship.path[lastIndex];
      const from = ship.path[Math.max(0, lastIndex - 1)];
      this.crossings.push({ attacker: ship.attacker, from, to: dest });

      const owner = this.grid.ownerOf(dest);
      if (owner === ship.attacker) {
        // The beachhead is already ours (captured by land while the ship sailed);
        // the troops simply reinforce the pool.
        this.grid.addTroops(ship.attacker, ship.troops);
        continue;
      }

      const cost = this.beachheadCost(dest, owner);
      if (ship.troops < cost) {
        // Too few troops to force a landing — the assault is repelled and the
        // survivors fall back into the pool rather than vanishing.
        this.grid.addTroops(ship.attacker, ship.troops);
        continue;
      }

      if (owner !== NEUTRAL_PLAYER) this.grid.addTroops(owner, -DEFENDER_LOSS_PER_TILE);
      this.grid.claim(dest, ship.attacker);
      const remaining = ship.troops - cost;
      if (remaining >= NEUTRAL_CAPTURE_COST) {
        // Push the survivors inland: a land attack against the tile's former
        // owner, expanding from the freshly-taken beachhead.
        const existing = this.attacks.find((a) => a.attacker === ship.attacker && a.target === owner);
        if (existing) existing.committed += remaining;
        else this.attacks.push({ attacker: ship.attacker, target: owner, committed: remaining });
      } else {
        this.grid.addTroops(ship.attacker, remaining);
      }
    }

    this.ships.length = 0;
    this.ships.push(...survivors);
  }

  /**
   * Run one expansion step per active attack. Each attack captures tiles from a
   * snapshot of its current land frontier, in deterministic order, until its
   * per-tick spend budget is used up or it can no longer afford the cheapest
   * tile. Stalled attacks (no land frontier, or troops too low) end and refund
   * their leftover troops. Water is never crossed here — that is the transport
   * ship's role.
   */
  private advanceAttacks(): void {
    const survivors: RasterAttack[] = [];

    for (const attack of this.attacks) {
      const frontier = this.grid.landFrontierOf(attack.attacker, attack.target);

      // No reachable target tiles: the front is blocked or the target is gone.
      if (frontier.length === 0) {
        this.grid.addTroops(attack.attacker, attack.committed);
        continue;
      }

      // Spend at most this slice of the remaining troops this tick, but always
      // enough to attempt the cheapest possible capture so progress is steady.
      const budget = Math.max(NEUTRAL_CAPTURE_COST, attack.committed * EXPANSION_SPEND_FRACTION);
      let spent = 0;

      for (const ref of frontier) {
        // A tile may have been captured already if a player relinquished it; skip
        // anything no longer owned by the target.
        if (this.grid.ownerOf(ref) !== attack.target) continue;
        const cost = this.captureCost(ref, attack.target);
        if (attack.committed < cost || spent + cost > budget) continue;

        if (attack.target !== NEUTRAL_PLAYER) {
          this.grid.addTroops(attack.target, -DEFENDER_LOSS_PER_TILE);
        }
        this.grid.claim(ref, attack.attacker);
        attack.committed -= cost;
        spent += cost;
      }

      // End the attack (refunding leftovers) once it can no longer afford even
      // the cheapest neutral tile; otherwise carry it to the next tick.
      if (attack.committed < NEUTRAL_CAPTURE_COST) {
        this.grid.addTroops(attack.attacker, attack.committed);
      } else {
        survivors.push(attack);
      }
    }

    this.attacks.length = 0;
    this.attacks.push(...survivors);
  }

  /** Declare a winner if a single player owns every capturable tile. */
  private checkVictory(): void {
    if (this.winnerId !== null || this.grid.capturableCount === 0) return;
    for (const id of this.grid.players()) {
      if (this.grid.tileCountOf(id) === this.grid.capturableCount) {
        this.winnerId = id;
        return;
      }
    }
  }
}
