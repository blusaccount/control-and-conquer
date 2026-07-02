import { RasterBuildIntent, RasterClientMessage, RasterExpandIntent, RasterExpandMode, RasterNukeIntent } from "../Core/types.js";
import {
  isRasterDifficulty,
  RasterAllyBreakPayload,
  RasterAllyProposePayload,
  RasterAllyRespondPayload,
  RasterJoinPayload,
  RasterSpawnPayload,
} from "../Core/messages.js";
import { isMapChoiceId } from "../Core/mapCatalog.js";
import { isBuildingType } from "../Core/buildings.js";
import { isNukeKind } from "../Core/nukes.js";

/** Validate a diplomacy counterparty id: a positive integer player id. */
const parseTargetId = (payload: unknown, label: string): number => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`${label}.payload must be an object.`);
  }
  const { targetId } = payload as Record<string, unknown>;
  if (typeof targetId !== "number" || !Number.isInteger(targetId) || targetId < 1) {
    throw new Error("targetId must be a positive integer player id.");
  }
  return targetId;
};

const parseAllyPropose = (payload: unknown): RasterAllyProposePayload => ({
  targetId: parseTargetId(payload, "CLIENT_RASTER_ALLY_PROPOSE"),
});

const parseAllyBreak = (payload: unknown): RasterAllyBreakPayload => ({
  targetId: parseTargetId(payload, "CLIENT_RASTER_ALLY_BREAK"),
});

const parseAllyRespond = (payload: unknown): RasterAllyRespondPayload => {
  const targetId = parseTargetId(payload, "CLIENT_RASTER_ALLY_RESPOND");
  const { accept } = payload as Record<string, unknown>;
  if (typeof accept !== "boolean") {
    throw new Error("accept must be a boolean.");
  }
  return { targetId, accept };
};

const isRasterExpandMode = (value: unknown): value is RasterExpandMode =>
  value === "auto" || value === "land" || value === "sea";

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
  if (intent.mode !== undefined && !isRasterExpandMode(intent.mode)) {
    throw new Error('mode must be "auto", "land" or "sea".');
  }
  return {
    targetX: intent.targetX,
    targetY: intent.targetY,
    percent: intent.percent,
    ...(intent.mode !== undefined ? { mode: intent.mode } : {}),
  };
};

const parseRasterBuild = (payload: unknown): RasterBuildIntent => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_BUILD.payload must be an object.");
  }
  const intent = payload as Record<string, unknown>;
  if (typeof intent.targetX !== "number" || !Number.isInteger(intent.targetX) || intent.targetX < 0) {
    throw new Error("targetX must be a non-negative integer.");
  }
  if (typeof intent.targetY !== "number" || !Number.isInteger(intent.targetY) || intent.targetY < 0) {
    throw new Error("targetY must be a non-negative integer.");
  }
  if (!isBuildingType(intent.building)) {
    throw new Error("building must be a known building type.");
  }
  return { targetX: intent.targetX, targetY: intent.targetY, building: intent.building };
};

const parseRasterNuke = (payload: unknown): RasterNukeIntent => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_NUKE.payload must be an object.");
  }
  const intent = payload as Record<string, unknown>;
  if (typeof intent.targetX !== "number" || !Number.isInteger(intent.targetX) || intent.targetX < 0) {
    throw new Error("targetX must be a non-negative integer.");
  }
  if (typeof intent.targetY !== "number" || !Number.isInteger(intent.targetY) || intent.targetY < 0) {
    throw new Error("targetY must be a non-negative integer.");
  }
  if (intent.kind !== undefined && !isNukeKind(intent.kind)) {
    throw new Error("kind must be a known warhead kind.");
  }
  return { targetX: intent.targetX, targetY: intent.targetY, ...(intent.kind !== undefined ? { kind: intent.kind } : {}) };
};

const parseRasterSpawn = (payload: unknown): RasterSpawnPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_SELECT_SPAWN.payload must be an object.");
  }
  const { x, y } = payload as Record<string, unknown>;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) {
    throw new Error("x must be a non-negative integer.");
  }
  if (typeof y !== "number" || !Number.isInteger(y) || y < 0) {
    throw new Error("y must be a non-negative integer.");
  }
  return { x, y };
};

const parseRasterJoin = (payload: unknown): RasterJoinPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_JOIN.payload must be an object.");
  }
  const { mapId, difficulty } = payload as Record<string, unknown>;
  if (mapId !== undefined && !isMapChoiceId(mapId)) {
    throw new Error("mapId must be a known map id.");
  }
  if (difficulty !== undefined && !isRasterDifficulty(difficulty)) {
    throw new Error("difficulty must be a known difficulty id.");
  }
  const out: RasterJoinPayload = {};
  if (mapId !== undefined) out.mapId = mapId;
  if (difficulty !== undefined) out.difficulty = difficulty;
  return out;
};

export const validateCommand = (raw: unknown): RasterClientMessage => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Message must be a JSON object.");
  }

  const message = raw as Record<string, unknown>;

  if (message.type === "CLIENT_RASTER_JOIN") {
    return { type: "CLIENT_RASTER_JOIN", payload: parseRasterJoin(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_EXPAND") {
    return { type: "CLIENT_RASTER_EXPAND", payload: parseRasterExpand(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_BUILD") {
    return { type: "CLIENT_RASTER_BUILD", payload: parseRasterBuild(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_NUKE") {
    return { type: "CLIENT_RASTER_NUKE", payload: parseRasterNuke(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_SELECT_SPAWN") {
    return { type: "CLIENT_RASTER_SELECT_SPAWN", payload: parseRasterSpawn(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_ALLY_PROPOSE") {
    return { type: "CLIENT_RASTER_ALLY_PROPOSE", payload: parseAllyPropose(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_ALLY_RESPOND") {
    return { type: "CLIENT_RASTER_ALLY_RESPOND", payload: parseAllyRespond(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_ALLY_BREAK") {
    return { type: "CLIENT_RASTER_ALLY_BREAK", payload: parseAllyBreak(message.payload) };
  }
  throw new Error(`Unknown message type: ${String(message.type)}.`);
};
