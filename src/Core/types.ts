export enum Faction {
  USA = "usa",
  China = "china",
  GLA = "gla",
}

export enum UnitType {
  Infantry = "infantry",
  Tank = "tank",
}

export type UnitRoster = Record<UnitType, number>;

export interface Province {
  id: string;
  name: string;
  ownerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  neighbors: string[];
  units: UnitRoster;
  hasMine: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  faction: Faction;
  credits: number;
  generalLevel: number;
  mineCharges: number;
  wins: number;
}

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

export interface GameState {
  tick: number;
  mapName: string;
  players: Record<string, PlayerState>;
  provinces: Record<string, Province>;
  provinceOrder: string[];
  lastBattle: BattleSummary | null;
  recentEvents: string[];
}

export type ClientCommand =
  | {
      type: "purchase";
      playerId: string;
      provinceId: string;
      unitType: UnitType;
      count: number;
    }
  | {
      type: "move";
      playerId: string;
      fromProvinceId: string;
      toProvinceId: string;
      unitType: UnitType;
      count: number;
    }
  | {
      type: "placeMine";
      playerId: string;
      provinceId: string;
    };

export const createEmptyRoster = (): UnitRoster => ({
  [UnitType.Infantry]: 0,
  [UnitType.Tank]: 0,
});

export const cloneRoster = (roster: UnitRoster): UnitRoster => ({
  [UnitType.Infantry]: roster[UnitType.Infantry],
  [UnitType.Tank]: roster[UnitType.Tank],
});

export const rosterTotal = (roster: UnitRoster): number =>
  roster[UnitType.Infantry] + roster[UnitType.Tank];
