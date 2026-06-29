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
import { paintRaster, paintTileInto } from "./rasterPaint.js";
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

/**
 * Camera over the (potentially million-tile) base map. `scale` is screen pixels
 * per tile; `(x, y)` is the tile coordinate at the canvas's top-left corner.
 * Players pan by dragging and zoom with the wheel, so a huge real-world map is
 * navigable instead of being squashed into a few hundred pixels.
 */
interface View {
  scale: number;
  x: number;
  y: number;
  initialized: boolean;
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
  /** Backing pixel buffer for `base`, kept so deltas can repaint single tiles. */
  baseImage: ImageData | null;
  /** Pan/zoom camera over the base map. */
  view: View;
  /** In-flight boat animations. */
  boats: Boat[];
}

/** How long a single crossing animation lasts, in milliseconds. */
const BOAT_DURATION_MS = 1100;

/** Hard zoom-in ceiling, in screen pixels per tile. */
const MAX_TILE_SCALE = 16;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

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
  ui.selectionInfo.textContent =
    "Click to expand toward a tile. Drag to pan, scroll to zoom.";

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
    baseImage: null,
    view: { scale: 1, x: 0, y: 0, initialized: false },
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
      initView();
    }
    if (!runtime.map) {
      // Server should always send terrain first; defensive guard.
      return;
    }

    // Ownership arrives either as a full raster (first snapshot / high churn) or
    // as a delta against what we already hold. A full raster repaints the whole
    // base; a delta repaints only the touched tiles.
    if (snapshot.ownerBase64 !== undefined) {
      runtime.owner = decodeOwnerArray(snapshot.ownerBase64, snapshot.width * snapshot.height);
      repaintBaseFull();
    } else if (snapshot.ownerDeltaBase64 !== undefined && runtime.owner) {
      applyOwnerDelta(snapshot.ownerDeltaBase64);
    }

    runtime.capturableTotal = snapshot.capturableCount;
    runtime.recentEvents = snapshot.recentEvents;

    const me = snapshot.players.find((p) => p.playerId === runtime.myPlayerId);
    runtime.pool = me?.troops ?? 0;
    runtime.myTiles = me?.tiles ?? 0;

    spawnBoats(snapshot.crossings ?? []);
    renderSidebar();
  };

  // ---- Rendering --------------------------------------------------------

  /** Ensure the offscreen base canvas + pixel buffer exist at the map's size. */
  const ensureBase = (): { base: HTMLCanvasElement; image: ImageData } | null => {
    const map = runtime.map;
    if (!map) return null;
    let base = runtime.base;
    if (!base || base.width !== map.width || base.height !== map.height) {
      base = document.createElement("canvas");
      base.width = map.width;
      base.height = map.height;
      runtime.base = base;
      const ctx = base.getContext("2d");
      runtime.baseImage = ctx ? ctx.createImageData(map.width, map.height) : null;
    }
    return runtime.baseImage ? { base, image: runtime.baseImage } : null;
  };

  /** Repaint the whole terrain + ownership layer (1 pixel per tile). */
  const repaintBaseFull = (): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    const target = ensureBase();
    if (!map || !owner || !target) return;
    paintRaster(map, owner, target.image.data);
    target.base.getContext("2d")?.putImageData(target.image, 0, 0);
  };

  /** Apply a packed owner delta to the owner array and repaint touched tiles. */
  const applyOwnerDelta = (deltaBase64: string): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    const target = ensureBase();
    if (!map || !owner || !target) return;

    const bytes = decodeBase64ToBytes(deltaBase64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const records = Math.floor(bytes.length / 6);
    for (let k = 0; k < records; k += 1) {
      const index = view.getUint32(k * 6, true);
      const newOwner = view.getUint16(k * 6 + 4, true);
      if (index < owner.length) {
        owner[index] = newOwner;
        paintTileInto(map, owner, index, target.image.data);
      }
    }
    target.base.getContext("2d")?.putImageData(target.image, 0, 0);
  };

  /** Centre and fit the camera so the whole map is visible on first load. */
  const initView = (): void => {
    const map = runtime.map;
    if (!map) return;
    const fit = Math.min(ui.mapCanvas.width / map.width, ui.mapCanvas.height / map.height);
    runtime.view.scale = fit;
    runtime.view.initialized = true;
    clampView();
  };

  /** Clamp zoom to [fit, MAX] and pan so the camera stays over the map. */
  const clampView = (): void => {
    const map = runtime.map;
    if (!map) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const fit = Math.min(cw / map.width, ch / map.height);
    runtime.view.scale = clamp(runtime.view.scale, fit, Math.max(fit, MAX_TILE_SCALE));
    const viewW = cw / runtime.view.scale;
    const viewH = ch / runtime.view.scale;
    runtime.view.x = map.width <= viewW ? (map.width - viewW) / 2 : clamp(runtime.view.x, 0, map.width - viewW);
    runtime.view.y = map.height <= viewH ? (map.height - viewH) / 2 : clamp(runtime.view.y, 0, map.height - viewH);
  };

  /** Map a tile coordinate to a canvas-pixel position under the current camera. */
  const worldToScreen = (tx: number, ty: number): { x: number; y: number } => ({
    x: (tx - runtime.view.x) * runtime.view.scale,
    y: (ty - runtime.view.y) * runtime.view.scale,
  });

  /** Composite the base map plus animated boats onto the visible canvas. */
  const renderFrame = (now: number): void => {
    const map = runtime.map;
    const base = runtime.base;
    const ctx = ui.mapContext;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const { scale, x, y } = runtime.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    if (map && base) {
      // Draw the base raster under the camera transform (nearest-neighbour), then
      // overlay boats in screen space so their markers keep a constant size.
      ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawBoats(now, ctx, scale);
    }
    requestAnimationFrame(renderFrame);
  };

  const drawBoats = (now: number, ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.boats.length === 0) return;
    const survivors: Boat[] = [];
    for (const boat of runtime.boats) {
      const t = (now - boat.start) / BOAT_DURATION_MS;
      if (t >= 1) continue; // animation finished
      survivors.push(boat);

      const from = worldToScreen(boat.fromX + 0.5, boat.fromY + 0.5);
      const to = worldToScreen(boat.toX + 0.5, boat.toY + 0.5);
      const cx = from.x + (to.x - from.x) * t;
      const cy = from.y + (to.y - from.y) * t;

      // Wake: a fading dashed line from the launch coast up to the boat.
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.strokeStyle = boat.color;
      ctx.lineWidth = Math.max(1, scale * 0.25);
      ctx.setLineDash([Math.max(2, scale * 0.5), Math.max(2, scale * 0.5)]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.restore();

      // Boat marker: a small filled dot in the player's colour with a halo so
      // it stays visible over both shallow and deep water.
      const radius = Math.max(2.5, scale * 0.45);
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
      `<em>Click to expand toward a tile (you can land across narrow seas and rivers). Drag to pan, scroll to zoom.</em>`;

    ui.eventsPanel.innerHTML = runtime.recentEvents
      .map((ev) => `<div class="event">${escapeHtml(ev)}</div>`)
      .join("");
  };

  // ---- Input -----------------------------------------------------------

  // Convert a pointer event to canvas-pixel coordinates (the canvas backing
  // store can be a different size than its CSS box).
  const toCanvasPixels = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const bounds = ui.mapCanvas.getBoundingClientRect();
    const sx = ui.mapCanvas.width / bounds.width;
    const sy = ui.mapCanvas.height / bounds.height;
    return { x: (event.clientX - bounds.left) * sx, y: (event.clientY - bounds.top) * sy };
  };

  // Drag-to-pan, with a small movement threshold separating a pan from a click
  // so a stationary press still registers as an expand command.
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;

  ui.mapCanvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    moved = false;
    lastX = downX = event.clientX;
    lastY = downY = event.clientY;
    ui.mapCanvas.setPointerCapture(event.pointerId);
  });

  ui.mapCanvas.addEventListener("pointermove", (event) => {
    if (!dragging || !runtime.map) return;
    if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) moved = true;
    const bounds = ui.mapCanvas.getBoundingClientRect();
    const sx = ui.mapCanvas.width / bounds.width;
    const sy = ui.mapCanvas.height / bounds.height;
    runtime.view.x -= ((event.clientX - lastX) * sx) / runtime.view.scale;
    runtime.view.y -= ((event.clientY - lastY) * sy) / runtime.view.scale;
    lastX = event.clientX;
    lastY = event.clientY;
    clampView();
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (moved || !runtime.map || runtime.matchEnded) return;

    // A stationary press is an expand command toward the clicked tile.
    const { x, y } = toCanvasPixels(event);
    const tileX = Math.floor(runtime.view.x + x / runtime.view.scale);
    const tileY = Math.floor(runtime.view.y + y / runtime.view.scale);
    if (tileX < 0 || tileY < 0 || tileX >= runtime.map.width || tileY >= runtime.map.height) return;

    const percent = Number(ui.attackPercentInput.value);
    sendExpand(tileX, tileY, percent);
    setStatus(ui, `Expanding toward (${tileX}, ${tileY}) with ${percent}% of pool.`);
  };

  ui.mapCanvas.addEventListener("pointerup", endDrag);
  ui.mapCanvas.addEventListener("pointercancel", () => {
    dragging = false;
  });

  // Wheel zoom, anchored on the tile under the cursor so it stays put.
  ui.mapCanvas.addEventListener(
    "wheel",
    (event) => {
      if (!runtime.map) return;
      event.preventDefault();
      const { x, y } = toCanvasPixels(event);
      const tileX = runtime.view.x + x / runtime.view.scale;
      const tileY = runtime.view.y + y / runtime.view.scale;
      runtime.view.scale *= event.deltaY < 0 ? 1.2 : 1 / 1.2;
      clampView();
      runtime.view.x = tileX - x / runtime.view.scale;
      runtime.view.y = tileY - y / runtime.view.scale;
      clampView();
    },
    { passive: false },
  );

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
