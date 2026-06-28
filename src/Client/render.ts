import type { ActiveConflict, GameStateSnapshot, Territory } from "../Core/types.js";
import type { UiElements } from "./dom.js";
import { computeAttackTroops } from "./geometry.js";
import { clientState } from "./state.js";

const TERRITORY_NAME_OFFSET_X = 45;
const TERRITORY_NAME_OFFSET_Y = -2;
const TROOP_COUNT_OFFSET_X = 36;
const TROOP_COUNT_OFFSET_Y = 16;
const PULSE_ANIMATION_PERIOD_MS = 160;

const tracePolygon = (context: CanvasRenderingContext2D, territory: Territory): void => {
  context.beginPath();
  context.moveTo(territory.polygon[0].x, territory.polygon[0].y);
  for (let i = 1; i < territory.polygon.length; i += 1) {
    context.lineTo(territory.polygon[i].x, territory.polygon[i].y);
  }
  context.closePath();
};

/**
 * Draw the conflict overlay for a contested territory.
 * A gradient washes the attacker's color from the source-centroid direction
 * inward, covering `conflict.progress` of the territory depth.
 * A pulsing stroke on the border indicates active fighting.
 */
const renderConflictOverlay = (
  ui: UiElements,
  snapshot: GameStateSnapshot,
  territory: Territory,
  conflict: ActiveConflict,
): void => {
  const context = ui.mapContext;
  const source = snapshot.territories[conflict.sourceTerritoryId];
  const attackerColor = snapshot.teams[conflict.attackerTeamId].color;

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

  const gradient = context.createLinearGradient(originX, originY, endX, endY);
  gradient.addColorStop(0, `${attackerColor}cc`);
  gradient.addColorStop(conflict.progress, `${attackerColor}44`);
  gradient.addColorStop(Math.min(1, conflict.progress + 0.05), `${attackerColor}00`);

  context.save();
  tracePolygon(context, territory);
  context.clip();

  context.fillStyle = gradient;
  context.globalAlpha = 0.85;
  context.fill();
  context.globalAlpha = 1;
  context.restore();

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / PULSE_ANIMATION_PERIOD_MS);
  tracePolygon(context, territory);
  context.strokeStyle = attackerColor;
  context.lineWidth = 2 + pulse * 3;
  context.globalAlpha = 0.6 + pulse * 0.4;
  context.stroke();
  context.globalAlpha = 1;
};

export const renderMap = (ui: UiElements): void => {
  const snapshot = clientState.snapshot;
  if (!snapshot) {
    return;
  }

  const context = ui.mapContext;
  context.clearRect(0, 0, ui.mapCanvas.width, ui.mapCanvas.height);
  context.fillStyle = "#0b1220";
  context.fillRect(0, 0, ui.mapCanvas.width, ui.mapCanvas.height);

  const conflictByTarget = new Map<string, ActiveConflict>();
  for (const conflict of snapshot.activeConflicts) {
    conflictByTarget.set(conflict.targetTerritoryId, conflict);
  }

  for (const territoryId of snapshot.territoryOrder) {
    const territory = snapshot.territories[territoryId];
    const team = snapshot.teams[territory.ownerId];
    const isSelected = territory.id === clientState.selectedSourceTerritoryId;
    const conflict = conflictByTarget.get(territory.id);

    tracePolygon(context, territory);
    context.fillStyle = team.color;
    context.globalAlpha = isSelected ? 0.95 : 0.72;
    context.fill();
    context.globalAlpha = 1;

    if (conflict) {
      renderConflictOverlay(ui, snapshot, territory, conflict);
    }

    if (!conflict) {
      tracePolygon(context, territory);
      context.strokeStyle = isSelected ? "#f8fafc" : "#1f2937";
      context.lineWidth = isSelected ? 4 : 2;
      context.stroke();
    }

    context.fillStyle = "#f8fafc";
    context.font = "bold 14px sans-serif";
    context.fillText(
      territory.name,
      territory.center.x - TERRITORY_NAME_OFFSET_X,
      territory.center.y + TERRITORY_NAME_OFFSET_Y,
    );
    context.font = "13px sans-serif";

    if (conflict) {
      context.fillText(
        `${conflict.attackingTroops} ⚔ ${conflict.defendingTroops}`,
        territory.center.x - TROOP_COUNT_OFFSET_X,
        territory.center.y + TROOP_COUNT_OFFSET_Y,
      );
    } else {
      context.fillText(
        `${territory.troops} troops`,
        territory.center.x - TROOP_COUNT_OFFSET_X,
        territory.center.y + TROOP_COUNT_OFFSET_Y,
      );
    }
  }

  context.fillStyle = "#cbd5e1";
  context.font = "14px sans-serif";
  context.fillText(`Tick ${snapshot.tick}`, 16, ui.mapCanvas.height - 14);

  if (snapshot.winnerTeamId) {
    const winnerColor = snapshot.teams[snapshot.winnerTeamId].color;
    const winnerName = snapshot.teams[snapshot.winnerTeamId].name;
    context.save();
    context.globalAlpha = 0.55;
    context.fillStyle = "#000";
    context.fillRect(0, ui.mapCanvas.height / 2 - 48, ui.mapCanvas.width, 96);
    context.globalAlpha = 1;
    context.fillStyle = winnerColor;
    context.font = "bold 32px sans-serif";
    context.textAlign = "center";
    context.fillText(`${winnerName} wins`, ui.mapCanvas.width / 2, ui.mapCanvas.height / 2 + 12);
    context.textAlign = "start";
    context.restore();
  }
};

export const renderTeamInfo = (ui: UiElements): void => {
  const snapshot = clientState.snapshot;
  if (!snapshot || !clientState.myTeamId) {
    ui.teamInfo.textContent = "Connecting...";
    return;
  }

  const team = snapshot.teams[clientState.myTeamId];
  ui.teamInfo.textContent = team.name;
  ui.teamInfo.style.color = team.color;
};

export const renderSidebar = (ui: UiElements): void => {
  const snapshot = clientState.snapshot;
  if (!snapshot) {
    return;
  }

  if (clientState.selectedSourceTerritoryId) {
    const source = snapshot.territories[clientState.selectedSourceTerritoryId];
    if (!source || source.ownerId !== clientState.myTeamId) {
      clientState.selectedSourceTerritoryId = null;
      ui.selectionInfo.textContent = "No source territory selected.";
    } else {
      const percent = Number(ui.attackPercentInput.value);
      const troopsPreview = computeAttackTroops(source.troops, percent);
      ui.selectionInfo.textContent =
        troopsPreview > 0
          ? `Source: ${source.name} — ${source.troops} troops → send ${troopsPreview} (${percent}%).`
          : `Source: ${source.name} — ${source.troops} troops (need at least 2 to attack).`;
    }
  } else {
    ui.selectionInfo.textContent = "No source territory selected.";
  }

  const list = document.createElement("ul");
  for (const event of snapshot.recentEvents) {
    const item = document.createElement("li");
    item.textContent = event;
    list.append(item);
  }
  ui.eventsPanel.replaceChildren(list);
};

export const renderSnapshot = (ui: UiElements): void => {
  renderTeamInfo(ui);
  renderSidebar(ui);
};

/** Kick off the requestAnimationFrame loop that redraws the map every frame. */
export const startAnimationLoop = (ui: UiElements): void => {
  const animationLoop = (): void => {
    renderMap(ui);
    requestAnimationFrame(animationLoop);
  };
  requestAnimationFrame(animationLoop);
};
