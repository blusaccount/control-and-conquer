import { RasterClientMessage, RasterExpandIntent } from "../Core/types.js";
import { RasterJoinPayload } from "../Core/messages.js";
import { isMapChoiceId } from "../Core/mapCatalog.js";

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

const parseRasterJoin = (payload: unknown): RasterJoinPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("CLIENT_RASTER_JOIN.payload must be an object.");
  }
  const { mapId } = payload as Record<string, unknown>;
  if (mapId !== undefined && !isMapChoiceId(mapId)) {
    throw new Error("mapId must be a known map id.");
  }
  return mapId === undefined ? {} : { mapId };
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
  throw new Error(`Unknown message type: ${String(message.type)}.`);
};
