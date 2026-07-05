import type { RasterGameSession } from "../Server/RasterGameSession.js";
import type { RasterClientMessage } from "./types.js";

/**
 * The single command dispatcher: routes one wire command to the session entry
 * point that applies it. Used by the solo worker (offline matches), the
 * lockstep replica (relayed turns) and any future headless driver, so the
 * mapping from message type to session method exists exactly once — a new
 * command type added here reaches every sim host, instead of desyncing the
 * one whose hand-copied switch was forgotten.
 *
 * JOIN is connection-level and never reaches a live session's command stream;
 * unknown/irrelevant types are ignored, matching the session's own tolerance.
 *
 * Node-free (type-only imports), so it loads in browser Web Workers.
 */
export const applySessionCommand = (
  session: RasterGameSession,
  clientId: string,
  message: RasterClientMessage,
): void => {
  switch (message.type) {
    case "CLIENT_RASTER_SELECT_SPAWN":
      session.selectSpawn(clientId, message.payload.x, message.payload.y);
      break;
    case "CLIENT_RASTER_EXPAND":
      session.queueExpand(clientId, message.payload);
      break;
    case "CLIENT_RASTER_BUILD":
      session.queueBuild(clientId, message.payload);
      break;
    case "CLIENT_RASTER_NUKE":
      session.queueNuke(clientId, message.payload);
      break;
    case "CLIENT_RASTER_ALLY_PROPOSE":
      session.proposeAlliance(clientId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_ALLY_RESPOND":
      session.respondAlliance(clientId, message.payload.targetId, message.payload.accept);
      break;
    case "CLIENT_RASTER_ALLY_BREAK":
      session.breakAlliance(clientId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_ALLY_RENEW":
      session.renewAlliance(clientId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_RETREAT":
      session.retreat(clientId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_DONATE":
      session.donate(clientId, message.payload.targetId, message.payload.resource, message.payload.percent);
      break;
    case "CLIENT_RASTER_EMBARGO":
      session.setEmbargo(clientId, message.payload.targetId, message.payload.on);
      break;
    case "CLIENT_RASTER_TARGET_REQUEST":
      session.requestTarget(clientId, message.payload.allyId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_EMOJI":
      session.sendEmoji(clientId, message.payload.targetId, message.payload.emoji);
      break;
    default:
      break;
  }
};
