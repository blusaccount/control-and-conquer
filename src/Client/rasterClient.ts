import { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterClientMessage,
  RasterCrossing,
  RasterPlayerAssignedPayload,
  RasterServerMessage,
  RasterSnapshot,
} from "../Core/types.js";
import { hideMenu, setStatus, type UiElements } from "./dom.js";
import { paintRaster } from "./rasterPaint.js";
import { playerColor } from "./rasterPalette.js";

/**
 * Self-contained raster-mode client.
 *
 * Owns its own WebSocket, a persistent base-map canvas (repainted only when a
 * snapshot arrives) and a requestAnimationFrame overlay loop that animates
 * boats for every amphibious crossing the server reports, so players can see
 * troops travelling across water and rivers.
 */
interface Boat {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  /** performance.now() timestamp when the crossing started animating. */
  start: number;
}

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
  /** Offscreen 1px-per-tile render of terrain + ownership, updated per snapshot. */
  base: HTMLCanvasElement | null;
  /** In-flight boat animations. */
  boats: Boat[];
}

/** How long a single crossing animation lasts, in milliseconds. */
const BOAT_DURATION_MS = 1100;

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

const rgbaToCss = (c: { r: number; g: number; b: number }): string => `rgb(${c.r}, ${c.g}, ${c.b})`;

/** Connect to the raster server, paint each snapshot, and wire click-to-expand. */
export const startRasterClient = (ui: UiElements): void => {
  hideMenu(ui);
  ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
  ui.selectionInfo.textContent = "Click anywhere on the map to expand toward that tile.";

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
    base: null,
    boats: [],
  };

  const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${socketProtocol}://${window.location.host}/`);

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

  const spawnBoats = (crossings: RasterCrossing[]): void => {
    if (crossings.length === 0) return;
    const now = performance.now();
    for (const c of crossings) {
      runtime.boats.push({
        fromX: c.fromX,
        fromY: c.fromY,
        toX: c.toX,
        toY: c.toY,
        color: rgbaToCss(playerColor(c.playerId)),
        start: now,
      });
    }
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

    spawnBoats(snapshot.crossings ?? []);
    renderSidebar();
    repaintBase();
  };

  // ---- Rendering --------------------------------------------------------

  /** Repaint the persistent terrain + ownership layer (1 pixel per tile). */
  const repaintBase = (): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner) return;

    let base = runtime.base;
    if (!base || base.width !== map.width || base.height !== map.height) {
      base = document.createElement("canvas");
      base.width = map.width;
      base.height = map.height;
      runtime.base = base;
    }
    const offCtx = base.getContext("2d");
    if (!offCtx) return;
    const imageData = offCtx.createImageData(map.width, map.height);
    paintRaster(map, owner, imageData.data);
    offCtx.putImageData(imageData, 0, 0);
  };

  /** Composite the base map plus animated boats onto the visible canvas. */
  const renderFrame = (now: number): void => {
    const map = runtime.map;
    const base = runtime.base;
    const ctx = ui.mapContext;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    if (map && base) {
      ctx.drawImage(base, 0, 0, map.width, map.height, 0, 0, cw, ch);
      drawBoats(now, ctx, cw / map.width, ch / map.height);
    }
    requestAnimationFrame(renderFrame);
  };

  const drawBoats = (
    now: number,
    ctx: CanvasRenderingContext2D,
    scaleX: number,
    scaleY: number,
  ): void => {
    if (runtime.boats.length === 0) return;
    const survivors: Boat[] = [];
    for (const boat of runtime.boats) {
      const t = (now - boat.start) / BOAT_DURATION_MS;
      if (t >= 1) continue; // animation finished
      survivors.push(boat);

      const fx = (boat.fromX + 0.5) * scaleX;
      const fy = (boat.fromY + 0.5) * scaleY;
      const tx = (boat.toX + 0.5) * scaleX;
      const ty = (boat.toY + 0.5) * scaleY;
      const cx = fx + (tx - fx) * t;
      const cy = fy + (ty - fy) * t;

      // Wake: a fading dashed line from the launch coast up to the boat.
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.strokeStyle = boat.color;
      ctx.lineWidth = Math.max(1, scaleX * 0.25);
      ctx.setLineDash([Math.max(2, scaleX * 0.5), Math.max(2, scaleX * 0.5)]);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.restore();

      // Boat marker: a small filled dot in the player's colour with a halo so
      // it stays visible over both shallow and deep water.
      const radius = Math.max(2.5, Math.min(scaleX, scaleY) * 0.45);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = boat.color;
      ctx.fill();
      ctx.restore();
    }
    runtime.boats = survivors;
  };

  const renderSidebar = (): void => {
    const pct = runtime.capturableTotal > 0
      ? Math.round((runtime.myTiles / runtime.capturableTotal) * 100)
      : 0;
    ui.selectionInfo.innerHTML =
      `<strong>Troop pool:</strong> ${runtime.pool}<br/>` +
      `<strong>Tiles:</strong> ${runtime.myTiles} / ${runtime.capturableTotal} (${pct}%)<br/>` +
      `<em>Click anywhere on the map to expand toward that tile. You can also land across narrow seas and rivers.</em>`;

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

  requestAnimationFrame(renderFrame);
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
