import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();

// The player picks a map in the main menu, then presses Start to begin a run.
// The map cards act as a single-select group (one stays highlighted); the Start
// button launches the run on whichever map is currently selected.
let selectedMapId = DEFAULT_MAP_CHOICE_ID;

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

// Start the run on the currently selected map.
const startButton = document.querySelector<HTMLButtonElement>("#startButton");
startButton?.addEventListener("click", () => {
  startRasterClient(ui, { mapId: selectedMapId });
});
