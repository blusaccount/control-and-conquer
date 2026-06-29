import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import { RASTER_DIFFICULTIES, type RasterDifficulty } from "../Core/messages.js";
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";
import { initSettings } from "./settings.js";

const ui = getUiElements();

// Wire the settings gear (event-log toggle, etc.) before the menu interactions.
initSettings();

// The player picks a map + difficulty in the main menu, then presses Start. Each
// card group is single-select (one stays highlighted); Start launches the run
// with whatever is currently selected.
let selectedMapId = DEFAULT_MAP_CHOICE_ID;
let selectedDifficulty: RasterDifficulty = "medium";

const DIFFICULTY_INFO: Record<RasterDifficulty, { name: string; description: string }> = {
  easy: { name: "Easy", description: "A small field of cautious rivals — room to find your feet." },
  medium: { name: "Medium", description: "A balanced field of opponents at a steady pace." },
  hard: { name: "Hard", description: "A crowded map of many aggressive nations." },
};

const mapCards = document.querySelector<HTMLDivElement>("#mapCards");
if (mapCards) {
  // Build the map cards from the shared catalogue so the menu and the server
  // never drift on the set of selectable maps.
  mapCards.innerHTML = MAP_CHOICES.map((choice) => {
    const selected = choice.id === selectedMapId ? " selected" : "";
    return (
      `<button class="perk-card map-card${selected}" type="button" data-map="${choice.id}" aria-pressed="${choice.id === selectedMapId}">` +
      `<h3>${choice.name}</h3><p>${choice.description}</p>` +
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
