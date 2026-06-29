<<<<<<< HEAD
import { getUiElements, hideMenu } from "./dom.js";
import { registerInputHandlers } from "./input.js";
import { connect, type ConnectMode } from "./net.js";
import { startAnimationLoop } from "./render.js";

const ui = getUiElements();
startAnimationLoop(ui);

const startMatch = (mode: ConnectMode): void => {
  hideMenu(ui);
  const net = connect(ui, mode);
  registerInputHandlers(ui, net);
};

ui.playSoloButton.addEventListener("click", () => startMatch("solo"));
ui.playMultiButton.addEventListener("click", () => startMatch("multi"));
=======
import { getUiElements } from "./dom.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();

ui.playButton.addEventListener("click", () => {
  startRasterClient(ui);
});
>>>>>>> origin/main
