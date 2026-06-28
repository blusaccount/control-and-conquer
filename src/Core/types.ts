export type TeamId = "blue" | "red";

export interface Point {
  x: number;
  y: number;
}

export interface Territory {
  id: string;
  name: string;
  ownerId: TeamId;
  troops: number;
  neighbors: string[];
  polygon: Point[];
  center: Point;
}

export interface TeamState {
  id: TeamId;
  name: string;
  color: string;
}

export interface GameStateSnapshot {
  tick: number;
  mapName: string;
  teams: Record<TeamId, TeamState>;
  territories: Record<string, Territory>;
  territoryOrder: string[];
  recentEvents: string[];
  activeConflicts: ActiveConflict[];
}

export interface AttackOrder {
  sourceTerritoryId: string;
  targetTerritoryId: string;
  troops: number;
}

export interface ActiveConflict {
  id: string;
  attackerTeamId: TeamId;
  defenderTeamId: TeamId;
  sourceTerritoryId: string;
  targetTerritoryId: string;
  /** Remaining attacker troops engaged in the fight. */
  attackingTroops: number;
  /** Remaining defender troops in the contested territory. */
  defendingTroops: number;
  /** 0.0 = front at the border, 1.0 = territory fully overrun. */
  progress: number;
}

export type ActionRejectedReason =
  | "INVALID_MESSAGE_FORMAT"
  | "INVALID_TERRITORY"
  | "NOT_OWNER"
  | "NOT_ADJACENT"
  | "INSUFFICIENT_TROOPS"
  | "SAME_OWNER"
  | "INVALID_TROOP_COUNT"
  | "TERRITORY_CONTESTED";

export interface ActionRejectedEvent {
  reason: ActionRejectedReason;
  message: string;
  order: AttackOrder;
}

export type ClientMessage = {
  type: "CLIENT_ATTACK_REQUEST";
  payload: AttackOrder;
};

export type ServerMessage =
  | {
      type: "SERVER_LOBBY_WAITING";
    }
  | {
      type: "SERVER_PLAYER_ASSIGNED";
      payload: { teamId: TeamId };
    }
  | {
      type: "SERVER_STATE_SNAPSHOT";
      payload: GameStateSnapshot;
    }
  | {
      type: "SERVER_ACTION_REJECTED";
      payload: ActionRejectedEvent;
    };

// Legacy enums kept for existing non-MVP modules.
export enum Faction {
  USA = "usa",
  China = "china",
  GLA = "gla",
}

export enum UnitType {
  Infantry = "infantry",
  Tank = "tank",
}

// Legacy battle model kept to avoid breaking existing modules not used by MVP.
export type UnitRoster = Record<UnitType, number>;

export interface BattleFrameUnit {
  side: "attacker" | "defender";
  unitType: UnitType;
  x: number;
  hp: number;
  maxHp: number;
}

export interface BattleFrame {
  time: number;
  units: BattleFrameUnit[];
}

export interface BattleSummary {
  id: string;
  attackerId: string;
  defenderId: string;
  attackerProvinceId: string;
  defenderProvinceId: string;
  winnerId: string | null;
  winnerFaction: Faction | null;
  attackerRemaining: UnitRoster;
  defenderRemaining: UnitRoster;
  provinceCaptured: boolean;
  timeline: BattleFrame[];
  log: string[];
}

export const createEmptyRoster = (): UnitRoster => ({
  [UnitType.Infantry]: 0,
  [UnitType.Tank]: 0,
});

export const cloneRoster = (roster: UnitRoster): UnitRoster => ({
  [UnitType.Infantry]: roster[UnitType.Infantry],
  [UnitType.Tank]: roster[UnitType.Tank],
});

export const rosterTotal = (roster: UnitRoster): number => roster[UnitType.Infantry] + roster[UnitType.Tank];
