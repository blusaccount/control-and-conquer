import { AttackOrder, ClientMessage, RasterClientMessage, RasterExpandIntent } from "../Core/types.js";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

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
    sourceTerritoryId: asTrimmedString(attack.sourceTerritoryId),
    targetTerritoryId: asTrimmedString(attack.targetTerritoryId),
    troops: attack.troops,
  };
};

const parseRasterExpand = (payload: unknown): RasterExpandIntent => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_EXPAND.payload must be an object.");
  }
  const intent = payload as Record<string, unknown>;
  if (typeof intent.targetX !== "number" || !Number.isInteger(intent.targetX) || intent.targetX < 0) {
    throw new Error("targetX must be a non-negative integer.");
  }
  if (typeof intent.targetY !== "number" || !Number.isInteger(intent.targetY) || intent.targetY < 0) {
    throw new Error("targetY must be a non-negative integer.");
  }
  if (typeof intent.percent !== "number" || !Number.isInteger(intent.percent) || intent.percent < 1 || intent.percent > 100) {
    throw new Error("percent must be an integer 1..100.");
  }
  return { targetX: intent.targetX, targetY: intent.targetY, percent: intent.percent };
};

export const validateCommand = (raw: unknown): ClientMessage | RasterClientMessage => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Message must be a JSON object.");
  }

  const message = raw as Record<string, unknown>;

  if (message.type === "CLIENT_ATTACK_REQUEST") {
    return { type: "CLIENT_ATTACK_REQUEST", payload: parseAttackOrder(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_EXPAND") {
    return { type: "CLIENT_RASTER_EXPAND", payload: parseRasterExpand(message.payload) };
  }
  throw new Error(`Unknown message type: ${String(message.type)}.`);
};
