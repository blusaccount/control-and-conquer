import { AttackOrder, ClientMessage } from "../Core/types.js";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const parseAttackOrder = (payload: unknown): AttackOrder => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_ATTACK_REQUEST.payload must be an object.");
  }

  const attack = payload as Record<string, unknown>;

  if (!isNonEmptyString(attack.sourceTerritoryId)) {
    throw new Error("sourceTerritoryId must be a non-empty string.");
  }

  if (!isNonEmptyString(attack.targetTerritoryId)) {
    throw new Error("targetTerritoryId must be a non-empty string.");
  }

  if (!isPositiveInteger(attack.troops)) {
    throw new Error("troops must be a positive integer.");
  }

  return {
    sourceTerritoryId: attack.sourceTerritoryId,
    targetTerritoryId: attack.targetTerritoryId,
    troops: attack.troops,
  };
};

export const validateCommand = (raw: unknown): ClientMessage => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Message must be a JSON object.");
  }

  const message = raw as Record<string, unknown>;

  if (message.type !== "CLIENT_ATTACK_REQUEST") {
    throw new Error(`Unknown message type: ${String(message.type)}.`);
  }

  return {
    type: "CLIENT_ATTACK_REQUEST",
    payload: parseAttackOrder(message.payload),
  };
};
