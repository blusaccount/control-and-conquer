import { ALL_PLAYER_CLASS_IDS, PLAYER_CLASS_DEFINITIONS } from "../Core/playerClasses.js";
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();

// Build the starter-class cards in the main menu from the shared definitions, so
// the UI and the engine never drift on names/descriptions. Picking a card starts
// a run with that class.
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
      if (playerClass) startRasterClient(ui, { playerClass });
    });
  }
}
