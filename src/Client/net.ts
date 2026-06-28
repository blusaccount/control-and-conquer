import type { ClientMessage, ServerMessage } from "../Core/types.js";
import { setStatus, type UiElements } from "./dom.js";
import { renderSnapshot } from "./render.js";
import { clientState, FALLBACK_TEAM_NAMES } from "./state.js";

/** Handle to the live connection exposed to the input layer. */
export interface Net {
  sendAttack: (sourceTerritoryId: string, targetTerritoryId: string, troops: number) => void;
}

const handleServerMessage = (ui: UiElements, message: ServerMessage): void => {
  if (message.type === "SERVER_LOBBY_WAITING") {
    setStatus(ui, "Waiting for an opponent...");
    return;
  }

  if (message.type === "SERVER_PLAYER_ASSIGNED") {
    clientState.myTeamId = message.payload.teamId;
    const teamName =
      clientState.snapshot?.teams[message.payload.teamId]?.name ?? FALLBACK_TEAM_NAMES[message.payload.teamId];
    setStatus(ui, `You joined as ${teamName}.`);
    renderSnapshot(ui);
    return;
  }

  if (message.type === "SERVER_STATE_SNAPSHOT") {
    clientState.snapshot = message.payload;
    if (clientState.snapshot.winnerTeamId && !clientState.matchEnded) {
      clientState.matchEnded = true;
    }
    renderSnapshot(ui);
    return;
  }

  if (message.type === "SERVER_MATCH_ENDED") {
    clientState.matchEnded = true;
    const winnerName =
      clientState.snapshot?.teams[message.payload.winnerTeamId]?.name ??
      FALLBACK_TEAM_NAMES[message.payload.winnerTeamId];
    const youWon = clientState.myTeamId === message.payload.winnerTeamId;
    setStatus(ui, `${winnerName} ${youWon ? "(you) " : ""}has conquered the map!`, "victory");
    return;
  }

  // Remaining case: SERVER_ACTION_REJECTED
  setStatus(ui, message.payload.message, "error");
};

export const connect = (ui: UiElements): Net => {
  const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    handleServerMessage(ui, message);
  });

  socket.addEventListener("close", () => {
    setStatus(ui, "Connection closed.", "error");
  });

  const sendAttack = (sourceTerritoryId: string, targetTerritoryId: string, troops: number): void => {
    const message: ClientMessage = {
      type: "CLIENT_ATTACK_REQUEST",
      payload: { sourceTerritoryId, targetTerritoryId, troops },
    };
    socket.send(JSON.stringify(message));
  };

  return { sendAttack };
};
