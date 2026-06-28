import {
  ActionRejectedEvent,
  ActiveConflict,
  AttackOrder,
  GameStateSnapshot,
  TeamId,
  TeamState,
  Territory,
} from "./types.js";
import { createTerritories, territoryOrder } from "./mapData.js";
import {
  ATTRITION_RATE,
  CONFLICT_ADVANCE_RATE,
  CONFLICT_INITIAL_PROGRESS,
  CONFLICT_RETREAT_RATE,
  INCOME_PER_TICK,
  MAX_TROOPS_PER_TERRITORY,
} from "./conflictConfig.js";

interface QueuedAttack {
  clientId: string;
  teamId: TeamId;
  order: AttackOrder;
}

export interface TickResult {
  snapshot: GameStateSnapshot;
  rejections: Array<{ clientId: string; rejection: ActionRejectedEvent }>;
  /** True on the tick the winner is first determined; false on every other tick. */
  matchJustEnded: boolean;
}

const MAX_EVENTS = 10;
const MIN_CAPTURE_GARRISON = 1;

const createTeams = (): Record<TeamId, TeamState> => ({
  blue: { id: "blue", name: "Blue Team", color: "#3b82f6" },
  red: { id: "red", name: "Red Team", color: "#ef4444" },
});

const createInitialState = (): GameStateSnapshot => ({
  tick: 0,
  mapName: "Conqueror Basin",
  teams: createTeams(),
  territories: createTerritories(),
  territoryOrder,
  recentEvents: ["Match started."],
  activeConflicts: [],
  winnerTeamId: null,
});

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const appendEvent = (snapshot: GameStateSnapshot, event: string): void => {
  snapshot.recentEvents = [event, ...snapshot.recentEvents].slice(0, MAX_EVENTS);
};

const conflictId = (sourceTerritoryId: string, targetTerritoryId: string): string =>
  `${sourceTerritoryId}→${targetTerritoryId}`;

export class MapState {
  private state: GameStateSnapshot;
  /**
   * Fractional troop income accumulated per territory. Kept private so the
   * public snapshot stays integer-clean. Drained into `troops` whenever the
   * accumulator reaches >= 1.
   */
  private growthAccumulator: Record<string, number> = {};

  public constructor(initialState: GameStateSnapshot = createInitialState()) {
    this.state = structuredClone(initialState);
    for (const id of this.state.territoryOrder) {
      this.growthAccumulator[id] = 0;
    }
  }

  public getSnapshot(): GameStateSnapshot {
    return structuredClone(this.state);
  }

  public processTick(attacks: QueuedAttack[]): TickResult {
    const rejections: TickResult["rejections"] = [];

    // Match already over: ignore all incoming attacks, no growth, no conflicts.
    if (this.state.winnerTeamId !== null) {
      for (const attack of attacks) {
        rejections.push({
          clientId: attack.clientId,
          rejection: {
            reason: "MATCH_ENDED",
            message: "The match has already ended.",
            order: attack.order,
          },
        });
      }
      this.state.tick += 1;
      return {
        snapshot: this.getSnapshot(),
        rejections,
        matchJustEnded: false,
      };
    }

    for (const attack of attacks) {
      const rejection = this.validateAttack(attack.teamId, attack.order);
      if (rejection) {
        rejections.push({ clientId: attack.clientId, rejection });
        continue;
      }

      this.startOrReinforceConflict(attack.teamId, attack.order);
    }

    this.applyTroopGrowth();
    this.advanceConflicts();

    const matchJustEnded = this.checkVictory();

    this.state.tick += 1;
    return {
      snapshot: this.getSnapshot(),
      rejections,
      matchJustEnded,
    };
  }

  private validateAttack(teamId: TeamId, order: AttackOrder): ActionRejectedEvent | null {
    const source = this.state.territories[order.sourceTerritoryId];
    const target = this.state.territories[order.targetTerritoryId];

    if (!source || !target) {
      return {
        reason: "INVALID_TERRITORY",
        message: "Unknown source or target territory.",
        order,
      };
    }

    if (!isPositiveInteger(order.troops)) {
      return {
        reason: "INVALID_TROOP_COUNT",
        message: "Troop count must be a positive integer.",
        order,
      };
    }

    if (source.ownerId !== teamId) {
      return {
        reason: "NOT_OWNER",
        message: "You can only attack from your own territory.",
        order,
      };
    }

    if (source.ownerId === target.ownerId) {
      return {
        reason: "SAME_OWNER",
        message: "Target territory is owned by your team.",
        order,
      };
    }

    if (!source.neighbors.includes(target.id)) {
      return {
        reason: "NOT_ADJACENT",
        message: "You can only attack adjacent territories.",
        order,
      };
    }

    const maxAttackTroops = source.troops - 1;
    if (maxAttackTroops < 1 || order.troops > maxAttackTroops) {
      return {
        reason: "INSUFFICIENT_TROOPS",
        message: "Not enough troops. At least one troop must stay in the source territory.",
        order,
      };
    }

    // Only one active conflict per target territory is allowed. Reject if a
    // different team is already attacking the same target.
    const existingConflict = this.state.activeConflicts.find(
      (c) => c.targetTerritoryId === order.targetTerritoryId,
    );
    if (existingConflict && existingConflict.attackerTeamId !== teamId) {
      return {
        reason: "TERRITORY_CONTESTED",
        message: "Another team is already attacking that territory.",
        order,
      };
    }

    return null;
  }

  /**
   * Deduct the attacking troops from the source immediately (prevents
   * double-spending) and either create a new conflict or reinforce an
   * existing one from the same attacker.
   */
  private startOrReinforceConflict(attackerTeamId: TeamId, order: AttackOrder): void {
    const source = this.state.territories[order.sourceTerritoryId];
    const target = this.state.territories[order.targetTerritoryId];

    // Troops leave the source territory immediately.
    source.troops -= order.troops;

    const existingConflict = this.state.activeConflicts.find(
      (c) =>
        c.targetTerritoryId === order.targetTerritoryId &&
        c.attackerTeamId === attackerTeamId,
    );

    if (existingConflict) {
      existingConflict.attackingTroops += order.troops;
      appendEvent(
        this.state,
        `${this.state.teams[attackerTeamId].name} reinforced the attack on ${target.name} with ${order.troops} troops (${existingConflict.attackingTroops} total).`,
      );
      return;
    }

    const conflict: ActiveConflict = {
      id: conflictId(order.sourceTerritoryId, order.targetTerritoryId),
      attackerTeamId,
      defenderTeamId: target.ownerId,
      sourceTerritoryId: order.sourceTerritoryId,
      targetTerritoryId: order.targetTerritoryId,
      attackingTroops: order.troops,
      defendingTroops: target.troops,
      progress: CONFLICT_INITIAL_PROGRESS,
    };

    this.state.activeConflicts.push(conflict);
    appendEvent(
      this.state,
      `${this.state.teams[attackerTeamId].name} launched an attack on ${target.name} with ${order.troops} troops.`,
    );
  }

  /**
   * Each non-contested territory accumulates fractional income. When the
   * accumulator reaches >= 1, whole troops are flushed into `territory.troops`
   * up to MAX_TROOPS_PER_TERRITORY.
   *
   * Contested territories do not grow — the defending count is owned by the
   * conflict and synced back via `advanceConflicts`.
   */
  private applyTroopGrowth(): void {
    const contestedTargets = new Set<string>(
      this.state.activeConflicts.map((c) => c.targetTerritoryId),
    );

    for (const id of this.state.territoryOrder) {
      if (contestedTargets.has(id)) {
        continue;
      }
      const territory = this.state.territories[id];
      if (territory.troops >= MAX_TROOPS_PER_TERRITORY) {
        this.growthAccumulator[id] = 0;
        continue;
      }

      this.growthAccumulator[id] += INCOME_PER_TICK;
      if (this.growthAccumulator[id] >= 1) {
        const whole = Math.floor(this.growthAccumulator[id]);
        territory.troops = Math.min(MAX_TROOPS_PER_TERRITORY, territory.troops + whole);
        this.growthAccumulator[id] -= whole;
      }
    }
  }

  /**
   * Run one simulation step for every active conflict: apply attrition,
   * advance or retreat the front line, and resolve captures/repels.
   */
  private advanceConflicts(): void {
    const resolved: ActiveConflict[] = [];

    for (const conflict of this.state.activeConflicts) {
      const target = this.state.territories[conflict.targetTerritoryId];

      // Attrition: each side loses floor(opponent * ATTRITION_RATE), min 1.
      // Only apply if the opponent has troops left to fight back.
      const attackerLosses = conflict.defendingTroops > 0
        ? Math.max(1, Math.floor(conflict.defendingTroops * ATTRITION_RATE))
        : 0;
      const defenderLosses = conflict.attackingTroops > 0
        ? Math.max(1, Math.floor(conflict.attackingTroops * ATTRITION_RATE))
        : 0;

      conflict.attackingTroops = Math.max(0, conflict.attackingTroops - attackerLosses);
      conflict.defendingTroops = Math.max(0, conflict.defendingTroops - defenderLosses);

      // Advance or retreat the front line.
      if (conflict.attackingTroops > conflict.defendingTroops) {
        conflict.progress = Math.min(1, conflict.progress + CONFLICT_ADVANCE_RATE);
      } else if (conflict.defendingTroops > conflict.attackingTroops) {
        conflict.progress = Math.max(0, conflict.progress - CONFLICT_RETREAT_RATE);
      }

      // Resolution: capture.
      if (conflict.progress >= 1 || conflict.defendingTroops <= 0) {
        const garrison = Math.max(MIN_CAPTURE_GARRISON, conflict.attackingTroops);
        const previousOwner = target.ownerId;
        target.ownerId = conflict.attackerTeamId;
        target.troops = garrison;
        // Reset growth accumulator on capture so the new owner doesn't inherit
        // a half-cooked progress bar from the previous owner.
        this.growthAccumulator[target.id] = 0;
        appendEvent(
          this.state,
          `${this.state.teams[conflict.attackerTeamId].name} captured ${target.name} from ${this.state.teams[previousOwner].name} and established a ${garrison}-troop garrison.`,
        );
        resolved.push(conflict);
        continue;
      }

      // Resolution: repelled.
      if (conflict.progress <= 0 || conflict.attackingTroops <= 0) {
        appendEvent(
          this.state,
          `${this.state.teams[conflict.defenderTeamId].name} repelled the attack on ${target.name}. ${conflict.defendingTroops} defender troops remain.`,
        );
        // Sync surviving defender troops back to the territory.
        target.troops = conflict.defendingTroops;
        resolved.push(conflict);
        continue;
      }

      // Conflict ongoing — sync defending troop count to territory so the
      // client can display live numbers.
      target.troops = conflict.defendingTroops;
    }

    this.state.activeConflicts = this.state.activeConflicts.filter(
      (c) => !resolved.includes(c),
    );
  }

  /**
   * If every territory is owned by the same team and no conflicts are active,
   * declare that team the winner. Returns true on the tick the winner is
   * first detected (so the session can fire SERVER_MATCH_ENDED exactly once).
   */
  private checkVictory(): boolean {
    if (this.state.winnerTeamId !== null) {
      return false;
    }
    if (this.state.activeConflicts.length > 0) {
      return false;
    }

    let candidate: TeamId | null = null;
    for (const id of this.state.territoryOrder) {
      const owner = this.state.territories[id].ownerId;
      if (candidate === null) {
        candidate = owner;
      } else if (candidate !== owner) {
        return false;
      }
    }

    if (candidate === null) {
      return false;
    }

    this.state.winnerTeamId = candidate;
    appendEvent(
      this.state,
      `${this.state.teams[candidate].name} has conquered the map. Match ended.`,
    );
    return true;
  }
}

export type { QueuedAttack, Territory };
