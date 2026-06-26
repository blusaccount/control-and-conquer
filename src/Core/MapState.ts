import { resolveBattle } from "./BattleEngine.js";
import {
  BattleSummary,
  ClientCommand,
  Faction,
  GameState,
  PlayerState,
  Province,
  UnitRoster,
  UnitType,
  cloneRoster,
  createEmptyRoster,
  rosterTotal,
} from "./types.js";
import { canUseTunnel, getUnitCost } from "../FactionData/factions.js";

const provinceIncome = 10;

const initialPlayers = (): Record<string, PlayerState> => ({
  usa: {
    id: "usa",
    name: "USA Vanguard",
    color: "#4da3ff",
    faction: Faction.USA,
    credits: 220,
    generalLevel: 0,
    mineCharges: 0,
    wins: 0,
  },
  china: {
    id: "china",
    name: "China Legion",
    color: "#f87171",
    faction: Faction.China,
    credits: 220,
    generalLevel: 0,
    mineCharges: 0,
    wins: 0,
  },
  gla: {
    id: "gla",
    name: "GLA Cell",
    color: "#34d399",
    faction: Faction.GLA,
    credits: 220,
    generalLevel: 0,
    mineCharges: 0,
    wins: 0,
  },
});

const makeProvince = (
  id: string,
  name: string,
  ownerId: string,
  x: number,
  y: number,
  neighbors: string[],
  units: UnitRoster,
): Province => ({
  id,
  name,
  ownerId,
  x,
  y,
  width: 150,
  height: 92,
  neighbors,
  units,
  hasMine: false,
});

export const createInitialState = (): GameState => ({
  tick: 0,
  mapName: "Trusted Front",
  players: initialPlayers(),
  provinces: {
    alpha: makeProvince("alpha", "Alpha Ridge", "usa", 40, 40, ["bravo", "charlie"], {
      [UnitType.Infantry]: 3,
      [UnitType.Tank]: 1,
    }),
    bravo: makeProvince("bravo", "Bravo Hub", "usa", 240, 40, ["alpha", "charlie", "delta"], {
      [UnitType.Infantry]: 2,
      [UnitType.Tank]: 0,
    }),
    charlie: makeProvince("charlie", "Charlie Pass", "china", 140, 180, ["alpha", "bravo", "delta", "echo"], {
      [UnitType.Infantry]: 3,
      [UnitType.Tank]: 1,
    }),
    delta: makeProvince("delta", "Delta Gate", "china", 340, 180, ["bravo", "charlie", "echo"], {
      [UnitType.Infantry]: 2,
      [UnitType.Tank]: 1,
    }),
    echo: makeProvince("echo", "Echo Tunnels", "gla", 240, 320, ["charlie", "delta"], {
      [UnitType.Infantry]: 4,
      [UnitType.Tank]: 0,
    }),
  },
  provinceOrder: ["alpha", "bravo", "charlie", "delta", "echo"],
  lastBattle: null,
  recentEvents: ["Simulation initialized."],
});

const assertWholeNumber = (value: number): boolean => Number.isInteger(value) && value > 0;

const appendEvent = (state: GameState, message: string): void => {
  state.recentEvents = [message, ...state.recentEvents].slice(0, 8);
};

const awardWin = (player: PlayerState): void => {
  player.wins += 1;
  player.generalLevel += 1;
  player.mineCharges += 1;
};

const takeUnits = (roster: UnitRoster, unitType: UnitType, count: number): UnitRoster => {
  const taken = createEmptyRoster();
  taken[unitType] = count;
  roster[unitType] -= count;
  return taken;
};

export class MapState {
  private state: GameState;

  public constructor(initialState: GameState = createInitialState()) {
    this.state = structuredClone(initialState);
  }

  public getSnapshot(): GameState {
    return structuredClone(this.state);
  }

  public tick(): GameState {
    this.state.tick += 1;

    for (const provinceId of this.state.provinceOrder) {
      const province = this.state.provinces[provinceId];
      this.state.players[province.ownerId].credits += provinceIncome;
    }

    appendEvent(this.state, `Tick ${this.state.tick}: province income distributed.`);
    return this.getSnapshot();
  }

  public applyCommand(command: ClientCommand): GameState {
    if (command.type === "purchase") {
      return this.purchase(command.playerId, command.provinceId, command.unitType, command.count);
    }

    if (command.type === "move") {
      return this.move(command.playerId, command.fromProvinceId, command.toProvinceId, command.unitType, command.count);
    }

    return this.placeMine(command.playerId, command.provinceId);
  }

  public purchase(playerId: string, provinceId: string, unitType: UnitType, count: number): GameState {
    if (!assertWholeNumber(count)) {
      throw new Error("Purchase count must be a positive integer.");
    }

    const player = this.state.players[playerId];
    const province = this.state.provinces[provinceId];

    if (!player || !province) {
      throw new Error("Invalid player or province.");
    }

    if (province.ownerId !== playerId) {
      throw new Error("You can only deploy in your own province.");
    }

    const totalCost = getUnitCost(unitType) * count;
    if (player.credits < totalCost) {
      throw new Error("Not enough credits.");
    }

    player.credits -= totalCost;
    province.units[unitType] += count;
    appendEvent(this.state, `${player.name} deployed ${count} ${unitType} to ${province.name}.`);
    return this.getSnapshot();
  }

  public placeMine(playerId: string, provinceId: string): GameState {
    const player = this.state.players[playerId];
    const province = this.state.provinces[provinceId];

    if (!player || !province) {
      throw new Error("Invalid player or province.");
    }

    if (province.ownerId !== playerId) {
      throw new Error("Mines can only be placed in your own province.");
    }

    if (player.generalLevel < 1 || player.mineCharges < 1) {
      throw new Error("You need a general level and an unused mine charge.");
    }

    if (province.hasMine) {
      throw new Error("This province already has a mine.");
    }

    province.hasMine = true;
    player.mineCharges -= 1;
    appendEvent(this.state, `${player.name} armed a mine in ${province.name}.`);
    return this.getSnapshot();
  }

  public move(
    playerId: string,
    fromProvinceId: string,
    toProvinceId: string,
    unitType: UnitType,
    count: number,
  ): GameState {
    if (!assertWholeNumber(count)) {
      throw new Error("Move count must be a positive integer.");
    }

    const player = this.state.players[playerId];
    const fromProvince = this.state.provinces[fromProvinceId];
    const toProvince = this.state.provinces[toProvinceId];

    if (!player || !fromProvince || !toProvince) {
      throw new Error("Invalid player or province.");
    }

    if (fromProvince.ownerId !== playerId) {
      throw new Error("You can only move units from your own province.");
    }

    if (fromProvince.units[unitType] < count) {
      throw new Error("Not enough units in the source province.");
    }

    const isNeighbor = fromProvince.neighbors.includes(toProvinceId);
    const sameOwner = toProvince.ownerId === playerId;
    const isTunnel = sameOwner && canUseTunnel(player.faction);

    if (!isNeighbor && !isTunnel) {
      throw new Error("Provinces are not connected for this move.");
    }

    const movingUnits = takeUnits(fromProvince.units, unitType, count);

    if (sameOwner) {
      toProvince.units[unitType] += count;
      appendEvent(this.state, `${player.name} repositioned ${count} ${unitType} to ${toProvince.name}.`);
      return this.getSnapshot();
    }

    const defender = this.state.players[toProvince.ownerId];
    const battle = resolveBattle({
      battleId: `battle-${this.state.tick}-${fromProvinceId}-${toProvinceId}`,
      attackerId: playerId,
      defenderId: defender.id,
      attackerFaction: player.faction,
      defenderFaction: defender.faction,
      attackerProvinceId: fromProvinceId,
      defenderProvinceId: toProvinceId,
      attackerUnits: movingUnits,
      defenderUnits: cloneRoster(toProvince.units),
      defenderHasMine: toProvince.hasMine,
    });

    this.finishBattle(battle, toProvinceId);
    appendEvent(
      this.state,
      `${player.name} attacked ${toProvince.name}. ${battle.log[battle.log.length - 1]}`,
    );
    return this.getSnapshot();
  }

  private finishBattle(battle: BattleSummary, targetProvinceId: string): void {
    const province = this.state.provinces[targetProvinceId];
    const attacker = this.state.players[battle.attackerId];
    const defender = this.state.players[battle.defenderId];

    province.hasMine = false;
    this.state.lastBattle = battle;

    if (battle.winnerId === battle.attackerId) {
      province.ownerId = battle.attackerId;
      province.units = cloneRoster(battle.attackerRemaining);
      awardWin(attacker);
      if (rosterTotal(province.units) === 0) {
        province.units[UnitType.Infantry] = 1;
      }
      return;
    }

    if (battle.winnerId === battle.defenderId) {
      province.units = cloneRoster(battle.defenderRemaining);
      awardWin(defender);
      if (rosterTotal(province.units) === 0) {
        province.units[UnitType.Infantry] = 1;
      }
      return;
    }

    province.units = createEmptyRoster();
  }
}
