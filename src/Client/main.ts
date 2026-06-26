import {
  BattleFrame,
  BattleSummary,
  Faction,
  GameState,
  PlayerState,
  Province,
  UnitType,
} from "../Core/types.js";

const mapCanvas = document.querySelector<HTMLCanvasElement>("#mapCanvas");
const battleCanvas = document.querySelector<HTMLCanvasElement>("#battleCanvas");
const playerSelect = document.querySelector<HTMLSelectElement>("#playerSelect");
const playerStats = document.querySelector<HTMLDivElement>("#playerStats");
const provinceStats = document.querySelector<HTMLDivElement>("#provinceStats");
const purchaseUnitType = document.querySelector<HTMLSelectElement>("#purchaseUnitType");
const purchaseCount = document.querySelector<HTMLInputElement>("#purchaseCount");
const purchaseButton = document.querySelector<HTMLButtonElement>("#purchaseButton");
const targetProvince = document.querySelector<HTMLSelectElement>("#targetProvince");
const moveUnitType = document.querySelector<HTMLSelectElement>("#moveUnitType");
const moveCount = document.querySelector<HTMLInputElement>("#moveCount");
const moveButton = document.querySelector<HTMLButtonElement>("#moveButton");
const mineButton = document.querySelector<HTMLButtonElement>("#mineButton");
const eventsPanel = document.querySelector<HTMLDivElement>("#events");
const battleLog = document.querySelector<HTMLDivElement>("#battleLog");

if (
  !mapCanvas ||
  !battleCanvas ||
  !playerSelect ||
  !playerStats ||
  !provinceStats ||
  !purchaseUnitType ||
  !purchaseCount ||
  !purchaseButton ||
  !targetProvince ||
  !moveUnitType ||
  !moveCount ||
  !moveButton ||
  !mineButton ||
  !eventsPanel ||
  !battleLog
) {
  throw new Error("UI failed to initialize.");
}

const mapContext = mapCanvas.getContext("2d");
const battleContext = battleCanvas.getContext("2d");

if (!mapContext || !battleContext) {
  throw new Error("Canvas contexts are unavailable.");
}

let state: GameState | null = null;
let selectedProvinceId: string | null = null;
let animatedBattleId: string | null = null;
let battleStartTime = 0;

const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const socket = new WebSocket(`${socketProtocol}://${window.location.host}`);

const factionLabel = (faction: Faction): string => {
  switch (faction) {
    case Faction.USA:
      return "USA";
    case Faction.China:
      return "China";
    case Faction.GLA:
      return "GLA";
  }
};

const currentPlayer = (): PlayerState | null => {
  if (!state) {
    return null;
  }

  return state.players[playerSelect.value] ?? null;
};

const currentProvince = (): Province | null => {
  if (!state || !selectedProvinceId) {
    return null;
  }

  return state.provinces[selectedProvinceId] ?? null;
};

const sendCommand = (command: unknown): void => {
  socket.send(JSON.stringify(command));
};

const renderPlayerOptions = (): void => {
  if (!state) {
    return;
  }

  if (playerSelect.options.length === 0) {
    for (const player of Object.values(state.players)) {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = `${player.name} (${factionLabel(player.faction)})`;
      playerSelect.append(option);
    }
  }

  if (!playerSelect.value) {
    playerSelect.value = "usa";
  }
};

const refreshTargetOptions = (): void => {
  const province = currentProvince();
  targetProvince.replaceChildren();

  if (!state || !province) {
    return;
  }

  for (const provinceId of state.provinceOrder) {
    if (provinceId === province.id) {
      continue;
    }

    const target = state.provinces[provinceId];
    const option = document.createElement("option");
    option.value = provinceId;
    option.textContent = `${target.name} (${target.ownerId})`;
    targetProvince.append(option);
  }
};

const renderSidebar = (): void => {
  if (!state) {
    return;
  }

  renderPlayerOptions();
  refreshTargetOptions();

  const player = currentPlayer();
  if (player) {
    playerStats.innerHTML = [
      `<strong>${player.name}</strong>`,
      `Faction: ${factionLabel(player.faction)}`,
      `Credits: ${player.credits}`,
      `General level: ${player.generalLevel}`,
      `Mine charges: ${player.mineCharges}`,
      `Wins: ${player.wins}`,
    ].join("<br />");
  }

  const province = currentProvince();
  provinceStats.innerHTML = province
    ? [
        `<strong>${province.name}</strong>`,
        `Owner: ${state.players[province.ownerId].name}`,
        `Units: ${province.units.infantry} infantry / ${province.units.tank} tank`,
        `Mine: ${province.hasMine ? "Armed" : "None"}`,
        `Links: ${province.neighbors.map((id) => state.provinces[id].name).join(", ")}`,
      ].join("<br />")
    : "Select a province on the map.";

  eventsPanel.innerHTML = `<ul>${state.recentEvents.map((event) => `<li>${event}</li>`).join("")}</ul>`;
}

const provinceAt = (x: number, y: number): Province | null => {
  if (!state) {
    return null;
  }

  for (const provinceId of state.provinceOrder) {
    const province = state.provinces[provinceId];
    if (
      x >= province.x &&
      x <= province.x + province.width &&
      y >= province.y &&
      y <= province.y + province.height
    ) {
      return province;
    }
  }

  return null;
};

const renderMap = (): void => {
  if (!state) {
    return;
  }

  mapContext.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  mapContext.fillStyle = "#09111d";
  mapContext.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  for (const provinceId of state.provinceOrder) {
    const province = state.provinces[provinceId];
    const owner = state.players[province.ownerId];

    mapContext.fillStyle = owner.color;
    mapContext.globalAlpha = selectedProvinceId === province.id ? 0.95 : 0.75;
    mapContext.fillRect(province.x, province.y, province.width, province.height);
    mapContext.globalAlpha = 1;
    mapContext.strokeStyle = "#f9fafb";
    mapContext.lineWidth = selectedProvinceId === province.id ? 3 : 1;
    mapContext.strokeRect(province.x, province.y, province.width, province.height);

    mapContext.fillStyle = "#ffffff";
    mapContext.font = "bold 16px sans-serif";
    mapContext.fillText(province.name, province.x + 10, province.y + 24);
    mapContext.font = "13px sans-serif";
    mapContext.fillText(`Owner: ${owner.name}`, province.x + 10, province.y + 45);
    mapContext.fillText(
      `${province.units.infantry} inf / ${province.units.tank} tank`,
      province.x + 10,
      province.y + 64,
    );
    if (province.hasMine) {
      mapContext.fillText("Mine armed", province.x + 10, province.y + 82);
    }
  }

  mapContext.fillStyle = "#d1d5db";
  mapContext.font = "14px sans-serif";
  mapContext.fillText(`Tick ${state.tick}`, 16, mapCanvas.height - 16);
}

const battleFrameForTime = (battle: BattleSummary): BattleFrame | null => {
  if (battle.timeline.length === 0) {
    return null;
  }

  const elapsedSeconds = (performance.now() - battleStartTime) / 1000;
  const finalFrame = battle.timeline[battle.timeline.length - 1];

  if (elapsedSeconds >= finalFrame.time) {
    return finalFrame;
  }

  for (const frame of battle.timeline) {
    if (frame.time >= elapsedSeconds) {
      return frame;
    }
  }

  return finalFrame;
};

const renderBattle = (): void => {
  battleContext.clearRect(0, 0, battleCanvas.width, battleCanvas.height);
  battleContext.fillStyle = "#0f172a";
  battleContext.fillRect(0, 0, battleCanvas.width, battleCanvas.height);

  if (!state?.lastBattle) {
    battleContext.fillStyle = "#e5e7eb";
    battleContext.font = "16px sans-serif";
    battleContext.fillText("No battle has been fought yet.", 24, 40);
    battleLog.textContent = "";
    return;
  }

  const battle = state.lastBattle;
  if (animatedBattleId !== battle.id) {
    animatedBattleId = battle.id;
    battleStartTime = performance.now();
  }

  const frame = battleFrameForTime(battle);
  const attacker = state.players[battle.attackerId];
  const defender = state.players[battle.defenderId];

  battleContext.fillStyle = "#e5e7eb";
  battleContext.font = "bold 15px sans-serif";
  battleContext.fillText(`${attacker.name} vs ${defender.name}`, 24, 24);
  battleContext.font = "14px sans-serif";
  battleContext.fillText(
    battle.winnerId ? `Winner: ${state.players[battle.winnerId].name}` : "Result: draw",
    24,
    46,
  );

  if (frame) {
    for (const unit of frame.units) {
      battleContext.fillStyle = unit.side === "attacker" ? attacker.color : defender.color;
      const y = unit.side === "attacker" ? 90 : 130;
      const radius = unit.unitType === UnitType.Tank ? 10 : 6;
      battleContext.beginPath();
      battleContext.arc(70 + unit.x, y, radius, 0, Math.PI * 2);
      battleContext.fill();
    }
  }

  battleLog.innerHTML = `<strong>Battle log</strong><ul>${battle.log.map((entry) => `<li>${entry}</li>`).join("")}</ul>`;
}

const render = (): void => {
  renderSidebar();
  renderMap();
  renderBattle();
  requestAnimationFrame(render);
};

mapCanvas.addEventListener("click", (event) => {
  const bounds = mapCanvas.getBoundingClientRect();
  const province = provinceAt(event.clientX - bounds.left, event.clientY - bounds.top);

  if (province) {
    selectedProvinceId = province.id;
    refreshTargetOptions();
    renderSidebar();
  }
});

purchaseButton.addEventListener("click", () => {
  const player = currentPlayer();
  const province = currentProvince();
  if (!player || !province) {
    return;
  }

  sendCommand({
    type: "purchase",
    playerId: player.id,
    provinceId: province.id,
    unitType: purchaseUnitType.value,
    count: Number(purchaseCount.value),
  });
});

moveButton.addEventListener("click", () => {
  const player = currentPlayer();
  const province = currentProvince();
  if (!player || !province || !targetProvince.value) {
    return;
  }

  sendCommand({
    type: "move",
    playerId: player.id,
    fromProvinceId: province.id,
    toProvinceId: targetProvince.value,
    unitType: moveUnitType.value,
    count: Number(moveCount.value),
  });
});

mineButton.addEventListener("click", () => {
  const player = currentPlayer();
  const province = currentProvince();
  if (!player || !province) {
    return;
  }

  sendCommand({
    type: "placeMine",
    playerId: player.id,
    provinceId: province.id,
  });
});

playerSelect.addEventListener("change", () => {
  renderSidebar();
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as
    | { type: "snapshot"; payload: GameState }
    | { type: "error"; payload: { message: string } };

  if (message.type === "snapshot") {
    state = message.payload;
    if (!selectedProvinceId) {
      selectedProvinceId = state.provinceOrder[0];
    }
    renderSidebar();
    return;
  }

  window.alert(message.payload.message);
});

requestAnimationFrame(render);
