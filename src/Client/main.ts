import { ClientMessage, GameStateSnapshot, ServerMessage, TeamId, Territory } from "../Core/types.js";

const mapCanvas = document.querySelector<HTMLCanvasElement>("#mapCanvas");
const teamInfo = document.querySelector<HTMLDivElement>("#teamInfo");
const attackTroopsInput = document.querySelector<HTMLInputElement>("#attackTroopsInput");
const clearSelectionButton = document.querySelector<HTMLButtonElement>("#clearSelectionButton");
const selectionInfo = document.querySelector<HTMLDivElement>("#selectionInfo");
const statusMessage = document.querySelector<HTMLDivElement>("#statusMessage");
const eventsPanel = document.querySelector<HTMLDivElement>("#events");

if (!mapCanvas || !teamInfo || !attackTroopsInput || !clearSelectionButton || !selectionInfo || !statusMessage || !eventsPanel) {
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
const teamNames: Record<TeamId, string> = { blue: "Blue Team", red: "Red Team" };
const territoryNameOffsetX = 45;
const territoryNameOffsetY = -2;
const troopCountOffsetX = 36;
const troopCountOffsetY = 16;

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

const setStatus = (message: string, isError = false): void => {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
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

const renderMap = (): void => {
  if (!state) {
    return;
  }

  mapContext.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  mapContext.fillStyle = "#0b1220";
  mapContext.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  for (const territoryId of state.territoryOrder) {
    const territory = state.territories[territoryId];
    const team = state.teams[territory.ownerId];
    const isSelected = territory.id === selectedSourceTerritoryId;

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
    mapContext.strokeStyle = isSelected ? "#f8fafc" : "#1f2937";
    mapContext.lineWidth = isSelected ? 4 : 2;
    mapContext.stroke();

    mapContext.fillStyle = "#f8fafc";
    mapContext.font = "bold 14px sans-serif";
    mapContext.fillText(territory.name, territory.center.x - territoryNameOffsetX, territory.center.y + territoryNameOffsetY);
    mapContext.font = "13px sans-serif";
    mapContext.fillText(
      `${territory.troops} troops`,
      territory.center.x - troopCountOffsetX,
      territory.center.y + troopCountOffsetY,
    );
  }

  mapContext.fillStyle = "#cbd5e1";
  mapContext.font = "14px sans-serif";
  mapContext.fillText(`Tick ${state.tick}`, 16, mapCanvas.height - 14);
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
      selectionInfo.textContent = `Source: ${source.name} (${source.troops} troops, keep at least 1).`;
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

const render = (): void => {
  renderTeamInfo();
  renderSidebar();
  renderMap();
};

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

mapCanvas.addEventListener("click", (event) => {
  if (!state || !myTeamId) {
    return;
  }

  const bounds = mapCanvas.getBoundingClientRect();
  const territory = territoryAt(event.clientX - bounds.left, event.clientY - bounds.top);

  if (!territory) {
    return;
  }

  if (territory.ownerId === myTeamId) {
    selectedSourceTerritoryId = territory.id;
    setStatus(`Selected ${territory.name} as source territory.`);
    render();
    return;
  }

  if (!selectedSourceTerritoryId) {
    setStatus("Select one of your own territories first.", true);
    return;
  }

  const source = state.territories[selectedSourceTerritoryId];
  const troops = Number(attackTroopsInput.value);

  if (!isPositiveInteger(troops)) {
    setStatus("Troops must be a positive integer.", true);
    return;
  }

  if (!source.neighbors.includes(territory.id)) {
    setStatus("Invalid target: not adjacent.", true);
    return;
  }

  sendAttack(source.id, territory.id, troops);
  setStatus(`Attack queued: ${source.name} -> ${territory.name} with ${troops} troops.`);
});

clearSelectionButton.addEventListener("click", () => {
  selectedSourceTerritoryId = null;
  setStatus("Selection cleared.");
  render();
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as ServerMessage;

  if (message.type === "SERVER_PLAYER_ASSIGNED") {
    myTeamId = message.payload.teamId;
    const teamName = state?.teams[message.payload.teamId]?.name ?? teamNames[message.payload.teamId];
    setStatus(`You joined as ${teamName}.`);
    render();
    return;
  }

  if (message.type === "SERVER_STATE_SNAPSHOT") {
    state = message.payload;
    render();
    return;
  }

  setStatus(message.payload.message, true);
});

socket.addEventListener("close", () => {
  setStatus("Connection closed.", true);
});
