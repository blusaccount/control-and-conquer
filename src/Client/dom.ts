/**
 * Resolved references to every DOM element the client drives, plus small DOM
 * helpers. Centralising element lookup keeps the "did the page load correctly"
 * guard in one place and gives the raster client a typed handle to work against.
 */
export interface UiElements {
  mapCanvas: HTMLCanvasElement;
  mapContext: CanvasRenderingContext2D;
  minimapCanvas: HTMLCanvasElement;
  minimapContext: CanvasRenderingContext2D;
  teamInfo: HTMLDivElement;
  attackPercentInput: HTMLInputElement;
  attackPercentOutput: HTMLOutputElement;
  selectionInfo: HTMLDivElement;
  statusMessage: HTMLDivElement;
  goldInfo: HTMLDivElement;
  buildMenu: HTMLDivElement;
  buildHint: HTMLDivElement;
  weaponsMenu: HTMLDivElement;
  /** Wrapper around the Build/Weapons sections, hidden during the spawn phase. */
  buildSections: HTMLDivElement;
  eventsPanel: HTMLDivElement;
  leaderboard: HTMLDivElement;
  menuOverlay: HTMLDivElement;
  statsOverlay: HTMLDivElement;
  /** Countdown banner shown over the map during the opening start phase. */
  startBanner: HTMLDivElement;
  /** Elapsed-match-time readout in the top-right frame bar. */
  matchTimer: HTMLSpanElement;
  /** Right-click contextual pie menu, positioned at the click point. */
  radialMenu: HTMLDivElement;
}

export type StatusKind = "info" | "error" | "victory";

export const getUiElements = (): UiElements => {
  const mapCanvas = document.querySelector<HTMLCanvasElement>("#mapCanvas");
  const minimapCanvas = document.querySelector<HTMLCanvasElement>("#minimapCanvas");
  const teamInfo = document.querySelector<HTMLDivElement>("#teamInfo");
  const attackPercentInput = document.querySelector<HTMLInputElement>("#attackPercentInput");
  const attackPercentOutput = document.querySelector<HTMLOutputElement>("#attackPercentOutput");
  const selectionInfo = document.querySelector<HTMLDivElement>("#selectionInfo");
  const statusMessage = document.querySelector<HTMLDivElement>("#statusMessage");
  const goldInfo = document.querySelector<HTMLDivElement>("#goldInfo");
  const buildMenu = document.querySelector<HTMLDivElement>("#buildMenu");
  const buildHint = document.querySelector<HTMLDivElement>("#buildHint");
  const weaponsMenu = document.querySelector<HTMLDivElement>("#weaponsMenu");
  const buildSections = document.querySelector<HTMLDivElement>("#buildSections");
  const eventsPanel = document.querySelector<HTMLDivElement>("#events");
  const leaderboard = document.querySelector<HTMLDivElement>("#leaderboard");
  const menuOverlay = document.querySelector<HTMLDivElement>("#menuOverlay");
  const statsOverlay = document.querySelector<HTMLDivElement>("#statsOverlay");
  const startBanner = document.querySelector<HTMLDivElement>("#startBanner");
  const matchTimer = document.querySelector<HTMLSpanElement>("#matchTimer");
  const radialMenu = document.querySelector<HTMLDivElement>("#radialMenu");

  if (
    !mapCanvas ||
    !minimapCanvas ||
    !teamInfo ||
    !attackPercentInput ||
    !attackPercentOutput ||
    !selectionInfo ||
    !statusMessage ||
    !goldInfo ||
    !buildMenu ||
    !buildHint ||
    !weaponsMenu ||
    !buildSections ||
    !eventsPanel ||
    !leaderboard ||
    !menuOverlay ||
    !statsOverlay ||
    !startBanner ||
    !matchTimer ||
    !radialMenu
  ) {
    throw new Error("UI failed to initialize.");
  }

  const mapContext = mapCanvas.getContext("2d");
  const minimapContext = minimapCanvas.getContext("2d");
  if (!mapContext || !minimapContext) {
    throw new Error("Canvas context unavailable.");
  }

  return {
    mapCanvas,
    mapContext,
    minimapCanvas,
    minimapContext,
    teamInfo,
    attackPercentInput,
    attackPercentOutput,
    selectionInfo,
    statusMessage,
    goldInfo,
    buildMenu,
    buildHint,
    weaponsMenu,
    buildSections,
    eventsPanel,
    leaderboard,
    menuOverlay,
    statsOverlay,
    startBanner,
    matchTimer,
    radialMenu,
  };
};

export const setStatus = (ui: UiElements, message: string, kind: StatusKind = "info"): void => {
  ui.statusMessage.textContent = message;
  ui.statusMessage.classList.toggle("error", kind === "error");
  ui.statusMessage.classList.toggle("victory", kind === "victory");
};

export const hideMenu = (ui: UiElements): void => {
  ui.menuOverlay.classList.add("hidden");
};
