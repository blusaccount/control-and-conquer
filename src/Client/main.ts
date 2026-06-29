import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();

ui.playButton.addEventListener("click", () => {
  startRasterClient(ui);
});
