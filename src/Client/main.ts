import { getUiElements, hideMenu } from "./dom.js";
import { registerInputHandlers } from "./input.js";
import { connect } from "./net.js";
import { startAnimationLoop } from "./render.js";
import { startRasterClient } from "./rasterClient.js";

const ui = getUiElements();
startAnimationLoop(ui);

ui.playRasterSoloButton.addEventListener("click", () => {
  startRasterClient(ui);
});

ui.playMultiButton.addEventListener("click", () => {
  hideMenu(ui);
  const net = connect(ui);
  registerInputHandlers(ui, net);
});
