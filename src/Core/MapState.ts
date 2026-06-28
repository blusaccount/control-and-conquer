import {
  ActionRejectedEvent,
  AttackOrder,
  GameStateSnapshot,
  TeamId,
  TeamState,
  Territory,
} from "./types.js";
import { createTerritories, territoryOrder } from "./mapData.js";

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
});

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const appendEvent = (snapshot: GameStateSnapshot, event: string): void => {
  snapshot.recentEvents = [event, ...snapshot.recentEvents].slice(0, MAX_EVENTS);
};

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

      this.resolveAttack(attack.teamId, attack.order);
    }

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

    return null;
  }

  private resolveAttack(attackerTeamId: TeamId, order: AttackOrder): void {
    const source = this.state.territories[order.sourceTerritoryId];
    const target = this.state.territories[order.targetTerritoryId];
    const sourceTroopsBefore = source.troops;
    const defendingBefore = target.troops;

    source.troops = sourceTroopsBefore - order.troops;
    target.troops = defendingBefore - order.troops;

    if (target.troops <= 0) {
      const excessAttackTroops = order.troops - defendingBefore;
      const remainingAttackTroops = excessAttackTroops > 0 ? excessAttackTroops : MIN_CAPTURE_GARRISON;
      const previousOwner = target.ownerId;
      target.ownerId = attackerTeamId;
      target.troops = remainingAttackTroops;
      appendEvent(
        this.state,
        `${this.state.teams[attackerTeamId].name} captured ${target.name} from ${this.state.teams[previousOwner].name} and established a ${remainingAttackTroops}-troop garrison.`,
      );
      return;
    }

    appendEvent(
      this.state,
      `${this.state.teams[attackerTeamId].name} attacked ${target.name} with ${order.troops}. Defender holds with ${target.troops}.`,
    );
  }
}

export type { QueuedAttack, Territory };
