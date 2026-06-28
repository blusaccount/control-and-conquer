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
