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
} from "../Server/simulationConfig.js";

interface QueuedAttack {
  clientId: string;
  teamId: TeamId;
  order: AttackOrder;
}

export interface TickResult {
  snapshot: GameStateSnapshot;
  rejections: Array<{ clientId: string; rejection: ActionRejectedEvent }>;
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
});

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const appendEvent = (snapshot: GameStateSnapshot, event: string): void => {
  snapshot.recentEvents = [event, ...snapshot.recentEvents].slice(0, MAX_EVENTS);
};

const conflictId = (sourceTerritoryId: string, targetTerritoryId: string): string =>
  `${sourceTerritoryId}→${targetTerritoryId}`;

export class MapState {
  private state: GameStateSnapshot;

  public constructor(initialState: GameStateSnapshot = createInitialState()) {
    this.state = structuredClone(initialState);
  }

  public getSnapshot(): GameStateSnapshot {
    return structuredClone(this.state);
  }

  public processTick(attacks: QueuedAttack[]): TickResult {
    const rejections: TickResult["rejections"] = [];

    for (const attack of attacks) {
      const rejection = this.validateAttack(attack.teamId, attack.order);
      if (rejection) {
        rejections.push({ clientId: attack.clientId, rejection });
        continue;
      }

      this.startOrReinforceConflict(attack.teamId, attack.order);
    }

    this.advanceConflicts();

    this.state.tick += 1;
    return {
      snapshot: this.getSnapshot(),
      rejections,
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
}

export type { QueuedAttack, Territory };
