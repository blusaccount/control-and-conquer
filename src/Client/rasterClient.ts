import { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterClientMessage,
  RasterPlayerAssignedPayload,
  RasterServerMessage,
  RasterSnapshot,
} from "../Core/types.js";
import { hideMenu, setStatus, type UiElements } from "./dom.js";
import { paintRaster } from "./rasterPaint.js";

/**
 * Self-contained raster-mode client.
 *
 * Owns its own WebSocket, its own canvas-rendering loop and its own click
 * handler. Lives separately from the polygon client (`net.ts` + `render.ts` +
 * `input.ts`) so the two modes don't have to share state or render paths.
 */
interface RasterRuntime {
  map: GameMap | null;
  owner: Uint16Array | null;
  myPlayerId: PlayerId | null;
  myName: string;
  myColor: string;
  pool: number;
  myTiles: number;
  capturableTotal: number;
  recentEvents: string[];
  matchEnded: boolean;
  winnerPlayerId: number | null;
}

const decodeBase64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const decodeOwnerArray = (b64: string, expectedLength: number): Uint16Array => {
  const bytes = decodeBase64ToBytes(b64);
  if (bytes.length !== expectedLength * 2) {
    throw new Error(`Owner array byte length ${bytes.length} does not match expected ${expectedLength * 2}.`);
  }
  const owner = new Uint16Array(expectedLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < expectedLength; i += 1) {
    owner[i] = view.getUint16(i * 2, true /* little-endian */);
  }
  return owner;
};

/** Connect to the raster server, paint each snapshot, and wire click-to-expand. */
export const startRasterClient = (ui: UiElements): void => {
  hideMenu(ui);
  // The raster mode reuses the existing canvas + sidebar but ignores polygon-mode
  // controls. We repurpose the percent slider as "% of pool to commit per click".
  ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
  ui.selectionInfo.textContent = "Click anywhere on the map to expand toward that tile.";
  ui.clearSelectionButton.style.display = "none";

  const runtime: RasterRuntime = {
    map: null,
    owner: null,
    myPlayerId: null,
    myName: "",
    myColor: "#888",
    pool: 0,
    myTiles: 0,
    capturableTotal: 0,
    recentEvents: [],
    matchEnded: false,
    winnerPlayerId: null,
  };

  const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${socketProtocol}://${window.location.host}/?mode=raster-solo`);

  const sendExpand = (targetX: number, targetY: number, percent: number): void => {
    const message: RasterClientMessage = {
      type: "CLIENT_RASTER_EXPAND",
      payload: { targetX, targetY, percent },
    };
    socket.send(JSON.stringify(message));
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as RasterServerMessage;
    handleMessage(message);
  });
  socket.addEventListener("close", () => {
    setStatus(ui, "Connection closed.", "error");
  });

  const handleMessage = (message: RasterServerMessage): void => {
    if (message.type === "SERVER_RASTER_PLAYER_ASSIGNED") {
      onAssigned(message.payload);
    } else if (message.type === "SERVER_RASTER_SNAPSHOT") {
      onSnapshot(message.payload);
    } else if (message.type === "SERVER_RASTER_ACTION_REJECTED") {
      setStatus(ui, message.payload.message, "error");
    } else if (message.type === "SERVER_RASTER_MATCH_ENDED") {
      runtime.matchEnded = true;
      runtime.winnerPlayerId = message.payload.winnerPlayerId;
      const youWon = runtime.myPlayerId === message.payload.winnerPlayerId;
      setStatus(ui, youWon ? "You conquered the map!" : "The map has been conquered.", "victory");
    }
  };

  const onAssigned = (payload: RasterPlayerAssignedPayload): void => {
    runtime.myPlayerId = payload.playerId;
    runtime.myName = payload.name;
    runtime.myColor = payload.color;
    ui.teamInfo.textContent = `Playing as ${payload.name}`;
    ui.teamInfo.style.color = payload.color;
    setStatus(ui, `Assigned as ${payload.name}.`);
  };

  const onSnapshot = (snapshot: RasterSnapshot): void => {
    // Establish the static GameMap on the first snapshot that carries terrain.
    if (snapshot.terrainBase64 && !runtime.map) {
      const terrainBytes = decodeBase64ToBytes(snapshot.terrainBase64);
      runtime.map = new GameMap(snapshot.width, snapshot.height, terrainBytes);
    }
    if (!runtime.map) {
      // Server should always send terrain first; defensive guard.
      return;
    }
    runtime.owner = decodeOwnerArray(snapshot.ownerBase64, snapshot.width * snapshot.height);
    runtime.capturableTotal = snapshot.capturableCount;
    runtime.recentEvents = snapshot.recentEvents;

    const me = snapshot.players.find((p) => p.playerId === runtime.myPlayerId);
    runtime.pool = me?.troops ?? 0;
    runtime.myTiles = me?.tiles ?? 0;
    renderSidebar();
    paintCanvas();
  };

  // ---- Rendering --------------------------------------------------------

  const paintCanvas = (): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner) return;

    // Lazy-allocate the offscreen buffer matched to the map.
    const offscreen = document.createElement("canvas");
    offscreen.width = map.width;
    offscreen.height = map.height;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;
    const imageData = offCtx.createImageData(map.width, map.height);
    paintRaster(map, owner, imageData.data);
    offCtx.putImageData(imageData, 0, 0);

    const ctx = ui.mapContext;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ui.mapCanvas.width, ui.mapCanvas.height);
    ctx.drawImage(offscreen, 0, 0, map.width, map.height, 0, 0, ui.mapCanvas.width, ui.mapCanvas.height);
  };

  const renderSidebar = (): void => {
    const pct = runtime.capturableTotal > 0
      ? Math.round((runtime.myTiles / runtime.capturableTotal) * 100)
      : 0;
    ui.selectionInfo.innerHTML =
      `<strong>Troop pool:</strong> ${runtime.pool}<br/>` +
      `<strong>Tiles:</strong> ${runtime.myTiles} / ${runtime.capturableTotal} (${pct}%)<br/>` +
      `<em>Click anywhere on the map to expand toward that tile.</em>`;

    ui.eventsPanel.innerHTML = runtime.recentEvents
      .map((ev) => `<div class="event">${escapeHtml(ev)}</div>`)
      .join("");
  };

  // ---- Input -----------------------------------------------------------

  ui.mapCanvas.addEventListener("click", (event) => {
    const map = runtime.map;
    if (!map || runtime.matchEnded) return;

    const bounds = ui.mapCanvas.getBoundingClientRect();
    // Translate CSS pixels back to the canvas's pixel space, then to tile coords.
    const cssX = event.clientX - bounds.left;
    const cssY = event.clientY - bounds.top;
    const tileX = Math.floor((cssX / bounds.width) * map.width);
    const tileY = Math.floor((cssY / bounds.height) * map.height);
    if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) return;

    const percent = Number(ui.attackPercentInput.value);
    sendExpand(tileX, tileY, percent);
    setStatus(ui, `Expanding toward (${tileX}, ${tileY}) with ${percent}% of pool.`);
  });

  ui.attackPercentInput.addEventListener("input", () => {
    ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
  });
};

const escapeHtml = (input: string): string =>
  input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
