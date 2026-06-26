import { Faction, UnitType } from "../Core/types.js";

export interface UnitStats {
  cost: number;
  maxHp: number;
  damage: number;
  range: number;
  speed: number;
  cooldown: number;
  splashDamage: number;
  splashRange: number;
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  [UnitType.Infantry]: {
    cost: 50,
    maxHp: 40,
    damage: 8,
    range: 36,
    speed: 18,
    cooldown: 0.8,
    splashDamage: 0,
    splashRange: 0,
  },
  [UnitType.Tank]: {
    cost: 140,
    maxHp: 120,
    damage: 24,
    range: 58,
    speed: 12,
    cooldown: 1.2,
    splashDamage: 10,
    splashRange: 24,
  },
};

export const getUnitCost = (unitType: UnitType): number => UNIT_STATS[unitType].cost;

export const getDamageMultiplier = (faction: Faction, totalUnits: number): number => {
  if (faction === Faction.China) {
    return 1 + Math.min(0.5, Math.max(0, totalUnits - 1) * 0.05);
  }

  return 1;
};

export const getDamageReduction = (faction: Faction): number => {
  if (faction === Faction.USA) {
    return 0.15;
  }

  return 0;
};

export const getSpeedMultiplier = (faction: Faction): number => {
  if (faction === Faction.GLA) {
    return 1.2;
  }

  return 1;
};

export const canUseTunnel = (faction: Faction): boolean => faction === Faction.GLA;

export const MINE_DAMAGE = 65;
