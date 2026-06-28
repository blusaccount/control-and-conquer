import type { Territory } from "../Core/types.js";
import { setStatus, type UiElements } from "./dom.js";
import { computeAttackTroops, pointInPolygon } from "./geometry.js";
import type { Net } from "./net.js";
import { renderSidebar, renderSnapshot } from "./render.js";
import { clientState } from "./state.js";

const territoryAt = (x: number, y: number): Territory | null => {
  const snapshot = clientState.snapshot;
  if (!snapshot) {
    return null;
  }

  for (const territoryId of snapshot.territoryOrder) {
    const territory = snapshot.territories[territoryId];
    if (pointInPolygon(x, y, territory.polygon)) {
      return territory;
    }
  }

  return null;
};

export const registerInputHandlers = (ui: UiElements, net: Net): void => {
  ui.attackPercentInput.addEventListener("input", () => {
    ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
    renderSidebar(ui);
  });

  ui.mapCanvas.addEventListener("click", (event) => {
    const snapshot = clientState.snapshot;
    if (!snapshot || !clientState.myTeamId) {
      return;
    }
    if (clientState.matchEnded) {
      setStatus(ui, "The match has ended.", "victory");
      return;
    }

    const bounds = ui.mapCanvas.getBoundingClientRect();
    const scaleX = ui.mapCanvas.width / bounds.width;
    const scaleY = ui.mapCanvas.height / bounds.height;
    const territory = territoryAt((event.clientX - bounds.left) * scaleX, (event.clientY - bounds.top) * scaleY);

    if (!territory) {
      return;
    }

    if (territory.ownerId === clientState.myTeamId) {
      clientState.selectedSourceTerritoryId = territory.id;
      setStatus(ui, `Selected ${territory.name} as source territory.`);
      renderSnapshot(ui);
      return;
    }

    if (!clientState.selectedSourceTerritoryId) {
      setStatus(ui, "Select one of your own territories first.", "error");
      return;
    }

    const source = snapshot.territories[clientState.selectedSourceTerritoryId];
    const percent = Number(ui.attackPercentInput.value);
    const troops = computeAttackTroops(source.troops, percent);

    if (troops < 1) {
      setStatus(ui, "Source needs at least 2 troops to launch an attack.", "error");
      return;
    }

    if (!source.neighbors.includes(territory.id)) {
      setStatus(ui, "Invalid target: not adjacent.", "error");
      return;
    }

    net.sendAttack(source.id, territory.id, troops);
    setStatus(ui, `Attack queued: ${source.name} -> ${territory.name} with ${troops} troops.`);
  });

  ui.clearSelectionButton.addEventListener("click", () => {
    clientState.selectedSourceTerritoryId = null;
    setStatus(ui, "Selection cleared.");
    renderSnapshot(ui);
  });
};
