import { ClientCommand, UnitType } from "../Core/types.js";

const validUnitTypes = new Set<string>(Object.values(UnitType));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Validates the shape of a raw parsed JSON value and narrows it to
 * ClientCommand.  Throws an Error with a descriptive message on any
 * structural violation so the server can return a meaningful error to the
 * client without ever touching MapState.
 */
export const validateCommand = (raw: unknown): ClientCommand => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Command must be a JSON object.");
  }

  const cmd = raw as Record<string, unknown>;

  if (cmd.type === "purchase") {
    if (!isNonEmptyString(cmd.playerId)) {
      throw new Error("purchase: playerId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.provinceId)) {
      throw new Error("purchase: provinceId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.unitType) || !validUnitTypes.has(cmd.unitType)) {
      throw new Error("purchase: unitType must be 'infantry' or 'tank'.");
    }
    if (!isPositiveInteger(cmd.count)) {
      throw new Error("purchase: count must be a positive integer.");
    }
    return cmd as unknown as ClientCommand;
  }

  if (cmd.type === "move") {
    if (!isNonEmptyString(cmd.playerId)) {
      throw new Error("move: playerId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.fromProvinceId)) {
      throw new Error("move: fromProvinceId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.toProvinceId)) {
      throw new Error("move: toProvinceId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.unitType) || !validUnitTypes.has(cmd.unitType)) {
      throw new Error("move: unitType must be 'infantry' or 'tank'.");
    }
    if (!isPositiveInteger(cmd.count)) {
      throw new Error("move: count must be a positive integer.");
    }
    return cmd as unknown as ClientCommand;
  }

  if (cmd.type === "placeMine") {
    if (!isNonEmptyString(cmd.playerId)) {
      throw new Error("placeMine: playerId must be a non-empty string.");
    }
    if (!isNonEmptyString(cmd.provinceId)) {
      throw new Error("placeMine: provinceId must be a non-empty string.");
    }
    return cmd as unknown as ClientCommand;
  }

  throw new Error(`Unknown command type: ${String(cmd.type)}.`);
};
