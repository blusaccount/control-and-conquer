import { RasterClientMessage, RasterExpandIntent } from "../Core/types.js";

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

export const validateCommand = (raw: unknown): RasterClientMessage => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Message must be a JSON object.");
  }

  const message = raw as Record<string, unknown>;

  if (message.type === "CLIENT_RASTER_EXPAND") {
    return { type: "CLIENT_RASTER_EXPAND", payload: parseRasterExpand(message.payload) };
  }
  throw new Error(`Unknown message type: ${String(message.type)}.`);
};
