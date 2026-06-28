import { getUiElements } from "./dom.js";
import { registerInputHandlers } from "./input.js";
import { connect } from "./net.js";
import { startAnimationLoop } from "./render.js";

const ui = getUiElements();
startAnimationLoop(ui);
const net = connect(ui);
registerInputHandlers(ui, net);
