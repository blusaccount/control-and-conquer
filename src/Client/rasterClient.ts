import { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterClientMessage,
  RasterCrossing,
  RasterMatchEndedPayload,
  RasterPlayerAssignedPayload,
  RasterPlayerInfo,
  RasterServerMessage,
  RasterSnapshot,
} from "../Core/types.js";
import { hideMenu, setStatus, type UiElements } from "./dom.js";
import { paintRaster, paintTileInto } from "./rasterPaint.js";
import { playerColor } from "./rasterPalette.js";
import { loadRunHistory, recordRun, type RunRecord, type StorageLike } from "./runHistory.js";
import { PERK_DEFINITIONS, type PerkId } from "../Core/perks.js";
import type { PerkOfferPayload } from "../Core/messages.js";

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
  /** Full player standings from the latest snapshot, for the leaderboard. */
  players: RasterPlayerInfo[];
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
  /** Living players' capitals, drawn as a marker over the base map. */
  capitals: Capital[];
}

/** A player capital ("Hauptstadt") drawn as a cross marker on the map. */
interface Capital {
  tileX: number;
  tileY: number;
  color: string;
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
    players: [],
    recentEvents: [],
    matchEnded: false,
    winnerPlayerId: null,
    base: null,
    baseImage: null,
    view: { scale: 1, x: 0, y: 0, initialized: false },
    boats: [],
    capitals: [],
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

  const sendPerkChoice = (perkId: PerkId): void => {
    const message: RasterClientMessage = { type: "CLIENT_PERK_CHOSEN", payload: { perkId } };
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
    } else if (message.type === "SERVER_PERK_OFFER") {
      showPerkOffer(message.payload);
    } else if (message.type === "SERVER_RASTER_MATCH_ENDED") {
      onMatchEnded(message.payload);
    }
  };

  /** Present the perk choices as a blur-overlay of cards; one click commits. */
  const showPerkOffer = (offer: PerkOfferPayload): void => {
    if (runtime.matchEnded) return;
    ui.perkOverlay.innerHTML =
      `<h1>Choose a Perk</h1>` +
      `<p class="hint">Perk round ${offer.offerNumber}</p>` +
      `<div class="perk-cards">` +
      offer.options
        .map((id) => {
          const def = PERK_DEFINITIONS[id];
          return (
            `<button class="perk-card" type="button" data-perk="${escapeHtml(id)}">` +
            `<h3>${escapeHtml(def.name)}</h3><p>${escapeHtml(def.description)}</p>` +
            `</button>`
          );
        })
        .join("") +
      `</div>`;
    ui.perkOverlay.classList.remove("hidden");

    for (const card of ui.perkOverlay.querySelectorAll<HTMLButtonElement>(".perk-card")) {
      card.addEventListener("click", () => {
        const perk = card.getAttribute("data-perk");
        if (perk) sendPerkChoice(perk as PerkId);
        ui.perkOverlay.classList.add("hidden");
      });
    }
  };

  const onMatchEnded = (payload: RasterMatchEndedPayload): void => {
    runtime.matchEnded = true;
    runtime.winnerPlayerId = payload.winnerPlayerId;
    ui.perkOverlay.classList.add("hidden");
    setStatus(ui, payload.stats.won ? "You won the run!" : "Run over.", "victory");

    const storage = safeStorage();
    const record = recordRun(storage, payload, Date.now());
    showStatsScreen(payload, record, loadRunHistory(storage));
  };

  /**
   * Render the post-match stats screen: this run's verdict and key figures, a
   * Play-Again button, and a short tail of previous runs from local history.
   */
  const showStatsScreen = (
    payload: RasterMatchEndedPayload,
    record: RunRecord,
    history: RunRecord[],
  ): void => {
    const { stats, reason, durationTicks, tickRate } = payload;
    const verdictClass = stats.won ? "win" : "loss";
    const verdictText = stats.won ? "Victory!" : stats.eliminated ? "Eliminated" : "Defeated";
    const reasonText = reason === "conquest" ? "by conquest" : "on the clock";
    const matchSeconds = tickRate > 0 ? Math.round(durationTicks / tickRate) : 0;

    const recent = history
      .slice(-6)
      .reverse()
      .map((r) => {
        const result = r.won ? "Win" : "Loss";
        return (
          `<div class="row"><span>Run #${r.run} · ${result}</span>` +
          `<span>${r.peakTiles} tiles · ${r.kills} kills</span></div>`
        );
      })
      .join("");

    ui.statsOverlay.innerHTML =
      `<div class="stats-card">` +
      `<p class="verdict ${verdictClass}">${verdictText}</p>` +
      `<p class="run-label">Run #${record.run} · ${escapeHtml(reasonText)} · match ${formatDuration(matchSeconds)}</p>` +
      `<div class="stats-grid">` +
      `<span class="k">Peak territory</span><span class="v">${stats.peakTiles} tiles</span>` +
      `<span class="k">Final territory</span><span class="v">${stats.finalTiles} tiles</span>` +
      `<span class="k">Eliminations</span><span class="v">${stats.kills}</span>` +
      `<span class="k">Survival time</span><span class="v">${formatDuration(record.survivedSeconds)}</span>` +
      `</div>` +
      `<button id="statsPlayAgain" class="menu-button primary" type="button" style="width:100%;margin-top:16px;">Play Again</button>` +
      (recent ? `<div class="stats-history"><h3>Recent runs</h3>${recent}</div>` : "") +
      `</div>`;
    ui.statsOverlay.classList.remove("hidden");

    const again = ui.statsOverlay.querySelector<HTMLButtonElement>("#statsPlayAgain");
    again?.addEventListener("click", () => window.location.reload());
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
    runtime.players = snapshot.players;

    const me = snapshot.players.find((p) => p.playerId === runtime.myPlayerId);
    runtime.pool = me?.troops ?? 0;
    runtime.myTiles = me?.tiles ?? 0;

    // Capital markers: living players only, with a known capital tile.
    runtime.capitals = snapshot.players
      .filter((p) => !p.eliminated && p.capitalX >= 0 && p.capitalY >= 0)
      .map((p) => ({ tileX: p.capitalX, tileY: p.capitalY, color: p.color }));

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
      drawCapitals(ctx, scale);
      drawBoats(now, ctx, scale);
    }
    drawMinimap();
    requestAnimationFrame(renderFrame);
  };

  /**
   * The transform that fits the whole map into the minimap canvas while keeping
   * its aspect ratio (letterboxed). Shared by the minimap renderer and its
   * click-to-jump handler so both agree on where each tile lands. `null` until a
   * map exists.
   */
  const minimapTransform = (): { scale: number; offX: number; offY: number } | null => {
    const map = runtime.map;
    if (!map) return null;
    const mw = ui.minimapCanvas.width;
    const mh = ui.minimapCanvas.height;
    const scale = Math.min(mw / map.width, mh / map.height);
    return { scale, offX: (mw - map.width * scale) / 2, offY: (mh - map.height * scale) / 2 };
  };

  /**
   * Draw the whole map into the minimap by downscaling the offscreen base raster
   * (so it carries the identical terrain + ownership palette), then overlay a
   * green rectangle marking the main view's current viewport.
   */
  const drawMinimap = (): void => {
    const ctx = ui.minimapContext;
    const mw = ui.minimapCanvas.width;
    const mh = ui.minimapCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, mw, mh);

    const map = runtime.map;
    const base = runtime.base;
    const t = minimapTransform();
    if (!map || !base || !t) return;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0, map.width, map.height, t.offX, t.offY, map.width * t.scale, map.height * t.scale);

    // Viewport rectangle: the tile span currently shown on the main canvas.
    const viewW = ui.mapCanvas.width / runtime.view.scale;
    const viewH = ui.mapCanvas.height / runtime.view.scale;
    const rx = t.offX + runtime.view.x * t.scale;
    const ry = t.offY + runtime.view.y * t.scale;
    ctx.strokeStyle = "rgba(34, 197, 94, 0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, viewW * t.scale - 1), Math.max(1, viewH * t.scale - 1));
  };

  /**
   * Draw each living player's capital as a cross in their colour with a white
   * outline, in screen space so the marker stays legible at any zoom. The cross
   * scales gently with zoom but is clamped so it never vanishes when zoomed out
   * nor swamps the tile when zoomed in.
   */
  const drawCapitals = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.capitals.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    // Half-length of each arm and stroke widths, in screen pixels.
    const arm = clamp(scale * 0.9, 4, 9);
    const outlineWidth = clamp(scale * 0.5, 3, 6);
    const colorWidth = clamp(scale * 0.28, 1.5, 3.5);

    for (const capital of runtime.capitals) {
      const { x: cx, y: cy } = worldToScreen(capital.tileX + 0.5, capital.tileY + 0.5);
      // Skip markers fully outside the viewport (cheap cull).
      if (cx < -arm || cy < -arm || cx > cw + arm || cy > ch + arm) continue;

      const stroke = (width: number, style: string): void => {
        ctx.lineWidth = width;
        ctx.strokeStyle = style;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy);
        ctx.lineTo(cx + arm, cy);
        ctx.moveTo(cx, cy - arm);
        ctx.lineTo(cx, cy + arm);
        ctx.stroke();
      };

      ctx.save();
      stroke(outlineWidth, "rgba(255, 255, 255, 0.95)"); // white outline underneath
      stroke(colorWidth, capital.color); // player-colour cross on top
      ctx.restore();
    }
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

    renderLeaderboard();
  };

  /**
   * Live standings: every active (non-eliminated) player, sorted by tiles held
   * descending. Each row shows a colour dot, name, tile count and pool with its
   * growth rate. Your own row is highlighted, and turns green while you hold the
   * lead ("du gewinnst").
   */
  const renderLeaderboard = (): void => {
    const active = runtime.players
      .filter((p) => !p.eliminated)
      .sort((a, b) => b.tiles - a.tiles || a.playerId - b.playerId);

    if (active.length === 0) {
      ui.leaderboard.innerHTML = `<div class="lb-empty">No active players.</div>`;
      return;
    }

    const leaderId = active[0].playerId;
    ui.leaderboard.innerHTML = active
      .map((p) => {
        const isMe = p.playerId === runtime.myPlayerId;
        const isLeader = p.playerId === leaderId;
        const rowClass = ["lb-row", isMe ? "me" : "", isLeader ? "leader" : ""]
          .filter(Boolean)
          .join(" ");
        const name = escapeHtml(p.name) + (isMe ? " (you)" : "");
        const stats = `${p.tiles} · ${p.troops} (+${formatRate(p.troopsPerSecond)}/s)`;
        return (
          `<div class="${rowClass}">` +
          `<span class="lb-dot" style="background:${escapeHtml(p.color)}"></span>` +
          `<span class="lb-name">${name}</span>` +
          `<span class="lb-stats">${stats}</span>` +
          `</div>`
        );
      })
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

  // Click (or drag) the minimap to jump the main camera so the clicked point
  // becomes the centre of the viewport.
  const jumpToMinimap = (event: { clientX: number; clientY: number }): void => {
    const map = runtime.map;
    const t = minimapTransform();
    if (!map || !t) return;
    const bounds = ui.minimapCanvas.getBoundingClientRect();
    const px = ((event.clientX - bounds.left) * ui.minimapCanvas.width) / bounds.width;
    const py = ((event.clientY - bounds.top) * ui.minimapCanvas.height) / bounds.height;
    const tileX = (px - t.offX) / t.scale;
    const tileY = (py - t.offY) / t.scale;
    const viewW = ui.mapCanvas.width / runtime.view.scale;
    const viewH = ui.mapCanvas.height / runtime.view.scale;
    runtime.view.x = tileX - viewW / 2;
    runtime.view.y = tileY - viewH / 2;
    clampView();
  };

  let minimapDragging = false;
  ui.minimapCanvas.addEventListener("pointerdown", (event) => {
    minimapDragging = true;
    ui.minimapCanvas.setPointerCapture(event.pointerId);
    jumpToMinimap(event);
  });
  ui.minimapCanvas.addEventListener("pointermove", (event) => {
    if (minimapDragging) jumpToMinimap(event);
  });
  const endMinimapDrag = (): void => {
    minimapDragging = false;
  };
  ui.minimapCanvas.addEventListener("pointerup", endMinimapDrag);
  ui.minimapCanvas.addEventListener("pointercancel", endMinimapDrag);

  ui.attackPercentInput.addEventListener("input", () => {
    ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
  });

  requestAnimationFrame(renderFrame);
};

/**
 * Format a troops-per-second rate compactly: whole numbers once it's large
 * enough, otherwise one decimal so small early-game rates don't read as "+0/s".
 */
const formatRate = (rate: number): string => (rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1));

/** Format whole seconds as m:ss for the stats screen. */
const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/**
 * The browser's `localStorage`, or an in-memory stand-in when it is unavailable
 * (private mode, disabled storage). Keeps run-history writes from throwing.
 */
const safeStorage = (): StorageLike => {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw in locked-down browsers; fall through to the stub.
  }
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => {
      mem.set(key, value);
    },
  };
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
