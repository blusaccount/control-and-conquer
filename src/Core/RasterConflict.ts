import type { TileRef } from "./GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import {
  DEFENDER_LOSS_PER_TILE,
  ELEVATION_COST_PER_LEVEL,
  ENEMY_CAPTURE_SURCHARGE,
  EXPANSION_SPEND_FRACTION,
  INCOME_PER_TILE_PER_TICK,
  MAX_POOL_PER_TILE,
  NEUTRAL_CAPTURE_COST,
} from "./rasterCombatConfig.js";

/** A request to expand from `attacker`'s territory into `target`'s tiles. */
export interface AttackIntent {
  attacker: PlayerId;
  /** Player whose tiles are targeted, or {@link NEUTRAL_PLAYER} for free land. */
  target: PlayerId;
  /** Troops to commit from the attacker's pool. Positive integer. */
  troops: number;
}

export type AttackRejectReason =
  | "UNKNOWN_PLAYER"
  | "INVALID_TARGET"
  | "INVALID_TROOP_COUNT"
  | "INSUFFICIENT_TROOPS"
  | "NO_FRONTIER";

export interface RasterTickResult {
  tick: number;
  /** Set once a single player owns every capturable tile, else null. */
  winner: PlayerId | null;
  rejections: Array<{ intent: AttackIntent; reason: AttackRejectReason }>;
  /** Number of attacks still in progress after this tick. */
  activeAttacks: number;
}

/** An in-flight expansion. `committed` troops are drained as tiles are taken. */
interface RasterAttack {
  attacker: PlayerId;
  target: PlayerId;
  committed: number;
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
  private readonly incomeAccumulator = new Map<PlayerId, number>();
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
    if (!this.grid.hasFrontier(attacker, target)) return "NO_FRONTIER";

    this.grid.addTroops(attacker, -troops);
    const existing = this.attacks.find((a) => a.attacker === attacker && a.target === target);
    if (existing) {
      existing.committed += troops;
    } else {
      this.attacks.push({ attacker, target, committed: troops });
    }
    return null;
  }

  /** Advance the simulation by one tick. */
  processTick(intents: AttackIntent[] = []): RasterTickResult {
    const rejections: RasterTickResult["rejections"] = [];

    if (this.winnerId !== null) {
      this.tickCount += 1;
      return { tick: this.tickCount, winner: this.winnerId, rejections, activeAttacks: 0 };
    }

    for (const intent of intents) {
      const reason = this.launchAttack(intent);
      if (reason) rejections.push({ intent, reason });
    }

    this.applyIncome();
    this.advanceAttacks();
    this.checkVictory();

    this.tickCount += 1;
    return {
      tick: this.tickCount,
      winner: this.winnerId,
      rejections,
      activeAttacks: this.attacks.length,
    };
  }

  /** Troop cost to capture a single tile, factoring terrain and ownership. */
  private captureCost(ref: TileRef, target: PlayerId): number {
    const base = target === NEUTRAL_PLAYER
      ? NEUTRAL_CAPTURE_COST
      : NEUTRAL_CAPTURE_COST + ENEMY_CAPTURE_SURCHARGE;
    const elevationCost = this.grid.map.magnitude(ref) * ELEVATION_COST_PER_LEVEL;
    return Math.ceil(base + elevationCost);
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
   * Run one expansion step per active attack. Each attack captures tiles from a
   * snapshot of its current frontier, in deterministic order, until its per-tick
   * spend budget is used up or it can no longer afford the cheapest tile. Stalled
   * attacks (no frontier, or troops too low) end and refund their leftover troops.
   */
  private advanceAttacks(): void {
    const survivors: RasterAttack[] = [];

    for (const attack of this.attacks) {
      const frontier = this.grid.frontierOf(attack.attacker, attack.target);

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
