import { RasterBuildIntent, RasterClientMessage, RasterExpandIntent, RasterExpandMode, RasterNukeIntent } from "../Core/types.js";
import {
  isRasterDifficulty,
  LOBBY_CODE_PATTERN,
  PLAYER_NAME_PATTERN,
  RASTER_EMOJIS,
  RasterAllyBreakPayload,
  RasterAllyRenewPayload,
  RasterAllyProposePayload,
  RasterAllyRespondPayload,
  RasterDonatePayload,
  RasterEmbargoPayload,
  RasterEmojiPayload,
  RasterJoinPayload,
  RasterLobbyCreatePayload,
  RasterLobbyJoinPayload,
  RasterResumePayload,
  RasterRetreatPayload,
  RasterSpawnPayload,
  RasterTargetRequestPayload,
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

const parseAllyRenew = (payload: unknown): RasterAllyRenewPayload => ({
  targetId: parseTargetId(payload, "CLIENT_RASTER_ALLY_RENEW"),
});

const parseRetreat = (payload: unknown): RasterRetreatPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_RETREAT.payload must be an object.");
  }
  const { targetId } = payload as Record<string, unknown>;
  // Unlike the diplomacy commands, 0 (neutral land) is a legal retreat target —
  // pulling a land-grab back is exactly the free-retreat case.
  if (typeof targetId !== "number" || !Number.isInteger(targetId) || targetId < 0) {
    throw new Error("targetId must be a non-negative integer player id (0 = neutral).");
  }
  return { targetId };
};

const parseDonate = (payload: unknown): RasterDonatePayload => {
  const targetId = parseTargetId(payload, "CLIENT_RASTER_DONATE");
  const { resource, percent } = payload as Record<string, unknown>;
  if (resource !== "troops" && resource !== "gold") {
    throw new Error("resource must be 'troops' or 'gold'.");
  }
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error("percent must be an integer 1..100.");
  }
  return { targetId, resource, percent };
};

const parseEmbargo = (payload: unknown): RasterEmbargoPayload => {
  const targetId = parseTargetId(payload, "CLIENT_RASTER_EMBARGO");
  const { on } = payload as Record<string, unknown>;
  if (typeof on !== "boolean") throw new Error("on must be a boolean.");
  return { targetId, on };
};

const parseTargetRequest = (payload: unknown): RasterTargetRequestPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_TARGET_REQUEST.payload must be an object.");
  }
  const { allyId, targetId } = payload as Record<string, unknown>;
  for (const [name, id] of [["allyId", allyId], ["targetId", targetId]] as const) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new Error(`${name} must be a positive integer player id.`);
    }
  }
  return { allyId: allyId as number, targetId: targetId as number };
};

const parseEmoji = (payload: unknown): RasterEmojiPayload => {
  const targetId = parseTargetId(payload, "CLIENT_RASTER_EMOJI");
  const { emoji } = payload as Record<string, unknown>;
  if (typeof emoji !== "number" || !Number.isInteger(emoji) || emoji < 0 || emoji >= RASTER_EMOJIS.length) {
    throw new Error(`emoji must be an integer index 0..${RASTER_EMOJIS.length - 1}.`);
  }
  return { targetId, emoji };
};

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
  const { mapId, difficulty, fieldSize, lockstep } = payload as Record<string, unknown>;
  if (mapId !== undefined && !isMapChoiceId(mapId)) {
    throw new Error("mapId must be a known map id.");
  }
  if (difficulty !== undefined && !isRasterDifficulty(difficulty)) {
    throw new Error("difficulty must be a known difficulty id.");
  }
  if (fieldSize !== undefined && (typeof fieldSize !== "number" || !Number.isInteger(fieldSize) || fieldSize < 0)) {
    throw new Error("fieldSize must be a non-negative integer.");
  }
  if (lockstep !== undefined && typeof lockstep !== "boolean") {
    throw new Error("lockstep must be a boolean.");
  }
  const out: RasterJoinPayload = {};
  if (mapId !== undefined) out.mapId = mapId;
  if (difficulty !== undefined) out.difficulty = difficulty;
  if (fieldSize !== undefined) out.fieldSize = fieldSize as number;
  if (lockstep !== undefined) out.lockstep = lockstep;
  return out;
};

/** Validate an optional display name: trimmed, printable, ≤24 chars. */
const parseName = (name: unknown): string | undefined => {
  if (name === undefined) return undefined;
  if (typeof name !== "string") throw new Error("name must be a string.");
  const trimmed = name.trim();
  if (!PLAYER_NAME_PATTERN.test(trimmed)) {
    throw new Error("name must be 1–24 letters, digits, spaces or _.'-");
  }
  return trimmed;
};

const parseLobbyCreate = (payload: unknown): RasterLobbyCreatePayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_LOBBY_CREATE.payload must be an object.");
  }
  const { mapId, difficulty, fieldSize, name } = payload as Record<string, unknown>;
  if (mapId !== undefined && !isMapChoiceId(mapId)) {
    throw new Error("mapId must be a known map id.");
  }
  if (difficulty !== undefined && !isRasterDifficulty(difficulty)) {
    throw new Error("difficulty must be a known difficulty id.");
  }
  if (fieldSize !== undefined && (typeof fieldSize !== "number" || !Number.isInteger(fieldSize) || fieldSize < 0)) {
    throw new Error("fieldSize must be a non-negative integer.");
  }
  const out: RasterLobbyCreatePayload = {};
  if (mapId !== undefined) out.mapId = mapId;
  if (difficulty !== undefined) out.difficulty = difficulty;
  if (fieldSize !== undefined) out.fieldSize = fieldSize as number;
  const parsedName = parseName(name);
  if (parsedName !== undefined) out.name = parsedName;
  return out;
};

const parseLobbyJoin = (payload: unknown): RasterLobbyJoinPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_LOBBY_JOIN.payload must be an object.");
  }
  const { code, name } = payload as Record<string, unknown>;
  if (typeof code !== "string" || !LOBBY_CODE_PATTERN.test(code.toUpperCase())) {
    throw new Error("code must be a 4–8 character lobby code.");
  }
  const out: RasterLobbyJoinPayload = { code: code.toUpperCase() };
  const parsedName = parseName(name);
  if (parsedName !== undefined) out.name = parsedName;
  return out;
};

const parseResume = (payload: unknown): RasterResumePayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_RESUME.payload must be an object.");
  }
  const { token } = payload as Record<string, unknown>;
  if (typeof token !== "string" || token.length < 8 || token.length > 128) {
    throw new Error("token must be a resume token string.");
  }
  return { token };
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
  if (message.type === "CLIENT_RASTER_ALLY_RENEW") {
    return { type: "CLIENT_RASTER_ALLY_RENEW", payload: parseAllyRenew(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_RETREAT") {
    return { type: "CLIENT_RASTER_RETREAT", payload: parseRetreat(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_DONATE") {
    return { type: "CLIENT_RASTER_DONATE", payload: parseDonate(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_EMBARGO") {
    return { type: "CLIENT_RASTER_EMBARGO", payload: parseEmbargo(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_TARGET_REQUEST") {
    return { type: "CLIENT_RASTER_TARGET_REQUEST", payload: parseTargetRequest(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_EMOJI") {
    return { type: "CLIENT_RASTER_EMOJI", payload: parseEmoji(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_LOBBY_CREATE") {
    return { type: "CLIENT_RASTER_LOBBY_CREATE", payload: parseLobbyCreate(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_LOBBY_JOIN") {
    return { type: "CLIENT_RASTER_LOBBY_JOIN", payload: parseLobbyJoin(message.payload) };
  }
  if (message.type === "CLIENT_RASTER_LOBBY_START") {
    return { type: "CLIENT_RASTER_LOBBY_START" };
  }
  if (message.type === "CLIENT_RASTER_LOBBY_LEAVE") {
    return { type: "CLIENT_RASTER_LOBBY_LEAVE" };
  }
  if (message.type === "CLIENT_RASTER_RESUME") {
    return { type: "CLIENT_RASTER_RESUME", payload: parseResume(message.payload) };
  }
  throw new Error(`Unknown message type: ${String(message.type)}.`);
};
