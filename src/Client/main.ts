import { ActiveConflict, ClientMessage, GameStateSnapshot, ServerMessage, TeamId, Territory } from "../Core/types.js";

const mapCanvas = document.querySelector<HTMLCanvasElement>("#mapCanvas");
const teamInfo = document.querySelector<HTMLDivElement>("#teamInfo");
const attackPercentInput = document.querySelector<HTMLInputElement>("#attackPercentInput");
const attackPercentOutput = document.querySelector<HTMLOutputElement>("#attackPercentOutput");
const clearSelectionButton = document.querySelector<HTMLButtonElement>("#clearSelectionButton");
const selectionInfo = document.querySelector<HTMLDivElement>("#selectionInfo");
const statusMessage = document.querySelector<HTMLDivElement>("#statusMessage");
const eventsPanel = document.querySelector<HTMLDivElement>("#events");

if (
  !mapCanvas ||
  !teamInfo ||
  !attackPercentInput ||
  !attackPercentOutput ||
  !clearSelectionButton ||
  !selectionInfo ||
  !statusMessage ||
  !eventsPanel
) {
  throw new Error("UI failed to initialize.");
}

const mapContext = mapCanvas.getContext("2d");
if (!mapContext) {
  throw new Error("Canvas context unavailable.");
}

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

let state: GameStateSnapshot | null = null;
let myTeamId: TeamId | null = null;
let selectedSourceTerritoryId: string | null = null;
let matchEnded = false;
const teamNames: Record<TeamId, string> = { blue: "Blue Team", red: "Red Team" };
const territoryNameOffsetX = 45;
const territoryNameOffsetY = -2;
const troopCountOffsetX = 36;
const troopCountOffsetY = 16;
const PULSE_ANIMATION_PERIOD_MS = 160;

const setStatus = (message: string, kind: "info" | "error" | "victory" = "info"): void => {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", kind === "error");
  statusMessage.classList.toggle("victory", kind === "victory");
};

const renderTeamInfo = (): void => {
  if (!state || !myTeamId) {
    teamInfo.textContent = "Connecting...";
    return;
  }

  const team = state.teams[myTeamId];
  teamInfo.textContent = team.name;
  teamInfo.style.color = team.color;
};

const pointInPolygon = (x: number, y: number, points: Array<{ x: number; y: number }>): boolean => {
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;

    const crossesScanline = (yi > y) !== (yj > y);
    const denominator = yj - yi;
    if (denominator === 0) {
      continue;
    }
    const edgeIntersectionX = ((xj - xi) * (y - yi)) / denominator + xi;
    const isLeftOfIntersection = x < edgeIntersectionX;

    if (crossesScanline && isLeftOfIntersection) {
      inside = !inside;
    }
  }

  return inside;
};

const territoryAt = (x: number, y: number): Territory | null => {
  if (!state) {
    return null;
  }

  for (const territoryId of state.territoryOrder) {
    const territory = state.territories[territoryId];
    if (pointInPolygon(x, y, territory.polygon)) {
      return territory;
    }
  }

  return null;
};

/**
 * Compute the integer troop count to send given the slider percentage and the
 * current source garrison. Always leaves at least 1 troop behind.
 */
const computeAttackTroops = (sourceTroops: number, percent: number): number => {
  const maxSendable = sourceTroops - 1;
  if (maxSendable < 1) {
    return 0;
  }
  const raw = Math.floor((sourceTroops * percent) / 100);
  return Math.max(1, Math.min(raw, maxSendable));
};

/**
 * Draw the conflict overlay for a contested territory.
 * A gradient washes the attacker's color from the source-centroid direction
 * inward, covering `conflict.progress` of the territory depth.
 * A pulsing stroke on the border indicates active fighting.
 */
const renderConflictOverlay = (territory: Territory, conflict: ActiveConflict): void => {
  const source = state!.territories[conflict.sourceTerritoryId];
  const attackerColor = state!.teams[conflict.attackerTeamId].color;

  const dx = territory.center.x - source.center.x;
  const dy = territory.center.y - source.center.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const ndx = dx / length;
  const ndy = dy / length;

  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const pt of territory.polygon) {
    const proj = (pt.x - territory.center.x) * ndx + (pt.y - territory.center.y) * ndy;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  const depth = maxProj - minProj || 1;

  const originX = territory.center.x + ndx * minProj;
  const originY = territory.center.y + ndy * minProj;
  const endX = originX + ndx * depth;
  const endY = originY + ndy * depth;

  const gradient = mapContext.createLinearGradient(originX, originY, endX, endY);
  gradient.addColorStop(0, `${attackerColor}cc`);
  gradient.addColorStop(conflict.progress, `${attackerColor}44`);
  gradient.addColorStop(Math.min(1, conflict.progress + 0.05), `${attackerColor}00`);

  mapContext.save();
  mapContext.beginPath();
  mapContext.moveTo(territory.polygon[0].x, territory.polygon[0].y);
  for (let i = 1; i < territory.polygon.length; i += 1) {
    mapContext.lineTo(territory.polygon[i].x, territory.polygon[i].y);
  }
  mapContext.closePath();
  mapContext.clip();

  mapContext.fillStyle = gradient;
  mapContext.globalAlpha = 0.85;
  mapContext.fill();
  mapContext.globalAlpha = 1;
  mapContext.restore();

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / PULSE_ANIMATION_PERIOD_MS);
  mapContext.beginPath();
  mapContext.moveTo(territory.polygon[0].x, territory.polygon[0].y);
  for (let i = 1; i < territory.polygon.length; i += 1) {
    mapContext.lineTo(territory.polygon[i].x, territory.polygon[i].y);
  }
  mapContext.closePath();
  mapContext.strokeStyle = attackerColor;
  mapContext.lineWidth = 2 + pulse * 3;
  mapContext.globalAlpha = 0.6 + pulse * 0.4;
  mapContext.stroke();
  mapContext.globalAlpha = 1;
};

const renderMap = (): void => {
  if (!state) {
    return;
  }

  mapContext.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  mapContext.fillStyle = "#0b1220";
  mapContext.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  const conflictByTarget = new Map<string, ActiveConflict>();
  for (const conflict of state.activeConflicts) {
    conflictByTarget.set(conflict.targetTerritoryId, conflict);
  }

  for (const territoryId of state.territoryOrder) {
    const territory = state.territories[territoryId];
    const team = state.teams[territory.ownerId];
    const isSelected = territory.id === selectedSourceTerritoryId;
    const conflict = conflictByTarget.get(territory.id);

    mapContext.beginPath();
    mapContext.moveTo(territory.polygon[0].x, territory.polygon[0].y);
    for (let i = 1; i < territory.polygon.length; i += 1) {
      mapContext.lineTo(territory.polygon[i].x, territory.polygon[i].y);
    }
    mapContext.closePath();

    mapContext.fillStyle = team.color;
    mapContext.globalAlpha = isSelected ? 0.95 : 0.72;
    mapContext.fill();
    mapContext.globalAlpha = 1;

    if (conflict) {
      renderConflictOverlay(territory, conflict);
    }

    mapContext.beginPath();
    mapContext.moveTo(territory.polygon[0].x, territory.polygon[0].y);
    for (let i = 1; i < territory.polygon.length; i += 1) {
      mapContext.lineTo(territory.polygon[i].x, territory.polygon[i].y);
    }
    mapContext.closePath();
    if (!conflict) {
      mapContext.strokeStyle = isSelected ? "#f8fafc" : "#1f2937";
      mapContext.lineWidth = isSelected ? 4 : 2;
      mapContext.stroke();
    }

    mapContext.fillStyle = "#f8fafc";
    mapContext.font = "bold 14px sans-serif";
    mapContext.fillText(territory.name, territory.center.x - territoryNameOffsetX, territory.center.y + territoryNameOffsetY);
    mapContext.font = "13px sans-serif";

    if (conflict) {
      mapContext.fillText(
        `${conflict.attackingTroops} ⚔ ${conflict.defendingTroops}`,
        territory.center.x - troopCountOffsetX,
        territory.center.y + troopCountOffsetY,
      );
    } else {
      mapContext.fillText(
        `${territory.troops} troops`,
        territory.center.x - troopCountOffsetX,
        territory.center.y + troopCountOffsetY,
      );
    }
  }

  mapContext.fillStyle = "#cbd5e1";
  mapContext.font = "14px sans-serif";
  mapContext.fillText(`Tick ${state.tick}`, 16, mapCanvas.height - 14);

  if (state.winnerTeamId) {
    const winnerColor = state.teams[state.winnerTeamId].color;
    const winnerName = state.teams[state.winnerTeamId].name;
    mapContext.save();
    mapContext.globalAlpha = 0.55;
    mapContext.fillStyle = "#000";
    mapContext.fillRect(0, mapCanvas.height / 2 - 48, mapCanvas.width, 96);
    mapContext.globalAlpha = 1;
    mapContext.fillStyle = winnerColor;
    mapContext.font = "bold 32px sans-serif";
    mapContext.textAlign = "center";
    mapContext.fillText(`${winnerName} wins`, mapCanvas.width / 2, mapCanvas.height / 2 + 12);
    mapContext.textAlign = "start";
    mapContext.restore();
  }
};

const renderSidebar = (): void => {
  if (!state) {
    return;
  }

  if (selectedSourceTerritoryId) {
    const source = state.territories[selectedSourceTerritoryId];
    if (!source || source.ownerId !== myTeamId) {
      selectedSourceTerritoryId = null;
      selectionInfo.textContent = "No source territory selected.";
    } else {
      const percent = Number(attackPercentInput.value);
      const troopsPreview = computeAttackTroops(source.troops, percent);
      selectionInfo.textContent =
        troopsPreview > 0
          ? `Source: ${source.name} — ${source.troops} troops → send ${troopsPreview} (${percent}%).`
          : `Source: ${source.name} — ${source.troops} troops (need at least 2 to attack).`;
    }
  } else {
    selectionInfo.textContent = "No source territory selected.";
  }

  const list = document.createElement("ul");
  for (const event of state.recentEvents) {
    const item = document.createElement("li");
    item.textContent = event;
    list.append(item);
  }
  eventsPanel.replaceChildren(list);
};

const renderSnapshot = (): void => {
  renderTeamInfo();
  renderSidebar();
};

const animationLoop = (): void => {
  renderMap();
  requestAnimationFrame(animationLoop);
};

requestAnimationFrame(animationLoop);

const sendAttack = (sourceTerritoryId: string, targetTerritoryId: string, troops: number): void => {
  const message: ClientMessage = {
    type: "CLIENT_ATTACK_REQUEST",
    payload: {
      sourceTerritoryId,
      targetTerritoryId,
      troops,
    },
  };

  socket.send(JSON.stringify(message));
};

attackPercentInput.addEventListener("input", () => {
  attackPercentOutput.textContent = `${attackPercentInput.value}%`;
  renderSidebar();
});

mapCanvas.addEventListener("click", (event) => {
  if (!state || !myTeamId) {
    return;
  }
  if (matchEnded) {
    setStatus("The match has ended.", "victory");
    return;
  }

  const bounds = mapCanvas.getBoundingClientRect();
  const scaleX = mapCanvas.width / bounds.width;
  const scaleY = mapCanvas.height / bounds.height;
  const territory = territoryAt((event.clientX - bounds.left) * scaleX, (event.clientY - bounds.top) * scaleY);

  if (!territory) {
    return;
  }

  if (territory.ownerId === myTeamId) {
    selectedSourceTerritoryId = territory.id;
    setStatus(`Selected ${territory.name} as source territory.`);
    renderSnapshot();
    return;
  }

  if (!selectedSourceTerritoryId) {
    setStatus("Select one of your own territories first.", "error");
    return;
  }

  const source = state.territories[selectedSourceTerritoryId];
  const percent = Number(attackPercentInput.value);
  const troops = computeAttackTroops(source.troops, percent);

  if (troops < 1) {
    setStatus("Source needs at least 2 troops to launch an attack.", "error");
    return;
  }

  if (!source.neighbors.includes(territory.id)) {
    setStatus("Invalid target: not adjacent.", "error");
    return;
  }

  sendAttack(source.id, territory.id, troops);
  setStatus(`Attack queued: ${source.name} -> ${territory.name} with ${troops} troops.`);
});

clearSelectionButton.addEventListener("click", () => {
  selectedSourceTerritoryId = null;
  setStatus("Selection cleared.");
  renderSnapshot();
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as ServerMessage;

  if (message.type === "SERVER_LOBBY_WAITING") {
    setStatus("Waiting for an opponent...");
    return;
  }

  if (message.type === "SERVER_PLAYER_ASSIGNED") {
    myTeamId = message.payload.teamId;
    const teamName = state?.teams[message.payload.teamId]?.name ?? teamNames[message.payload.teamId];
    setStatus(`You joined as ${teamName}.`);
    renderSnapshot();
    return;
  }

  if (message.type === "SERVER_STATE_SNAPSHOT") {
    state = message.payload;
    if (state.winnerTeamId && !matchEnded) {
      matchEnded = true;
    }
    renderSnapshot();
    return;
  }

  if (message.type === "SERVER_MATCH_ENDED") {
    matchEnded = true;
    const winnerName = state?.teams[message.payload.winnerTeamId]?.name ?? teamNames[message.payload.winnerTeamId];
    const youWon = myTeamId === message.payload.winnerTeamId;
    setStatus(`${winnerName} ${youWon ? "(you) " : ""}has conquered the map!`, "victory");
    return;
  }

  // Remaining case: SERVER_ACTION_REJECTED
  setStatus(message.payload.message, "error");
});

socket.addEventListener("close", () => {
  setStatus("Connection closed.", "error");
});
