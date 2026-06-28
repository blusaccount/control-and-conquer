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

/**
 * Authored, data-driven description of a single territory. This is the raw
 * input format (e.g. from a JSON map file) before centers are computed and the
 * map is validated into runtime `Territory` objects by the map loader.
 */
export interface MapTerritoryDefinition {
  id: string;
  name: string;
  ownerId: TeamId;
  troops: number;
  neighbors: string[];
  polygon: Point[];
}

/** A complete, authored map: a name plus its territory definitions. */
export interface MapDefinition {
  name: string;
  territories: MapTerritoryDefinition[];
}

export interface GameStateSnapshot {
  tick: number;
  mapName: string;
  teams: Record<TeamId, TeamState>;
  territories: Record<string, Territory>;
  territoryOrder: string[];
  recentEvents: string[];
  activeConflicts: ActiveConflict[];
  /** Set once a single team owns every territory. `null` while the match is live. */
  winnerTeamId: TeamId | null;
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
  | "TERRITORY_CONTESTED"
  | "MATCH_ENDED";

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
    }
  | {
      type: "SERVER_MATCH_ENDED";
      payload: { winnerTeamId: TeamId };
    };
