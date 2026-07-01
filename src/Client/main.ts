import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import { RASTER_DIFFICULTIES, type RasterDifficulty } from "../Core/messages.js";
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";
import { initSettings, initFrameControls } from "./settings.js";

const ui = getUiElements();

// Wire the settings gear (event-log toggle, etc.) and the frame controls
// (fullscreen, leave) before the menu interactions.
initSettings();
initFrameControls();

// The player picks a map + difficulty in the main menu, then presses Start. Each
// card group is single-select (one stays highlighted); Start launches the run
// with whatever is currently selected.
let selectedMapId = DEFAULT_MAP_CHOICE_ID;
let selectedDifficulty: RasterDifficulty = "medium";

const DIFFICULTY_INFO: Record<RasterDifficulty, { name: string; description: string }> = {
  easy: { name: "Easy", description: "Fewer, more cautious rivals — room to find your feet." },
  medium: { name: "Medium", description: "A balanced field of opponents pressing at a steady pace." },
  hard: { name: "Hard", description: "A dense, aggressive crowd of nations fighting for every tile." },
};

/**
 * Approx. tile count shown on a map card. Mirrors the server's height formula
 * (Earth's cropped 136° latitude band, rounded to an even height — see
 * `resolveHeightmapSize` in heightmapMaps) so the menu matches the real grid.
 */
const estimateTiles = (mapSize: number): string => {
  const height = Math.round((mapSize * (136 / 360)) / 2) * 2;
  const tiles = mapSize * height;
  if (tiles >= 1_000_000) return `~${(tiles / 1_000_000).toFixed(1)}M tiles`;
  return `~${Math.round(tiles / 1000)}k tiles`;
};

/** Split "Earth — Large" into a kicker ("Earth") and a prominent tier ("Large"). */
const splitMapName = (name: string): { kicker?: string; title: string } => {
  const parts = name.split(/\s*—\s*/);
  return parts.length > 1 ? { kicker: parts[0], title: parts.slice(1).join(" — ") } : { title: name };
};

const mapCards = document.querySelector<HTMLDivElement>("#mapCards");
if (mapCards) {
  // Build the map cards from the shared catalogue so the menu and the server
  // never drift on the set of selectable maps.
  mapCards.innerHTML = MAP_CHOICES.map((choice) => {
    const selected = choice.id === selectedMapId ? " selected" : "";
    const { kicker, title } = splitMapName(choice.name);
    const isDefault = choice.id === DEFAULT_MAP_CHOICE_ID;
    const tiles = choice.options.mapSize ? estimateTiles(choice.options.mapSize) : "";
    return (
      `<button class="perk-card map-card${selected}" type="button" data-map="${choice.id}" aria-pressed="${choice.id === selectedMapId}">` +
      `<div class="map-card-head">` +
      (kicker ? `<span class="map-kicker">${kicker}</span>` : "") +
      (isDefault ? `<span class="map-default">Default</span>` : "") +
      `</div>` +
      `<h3>${title}</h3><p>${choice.description}</p>` +
      (tiles ? `<div class="map-meta">${tiles}</div>` : "") +
      `</button>`
    );
  }).join("");

  for (const card of mapCards.querySelectorAll<HTMLButtonElement>("[data-map]")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-map");
      const choice = MAP_CHOICES.find((c) => c.id === id);
      if (!choice) return;
      selectedMapId = choice.id;
      for (const other of mapCards.querySelectorAll<HTMLButtonElement>(".map-card")) {
        const isSelected = other === card;
        other.classList.toggle("selected", isSelected);
        other.setAttribute("aria-pressed", String(isSelected));
      }
    });
  }
}

const difficultyCards = document.querySelector<HTMLDivElement>("#difficultyCards");
if (difficultyCards) {
  difficultyCards.innerHTML = RASTER_DIFFICULTIES.map((id) => {
    const info = DIFFICULTY_INFO[id];
    const selected = id === selectedDifficulty ? " selected" : "";
    return (
      `<button class="perk-card map-card${selected}" type="button" data-difficulty="${id}" aria-pressed="${id === selectedDifficulty}">` +
      `<h3>${info.name}</h3><p>${info.description}</p>` +
      `</button>`
    );
  }).join("");

  for (const card of difficultyCards.querySelectorAll<HTMLButtonElement>("[data-difficulty]")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-difficulty");
      const choice = RASTER_DIFFICULTIES.find((d) => d === id);
      if (!choice) return;
      selectedDifficulty = choice;
      for (const other of difficultyCards.querySelectorAll<HTMLButtonElement>(".map-card")) {
        const isSelected = other === card;
        other.classList.toggle("selected", isSelected);
        other.setAttribute("aria-pressed", String(isSelected));
      }
    });
  }
}

// Start the run on the currently selected map + difficulty.
const startButton = document.querySelector<HTMLButtonElement>("#startButton");
startButton?.addEventListener("click", () => {
  startRasterClient(ui, { mapId: selectedMapId, difficulty: selectedDifficulty });
});
