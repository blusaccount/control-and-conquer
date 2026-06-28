/**
 * Resolved references to every DOM element the client drives, plus small DOM
 * helpers. Centralising element lookup keeps the "did the page load correctly"
 * guard in one place and gives render/input/net a typed handle to work against.
 */
export interface UiElements {
  mapCanvas: HTMLCanvasElement;
  mapContext: CanvasRenderingContext2D;
  teamInfo: HTMLDivElement;
  attackPercentInput: HTMLInputElement;
  attackPercentOutput: HTMLOutputElement;
  clearSelectionButton: HTMLButtonElement;
  selectionInfo: HTMLDivElement;
  statusMessage: HTMLDivElement;
  eventsPanel: HTMLDivElement;
}

export type StatusKind = "info" | "error" | "victory";

export const getUiElements = (): UiElements => {
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

  return {
    mapCanvas,
    mapContext,
    teamInfo,
    attackPercentInput,
    attackPercentOutput,
    clearSelectionButton,
    selectionInfo,
    statusMessage,
    eventsPanel,
  };
};

export const setStatus = (ui: UiElements, message: string, kind: StatusKind = "info"): void => {
  ui.statusMessage.textContent = message;
  ui.statusMessage.classList.toggle("error", kind === "error");
  ui.statusMessage.classList.toggle("victory", kind === "victory");
};
