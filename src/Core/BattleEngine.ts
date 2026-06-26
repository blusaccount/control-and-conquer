import {
  BattleFrame,
  BattleSummary,
  Faction,
  UnitRoster,
  UnitType,
  createEmptyRoster,
  rosterTotal,
} from "./types.js";
import {
  MINE_DAMAGE,
  UNIT_STATS,
  getDamageMultiplier,
  getDamageReduction,
  getSpeedMultiplier,
} from "../FactionData/factions.js";

interface BattleInput {
  battleId: string;
  attackerId: string;
  defenderId: string;
  attackerFaction: Faction;
  defenderFaction: Faction;
  attackerProvinceId: string;
  defenderProvinceId: string;
  attackerUnits: UnitRoster;
  defenderUnits: UnitRoster;
  defenderHasMine: boolean;
}

interface Combatant {
  id: string;
  side: "attacker" | "defender";
  unitType: UnitType;
  hp: number;
  maxHp: number;
  x: number;
  cooldown: number;
}

const battleWidth = 620;
const attackerStart = 90;
const defenderStart = battleWidth - 90;

const spawnUnits = (
  roster: UnitRoster,
  side: "attacker" | "defender",
): Combatant[] => {
  const combatants: Combatant[] = [];
  let index = 0;

  for (const unitType of [UnitType.Infantry, UnitType.Tank]) {
    for (let count = 0; count < roster[unitType]; count += 1) {
      const stats = UNIT_STATS[unitType];
      const directionOffset = index * 16;
      combatants.push({
        id: `${side}-${unitType}-${count}`,
        side,
        unitType,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        x: side === "attacker" ? attackerStart + directionOffset : defenderStart - directionOffset,
        cooldown: 0,
      });
      index += 1;
    }
  }

  return combatants;
};

const snapshotFrame = (time: number, units: Combatant[]): BattleFrame => ({
  time,
  units: units
    .filter((unit) => unit.hp > 0)
    .map((unit) => ({
      side: unit.side,
      unitType: unit.unitType,
      x: unit.x,
      hp: unit.hp,
      maxHp: unit.maxHp,
    })),
});

const nearestEnemy = (unit: Combatant, enemies: Combatant[]): Combatant | undefined =>
  enemies
    .filter((enemy) => enemy.hp > 0)
    .sort((left, right) => Math.abs(left.x - unit.x) - Math.abs(right.x - unit.x))[0];

const applyDamage = (target: Combatant, damage: number): void => {
  target.hp = Math.max(0, target.hp - damage);
};

const countRemaining = (units: Combatant[]): UnitRoster => {
  const roster = createEmptyRoster();

  for (const unit of units) {
    if (unit.hp > 0) {
      roster[unit.unitType] += 1;
    }
  }

  return roster;
};

const removeMineVictims = (attackers: Combatant[], log: string[]): void => {
  let remainingMineDamage = MINE_DAMAGE;

  for (const unit of attackers) {
    if (remainingMineDamage <= 0) {
      break;
    }

    const before = unit.hp;
    applyDamage(unit, remainingMineDamage);
    remainingMineDamage -= before;
  }

  log.push("A defending mine detonated before the clash.");
};

export const resolveBattle = (input: BattleInput): BattleSummary => {
  const log: string[] = [];
  const attackers = spawnUnits(input.attackerUnits, "attacker");
  const defenders = spawnUnits(input.defenderUnits, "defender");

  if (input.defenderHasMine && attackers.length > 0) {
    removeMineVictims(attackers, log);
  }

  const timeline: BattleFrame[] = [snapshotFrame(0, [...attackers, ...defenders])];
  const dt = 0.25;
  const maxTicks = 200;
  const attackerDamageMultiplier = getDamageMultiplier(
    input.attackerFaction,
    rosterTotal(input.attackerUnits),
  );
  const defenderDamageMultiplier = getDamageMultiplier(
    input.defenderFaction,
    rosterTotal(input.defenderUnits),
  );
  const attackerSpeedMultiplier = getSpeedMultiplier(input.attackerFaction);
  const defenderSpeedMultiplier = getSpeedMultiplier(input.defenderFaction);
  const attackerReduction = getDamageReduction(input.attackerFaction);
  const defenderReduction = getDamageReduction(input.defenderFaction);

  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const allUnits = [...attackers, ...defenders].filter((unit) => unit.hp > 0);
    const livingAttackers = attackers.filter((unit) => unit.hp > 0);
    const livingDefenders = defenders.filter((unit) => unit.hp > 0);

    if (livingAttackers.length === 0 || livingDefenders.length === 0) {
      timeline.push(snapshotFrame(tick * dt, allUnits));
      break;
    }

    for (const unit of allUnits.sort((left, right) => left.x - right.x)) {
      if (unit.hp <= 0) {
        continue;
      }

      unit.cooldown = Math.max(0, unit.cooldown - dt);

      const enemies = unit.side === "attacker" ? livingDefenders : livingAttackers;
      const target = nearestEnemy(unit, enemies);

      if (!target) {
        continue;
      }

      const distance = Math.abs(target.x - unit.x);
      const stats = UNIT_STATS[unit.unitType];
      const speedMultiplier = unit.side === "attacker" ? attackerSpeedMultiplier : defenderSpeedMultiplier;

      if (distance <= stats.range && unit.cooldown <= 0) {
        const reduction = target.side === "attacker" ? attackerReduction : defenderReduction;
        const multiplier = unit.side === "attacker" ? attackerDamageMultiplier : defenderDamageMultiplier;
        applyDamage(target, stats.damage * multiplier * (1 - reduction));

        if (stats.splashDamage > 0) {
          const splashTarget = enemies
            .filter((enemy) => enemy.hp > 0 && enemy.id !== target.id)
            .sort((left, right) => Math.abs(left.x - unit.x) - Math.abs(right.x - unit.x))[0];

          if (splashTarget && Math.abs(splashTarget.x - target.x) <= stats.splashRange) {
            applyDamage(splashTarget, stats.splashDamage * multiplier * (1 - reduction));
          }
        }

        unit.cooldown = stats.cooldown;
      } else if (unit.side === "attacker") {
        unit.x = Math.min(defenderStart, unit.x + stats.speed * speedMultiplier * dt);
      } else {
        unit.x = Math.max(attackerStart, unit.x - stats.speed * speedMultiplier * dt);
      }
    }

    if (tick % 2 === 0) {
      timeline.push(snapshotFrame(tick * dt, [...attackers, ...defenders]));
    }
  }

  const attackerRemaining = countRemaining(attackers);
  const defenderRemaining = countRemaining(defenders);
  const attackerAlive = rosterTotal(attackerRemaining);
  const defenderAlive = rosterTotal(defenderRemaining);
  let winnerId: string | null = null;
  let winnerFaction: Faction | null = null;
  let provinceCaptured = false;

  if (attackerAlive > 0 && defenderAlive === 0) {
    winnerId = input.attackerId;
    winnerFaction = input.attackerFaction;
    provinceCaptured = true;
    log.push("Attacker captured the province.");
  } else if (defenderAlive > 0 && attackerAlive === 0) {
    winnerId = input.defenderId;
    winnerFaction = input.defenderFaction;
    log.push("Defender held the province.");
  } else {
    const attackerHealth = attackers.reduce((sum, unit) => sum + Math.max(0, unit.hp), 0);
    const defenderHealth = defenders.reduce((sum, unit) => sum + Math.max(0, unit.hp), 0);

    if (attackerHealth > defenderHealth) {
      winnerId = input.attackerId;
      winnerFaction = input.attackerFaction;
      provinceCaptured = true;
      log.push("Attacker won the extended skirmish.");
    } else if (defenderHealth > attackerHealth) {
      winnerId = input.defenderId;
      winnerFaction = input.defenderFaction;
      log.push("Defender won the extended skirmish.");
    } else {
      log.push("Both sides were shattered in a draw.");
    }
  }

  return {
    id: input.battleId,
    attackerId: input.attackerId,
    defenderId: input.defenderId,
    attackerProvinceId: input.attackerProvinceId,
    defenderProvinceId: input.defenderProvinceId,
    winnerId,
    winnerFaction,
    attackerRemaining,
    defenderRemaining,
    provinceCaptured,
    timeline,
    log,
  };
};
