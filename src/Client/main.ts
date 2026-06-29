import { ALL_PLAYER_CLASS_IDS, PLAYER_CLASS_DEFINITIONS } from "../Core/playerClasses.js";
import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();

// The player picks a map and a starter class before a run begins. The map cards
// act as a single-select group (one stays highlighted); picking a class card is
// what actually starts the run, using whichever map is currently selected.
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

// Build the starter-class cards from the shared definitions, so the UI and the
// engine never drift on names/descriptions. Picking a card starts a run with
// that class on the currently selected map.
const cards = document.querySelector<HTMLDivElement>("#classCards");
if (cards) {
  cards.innerHTML = ALL_PLAYER_CLASS_IDS.map((id) => {
    const def = PLAYER_CLASS_DEFINITIONS[id];
    return (
      `<button class="perk-card" type="button" data-class="${def.id}">` +
      `<h3>${def.name}</h3><p>${def.description}</p>` +
      `</button>`
    );
  }).join("");

  for (const card of cards.querySelectorAll<HTMLButtonElement>("[data-class]")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-class");
      const playerClass = ALL_PLAYER_CLASS_IDS.find((c) => c === id);
      if (playerClass) startRasterClient(ui, { playerClass, mapId: selectedMapId });
    });
  }
}
