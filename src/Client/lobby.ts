import type { RasterLobbyStatePayload } from "../Core/messages.js";
import type { RasterLockstepStartPayload } from "../Core/lockstep.js";
import type { RasterServerMessage } from "../Core/types.js";
import type { LockstepAttachOptions } from "./transport.js";
import type { RasterDifficulty } from "../Core/messages.js";

/**
 * The pre-match lobby client: owns one WebSocket through the whole
 * create → wait → start flow. When the host starts the match, the server
 * sends `SERVER_RASTER_LOCKSTEP_START` on this same socket; the lobby client
 * then steps aside and hands socket + setup to the game client, which drives
 * it through the lockstep transport (see `createLockstepTransport`'s attach
 * mode) — no reconnect, no re-join, no race with the first relay turns.
 * (Turns that arrive before the transport takes over are not lost: the
 * takeover happens synchronously in the same message callback the setup
 * arrived in, before the socket delivers anything further.)
 */
export interface LobbyHooks {
  /** Waiting-room state changed (member joined/left, initial create). */
  onState(state: RasterLobbyStatePayload): void;
  /**
   * A lobby command failed. `fatal` mirrors the server's flag: this
   * connection holds no room (bad code, full room, host left) — the UI
   * should drop back to the form. Non-fatal errors leave the room intact.
   */
  onError(message: string, fatal: boolean): void;
  /** The host started the match — boot the game client with this handover. */
  onMatchStart(attach: LockstepAttachOptions): void;
  /** The socket died before the match started. */
  onClosed(): void;
}

export interface LobbyClient {
  create(options: {
    mapId: string;
    difficulty: RasterDifficulty;
    fieldSize?: number;
    name?: string;
    crest?: string;
    lobbyName?: string;
    /** Serialized .ccmap for a player-made lobby map (wins over mapId). */
    customMap?: string;
  }): void;
  join(code: string, name?: string, crest?: string): void;
  start(): void;
  leave(): void;
  /** Close the socket without a leave — after a fatal error voided the room. */
  dispose(): void;
}

export const connectLobby = (hooks: LobbyHooks): LobbyClient => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/`);
  /** Once the match starts, this listener goes passive — the transport owns the socket. */
  let handedOver = false;
  const queue: string[] = [];

  const push = (message: unknown): void => {
    const wire = JSON.stringify(message);
    if (socket.readyState === WebSocket.OPEN) socket.send(wire);
    else queue.push(wire);
  };

  socket.addEventListener("open", () => {
    for (const wire of queue.splice(0)) socket.send(wire);
  });
  socket.addEventListener("message", (event) => {
    if (handedOver) return;
    const message = JSON.parse(String(event.data)) as RasterServerMessage;
    if (message.type === "SERVER_RASTER_LOBBY_STATE") {
      hooks.onState(message.payload);
    } else if (message.type === "SERVER_RASTER_LOBBY_ERROR") {
      hooks.onError(message.payload.message, message.payload.fatal === true);
    } else if (message.type === "SERVER_RASTER_ACTION_REJECTED") {
      // A command failed server-side validation before reaching the lobby
      // registry (e.g. a lobby name the server's charset rules reject). No
      // room was created or joined, so treat it like a fatal lobby error —
      // otherwise the rejection would be silently ignored and the menu would
      // stay locked behind a lobby client that never gets a room.
      hooks.onError(message.payload.message, true);
    } else if (message.type === "SERVER_RASTER_LOCKSTEP_START") {
      handedOver = true;
      hooks.onMatchStart({ socket, setup: message.payload as RasterLockstepStartPayload });
    }
  });
  socket.addEventListener("close", () => {
    if (!handedOver) hooks.onClosed();
  });

  return {
    create(options) {
      push({
        type: "CLIENT_RASTER_LOBBY_CREATE",
        payload: {
          mapId: options.mapId,
          difficulty: options.difficulty,
          ...(options.fieldSize !== undefined ? { fieldSize: options.fieldSize } : {}),
          ...(options.name ? { name: options.name } : {}),
          ...(options.crest ? { crest: options.crest } : {}),
          ...(options.lobbyName ? { lobbyName: options.lobbyName } : {}),
          ...(options.customMap ? { customMap: options.customMap } : {}),
        },
      });
    },
    join(code, name, crest) {
      push({
        type: "CLIENT_RASTER_LOBBY_JOIN",
        payload: { code, ...(name ? { name } : {}), ...(crest ? { crest } : {}) },
      });
    },
    start() {
      push({ type: "CLIENT_RASTER_LOBBY_START" });
    },
    leave() {
      push({ type: "CLIENT_RASTER_LOBBY_LEAVE" });
      socket.close();
    },
    dispose() {
      // Tear the connection down without the polite leave — used when an
      // error already voided the room, so no membership is left to give up.
      handedOver = true; // suppress the onClosed hook; this is deliberate
      socket.close();
    },
  };
};
