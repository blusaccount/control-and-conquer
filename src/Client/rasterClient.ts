import { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterBuilding,
  RasterClientMessage,
  RasterCrossing,
  RasterMatchEndedPayload,
  RasterMatchPhase,
  RasterPlayerAssignedPayload,
  RasterPlayerInfo,
  RasterServerMessage,
  RasterShip,
  RasterSnapshot,
} from "../Core/types.js";
import { hideMenu, setStatus, type UiElements } from "./dom.js";
import { paintRaster, paintTileInto } from "./rasterPaint.js";
import { playerColor, playerEmoji } from "./rasterPalette.js";
import { loadRunHistory, recordRun, type RunRecord, type StorageLike } from "./runHistory.js";
import { computeNameAnchors, type NameAnchor } from "./nameLayout.js";
import { MAX_POOL_PER_TILE } from "../Core/rasterCombatConfig.js";
import {
  BUILDING_DEFS,
  BUILDING_TYPES,
  buildingCost,
  type BuildingType,
} from "../Core/buildings.js";
import type { RasterDifficulty } from "../Core/messages.js";

/** Options for starting a raster match: the chosen map and difficulty. */
export interface RasterClientOptions {
  /** Selected map-choice id (see `mapCatalog`). */
  mapId: string;
  /** Selected difficulty (size + aggression of the AI field). */
  difficulty: RasterDifficulty;
}

/**
 * Self-contained raster-mode client.
 *
 * Owns its own WebSocket, a persistent base-map canvas (repainted only when a
 * snapshot arrives) and a requestAnimationFrame overlay loop that glides each
 * transport ship the server reports along its shortest water route and flashes a
 * landing where a ship reaches shore.
 */

/**
 * A transport ship being drawn. The server streams the ship's authoritative tile
 * position every snapshot (`tx`,`ty`); the render loop eases the drawn position
 * (`rx`,`ry`) toward it each frame so the vessel glides smoothly between ticks.
 */
interface ShipDot {
  rx: number;
  ry: number;
  tx: number;
  ty: number;
  color: string;
  /** Whether `rx`/`ry` have been seeded yet (false until the first snapshot). */
  placed: boolean;
  /** Snapshot generation this ship was last seen in, for cleanup. */
  seen: number;
}

/** A short-lived flash where a transport ship disembarked and took its beachhead. */
interface Landing {
  x: number;
  y: number;
  color: string;
  /** performance.now() timestamp when the landing started animating. */
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
  myShips: number;
  /** Our troop-pool growth per second, for the top resource bar. */
  troopsPerSecond: number;
  /** Our current gold pool and its per-second growth. */
  gold: number;
  goldPerSecond: number;
  /** Our current building tallies, for the build-menu cost ramp. */
  myCities: number;
  myPorts: number;
  myForts: number;
  /** The structure type the player is placing, or null when not in build mode. */
  buildMode: BuildingType | null;
  /** Structures on the map this snapshot, drawn as icon markers. */
  buildings: RasterBuilding[];
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
  /** Transport ships currently being drawn, keyed by server ship id. */
  ships: Map<number, ShipDot>;
  /** Monotonic counter bumped per snapshot to expire ships that have landed. */
  shipGeneration: number;
  /** In-flight landing flashes. */
  landings: Landing[];
  /** Living players' capitals, drawn as a marker over the base map. */
  capitals: Capital[];
  /** Nation-name labels, centred in each player's territory mass. */
  nameAnchors: NameAnchor[];
  /** performance.now() of the last name-anchor recompute (throttled). */
  lastNameComputeMs: number;
  /** Whether we've picked a start position yet (false until we found a nation). */
  spawned: boolean;
  /** Current match phase, mirrored from the latest snapshot. */
  phase: RasterMatchPhase;
  /** Whole seconds left in the start phase (0 once the game phase is live). */
  spawnRemainingSeconds: number;
}

/** A player capital ("Hauptstadt") drawn as a cross marker on the map. */
interface Capital {
  tileX: number;
  tileY: number;
  color: string;
}

/** How long a landing flash lasts, in milliseconds. */
const LANDING_DURATION_MS = 700;

/** Per-frame easing fraction the drawn ship position moves toward its target. */
const SHIP_EASE = 0.25;

/** Hard zoom-in ceiling, in screen pixels per tile. */
const MAX_TILE_SCALE = 16;

/**
 * Empty margin kept around the map, expressed as a fraction of the larger map
 * dimension, with absolute bounds in tiles. The camera treats this border as
 * navigable space so that small islands flush against the map edge can still be
 * centred, zoomed and clicked comfortably instead of being pinned to the very
 * edge of the canvas. It also guarantees a little slack to drag at fit-zoom.
 */
const MAP_PADDING_FRACTION = 0.06;
const MIN_MAP_PADDING = 8;
const MAX_MAP_PADDING = 80;

/** The navigable border around a map, in tiles (see `MAP_PADDING_FRACTION`). */
const mapPadding = (width: number, height: number): number =>
  clamp(Math.round(Math.max(width, height) * MAP_PADDING_FRACTION), MIN_MAP_PADDING, MAX_MAP_PADDING);

/**
 * How often the nation-name anchors are recomputed, in ms. Label positions
 * drift slowly as territory shifts, so twice a second is plenty and keeps the
 * (full-raster) recompute off the per-frame path.
 */
const NAME_RECOMPUTE_MS = 500;

/** Below this on-screen font size (px) a nation name is too small to draw. */
const MIN_NAME_FONT_PX = 9;

/** Roughly how many tiles span the view after auto-zooming to a fresh spawn. */
const SPAWN_ZOOM_TILES = 70;

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
export const startRasterClient = (ui: UiElements, options: RasterClientOptions): void => {
  hideMenu(ui);
  ui.attackPercentOutput.textContent = `${ui.attackPercentInput.value}%`;
  ui.selectionInfo.textContent =
    "Start phase: click anywhere on land to choose where your nation begins.";

  const runtime: RasterRuntime = {
    map: null,
    owner: null,
    myPlayerId: null,
    myName: "",
    myColor: "#888",
    pool: 0,
    myTiles: 0,
    myShips: 0,
    troopsPerSecond: 0,
    gold: 0,
    goldPerSecond: 0,
    myCities: 0,
    myPorts: 0,
    myForts: 0,
    buildMode: null,
    buildings: [],
    capturableTotal: 0,
    players: [],
    recentEvents: [],
    matchEnded: false,
    winnerPlayerId: null,
    base: null,
    baseImage: null,
    view: { scale: 1, x: 0, y: 0, initialized: false },
    ships: new Map(),
    shipGeneration: 0,
    landings: [],
    capitals: [],
    nameAnchors: [],
    lastNameComputeMs: Number.NEGATIVE_INFINITY,
    spawned: false,
    phase: "spawn",
    spawnRemainingSeconds: 0,
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

  const sendSelectSpawn = (x: number, y: number): void => {
    const message: RasterClientMessage = { type: "CLIENT_RASTER_SELECT_SPAWN", payload: { x, y } };
    socket.send(JSON.stringify(message));
  };

  const sendBuild = (targetX: number, targetY: number, building: BuildingType): void => {
    const message: RasterClientMessage = {
      type: "CLIENT_RASTER_BUILD",
      payload: { targetX, targetY, building },
    };
    socket.send(JSON.stringify(message));
  };

  /** How many of `type` we currently own — feeds the geometric cost ramp. */
  const myBuildingCount = (type: BuildingType): number =>
    type === "city" ? runtime.myCities : type === "port" ? runtime.myPorts : runtime.myForts;

  /**
   * Build the (static) build-menu buttons once and wire each to toggle build
   * mode for its type. Costs/affordability are refreshed per snapshot by
   * {@link refreshBuildMenu}; this only lays out the buttons + handlers.
   */
  const renderBuildMenuOnce = (): void => {
    if (ui.buildMenu.children.length > 0) return;
    ui.buildMenu.innerHTML = BUILDING_TYPES.map((type) => {
      const def = BUILDING_DEFS[type];
      return (
        `<button class="build-btn" type="button" data-building="${type}">` +
        `<span class="icon">${def.icon}</span>` +
        `<span class="label">${escapeHtml(def.name)}<span class="sub">${escapeHtml(def.description)}</span></span>` +
        `<span class="cost" data-cost></span>` +
        `</button>`
      );
    }).join("");
    for (const btn of ui.buildMenu.querySelectorAll<HTMLButtonElement>("[data-building]")) {
      btn.addEventListener("click", () => {
        const type = btn.getAttribute("data-building") as BuildingType;
        runtime.buildMode = runtime.buildMode === type ? null : type;
        refreshBuildMenu();
        renderSidebar();
        if (runtime.buildMode) {
          setStatus(ui, `Build mode: click a tile you own to place a ${BUILDING_DEFS[type].name}.`);
        } else {
          setStatus(ui, "Build cancelled.");
        }
      });
    }
  };

  /** Refresh each build button's cost, affordability and selected state. */
  const refreshBuildMenu = (): void => {
    const canBuild = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded;
    for (const btn of ui.buildMenu.querySelectorAll<HTMLButtonElement>("[data-building]")) {
      const type = btn.getAttribute("data-building") as BuildingType;
      const cost = buildingCost(type, myBuildingCount(type));
      const affordable = runtime.gold >= cost;
      btn.classList.toggle("selected", runtime.buildMode === type);
      btn.disabled = !canBuild;
      const costEl = btn.querySelector<HTMLSpanElement>("[data-cost]");
      if (costEl) {
        costEl.textContent = `${formatCount(cost)}g`;
        costEl.classList.toggle("unaffordable", !affordable);
      }
    }
  };

  // Seat ourselves on the chosen map as soon as the socket is open.
  socket.addEventListener("open", () => {
    const join: RasterClientMessage = {
      type: "CLIENT_RASTER_JOIN",
      payload: { mapId: options.mapId, difficulty: options.difficulty },
    };
    socket.send(JSON.stringify(join));
  });
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
      onMatchEnded(message.payload);
    }
  };

  const onMatchEnded = (payload: RasterMatchEndedPayload): void => {
    runtime.matchEnded = true;
    runtime.winnerPlayerId = payload.winnerPlayerId;
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

  // Reconcile the drawn ship set with the server's authoritative list: update or
  // create a dot per reported ship, then drop any that vanished (they landed).
  const updateShips = (ships: RasterShip[]): void => {
    const generation = (runtime.shipGeneration += 1);
    for (const s of ships) {
      const tx = s.x + 0.5;
      const ty = s.y + 0.5;
      const existing = runtime.ships.get(s.shipId);
      if (existing) {
        existing.tx = tx;
        existing.ty = ty;
        existing.seen = generation;
      } else {
        runtime.ships.set(s.shipId, {
          rx: tx,
          ry: ty,
          tx,
          ty,
          color: rgbaToCss(playerColor(s.playerId)),
          placed: true,
          seen: generation,
        });
      }
    }
    for (const [id, dot] of runtime.ships) {
      if (dot.seen !== generation) runtime.ships.delete(id);
    }
  };

  const spawnLandings = (crossings: RasterCrossing[]): void => {
    if (crossings.length === 0) return;
    const now = performance.now();
    for (const c of crossings) {
      runtime.landings.push({
        x: c.toX,
        y: c.toY,
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
    runtime.phase = snapshot.phase;
    runtime.spawnRemainingSeconds = snapshot.spawnRemainingSeconds;
    updateStartBanner();

    const me = snapshot.players.find((p) => p.playerId === runtime.myPlayerId);
    runtime.pool = me?.troops ?? 0;
    runtime.myTiles = me?.tiles ?? 0;
    runtime.troopsPerSecond = me?.troopsPerSecond ?? 0;
    runtime.gold = me?.gold ?? 0;
    runtime.goldPerSecond = me?.goldPerSecond ?? 0;
    runtime.myCities = me?.cities ?? 0;
    runtime.myPorts = me?.ports ?? 0;
    runtime.myForts = me?.forts ?? 0;
    runtime.buildings = snapshot.buildings ?? [];

    // The first snapshot in which we hold land marks the end of the spawn phase:
    // zoom the camera in on our new capital so the run starts focused on home.
    if (!runtime.spawned && me && me.tiles > 0 && me.capitalX >= 0) {
      runtime.spawned = true;
      centerOnTile(me.capitalX, me.capitalY, SPAWN_ZOOM_TILES);
      setStatus(ui, `Founded at (${me.capitalX}, ${me.capitalY}).`);
    }

    // Capital markers: living players only, with a known capital tile.
    runtime.capitals = snapshot.players
      .filter((p) => !p.eliminated && p.capitalX >= 0 && p.capitalY >= 0)
      .map((p) => ({ tileX: p.capitalX, tileY: p.capitalY, color: p.color }));

    const ships = snapshot.ships ?? [];
    runtime.myShips = ships.reduce((n, s) => (s.playerId === runtime.myPlayerId ? n + 1 : n), 0);
    updateShips(ships);
    spawnLandings(snapshot.crossings ?? []);
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
    paintRaster(map, owner, target.image.data, undefined, runtime.myPlayerId ?? -1);
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
    // First apply every ownership change, then repaint: a tile's border status
    // depends on its neighbours, so changing one tile can flip the look of the
    // tiles around it. We collect each changed tile and its neighbours and
    // repaint that union once all owners are up to date.
    const dirty = new Set<number>();
    for (let k = 0; k < records; k += 1) {
      const index = view.getUint32(k * 6, true);
      const newOwner = view.getUint16(k * 6 + 4, true);
      if (index < owner.length) {
        owner[index] = newOwner;
        dirty.add(index);
        for (const n of map.neighbors(index)) dirty.add(n);
      }
    }
    const highlight = runtime.myPlayerId ?? -1;
    for (const ref of dirty) paintTileInto(map, owner, ref, target.image.data, undefined, highlight);
    target.base.getContext("2d")?.putImageData(target.image, 0, 0);
  };

  /**
   * Size the canvas backing store to its rendered CSS box (scaled by the device
   * pixel ratio for crisp output), then re-fit/clamp the camera. Called once at
   * startup and on every window resize so the map always fills the play area
   * instead of being squashed into a fixed-size canvas.
   */
  const resizeCanvas = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const rect = ui.mapCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (ui.mapCanvas.width !== w || ui.mapCanvas.height !== h) {
      ui.mapCanvas.width = w;
      ui.mapCanvas.height = h;
    }
    if (!runtime.map) return;
    if (runtime.view.initialized) clampView();
    else initView();
  };

  /** Centre and fit the camera so the whole map is visible on first load. */
  const initView = (): void => {
    const map = runtime.map;
    if (!map) return;
    const pad = mapPadding(map.width, map.height);
    const fit = Math.min(ui.mapCanvas.width / (map.width + 2 * pad), ui.mapCanvas.height / (map.height + 2 * pad));
    runtime.view.scale = fit;
    runtime.view.initialized = true;
    clampView();
  };

  /**
   * Clamp zoom to [fit, MAX] and pan so the camera stays over the map plus its
   * navigable border. The padding (see `mapPadding`) is included in the fit so
   * the map never touches the canvas edge, and panning may run from `-pad` to
   * `width + pad - viewW`, letting edge tiles be brought to centre.
   */
  const clampView = (): void => {
    const map = runtime.map;
    if (!map) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const pad = mapPadding(map.width, map.height);
    const paddedW = map.width + 2 * pad;
    const paddedH = map.height + 2 * pad;
    const fit = Math.min(cw / paddedW, ch / paddedH);
    runtime.view.scale = clamp(runtime.view.scale, fit, Math.max(fit, MAX_TILE_SCALE));
    const viewW = cw / runtime.view.scale;
    const viewH = ch / runtime.view.scale;
    runtime.view.x = paddedW <= viewW ? (map.width - viewW) / 2 : clamp(runtime.view.x, -pad, map.width + pad - viewW);
    runtime.view.y = paddedH <= viewH ? (map.height - viewH) / 2 : clamp(runtime.view.y, -pad, map.height + pad - viewH);
  };

  /**
   * Zoom in on a tile so roughly `tilesAcross` tiles span the smaller canvas
   * dimension, and centre the camera on it. Used to focus the view on a freshly
   * picked spawn. Zoom is clamped to the camera's legal range.
   */
  const centerOnTile = (tileX: number, tileY: number, tilesAcross: number): void => {
    const map = runtime.map;
    if (!map) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    runtime.view.scale = Math.min(cw, ch) / Math.max(8, tilesAcross);
    const viewW = cw / runtime.view.scale;
    const viewH = ch / runtime.view.scale;
    runtime.view.x = tileX + 0.5 - viewW / 2;
    runtime.view.y = tileY + 0.5 - viewH / 2;
    clampView();
  };

  /** Map a tile coordinate to a canvas-pixel position under the current camera. */
  const worldToScreen = (tx: number, ty: number): { x: number; y: number } => ({
    x: (tx - runtime.view.x) * runtime.view.scale,
    y: (ty - runtime.view.y) * runtime.view.scale,
  });

  /** Composite the base map plus transport ships and landings onto the canvas. */
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
      // overlay ships in screen space so their markers keep a constant size.
      ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      recomputeNames(now);
      drawNames(ctx, scale);
      drawBuildings(ctx, scale);
      drawCapitals(ctx, scale);
      drawShips(ctx, scale);
      drawLandings(now, ctx, scale);
    }
    drawMinimap();
    requestAnimationFrame(renderFrame);
  };

  /**
   * Recompute each nation's name anchor (throttled). Operates on the live owner
   * raster for every player still holding land, so labels track territory as it
   * changes hands without paying the cost every frame.
   */
  const recomputeNames = (now: number): void => {
    if (now - runtime.lastNameComputeMs < NAME_RECOMPUTE_MS) return;
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner) return;
    runtime.lastNameComputeMs = now;

    const players = runtime.players
      .filter((p) => !p.eliminated && p.tiles > 0)
      .map((p) => ({ playerId: p.playerId, nameLength: p.name.length }));
    runtime.nameAnchors = computeNameAnchors(map.width, map.height, owner, players);
  };

  /**
   * Draw each nation's name centred in its territory mass. The font is sized in
   * tile units (so the name grows with the land held, OpenFront-style) and drawn
   * in screen space with a dark outline for legibility over any terrain colour.
   * Names that would render too small at the current zoom are skipped.
   */
  const drawNames = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.nameAnchors.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;

    // The crown marks the nation with the highest population limit (max troops);
    // since the cap scales with territory, that's the player holding the most
    // tiles. Mirrors OpenFront's crown marker.
    let leaderId = -1;
    let leaderTiles = -1;
    for (const p of runtime.players) {
      if (!p.eliminated && p.tiles > leaderTiles) {
        leaderTiles = p.tiles;
        leaderId = p.playerId;
      }
    }

    const label = (text: string, sx: number, cy: number, px: number, weight: string): void => {
      ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, px * 0.14);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.strokeText(text, sx, cy);
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fillText(text, sx, cy);
    };

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const anchor of runtime.nameAnchors) {
      const fontPx = anchor.size * scale;
      if (fontPx < MIN_NAME_FONT_PX) continue;
      const player = runtime.players.find((p) => p.playerId === anchor.playerId);
      if (!player) continue;
      const { x: sx, y: sy } = worldToScreen(anchor.x + 0.5, anchor.y + 0.5);
      // Cheap viewport cull (names can be large, so pad generously).
      if (sx < -cw || sy < -ch || sx > cw * 2 || sy > ch * 2) continue;

      // Once the label is big enough, stack the troop count beneath the name and
      // (for the leader) a crown above it — the OpenFront map readout.
      const showDetail = fontPx >= 14;
      const nameY = showDetail ? sy - fontPx * 0.26 : sy;
      label(`${playerEmoji(player.playerId)} ${player.name}`, sx, nameY, fontPx, "600");
      if (showDetail) {
        label(formatCount(player.troops), sx, sy + fontPx * 0.52, fontPx * 0.62, "500");
        if (player.playerId === leaderId) {
          const crownPx = Math.max(13, fontPx * 0.7);
          ctx.font = `${crownPx}px serif`;
          ctx.fillText("\u{1F451}", sx, nameY - fontPx * 0.66); // 👑
        }
      }
    }
    ctx.restore();
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
    const pad = mapPadding(map.width, map.height);
    const paddedW = map.width + 2 * pad;
    const paddedH = map.height + 2 * pad;
    const scale = Math.min(mw / paddedW, mh / paddedH);
    // offX/offY are the minimap-pixel position of tile (0,0); the padded border
    // is letterboxed around it so the viewport rectangle stays inside the frame.
    const offX = (mw - paddedW * scale) / 2 + pad * scale;
    const offY = (mh - paddedH * scale) / 2 + pad * scale;
    return { scale, offX, offY };
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
   * Draw each structure as its building icon (emoji) over the tile it stands on,
   * in screen space so it stays a constant size. The icon only appears once a
   * tile is large enough on screen to read; below that the map stays clean.
   */
  const drawBuildings = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.buildings.length === 0) return;
    const px = scale * 0.95;
    if (px < 7) return; // Too small to read — skip to keep zoomed-out maps tidy.
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${px}px serif`;
    for (const b of runtime.buildings) {
      const { x: sx, y: sy } = worldToScreen(b.x + 0.5, b.y + 0.5);
      if (sx < -px || sy < -px || sx > cw + px || sy > ch + px) continue;
      ctx.lineWidth = Math.max(2, px * 0.16);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.strokeText(BUILDING_DEFS[b.type].icon, sx, sy);
      ctx.fillText(BUILDING_DEFS[b.type].icon, sx, sy);
    }
    ctx.restore();
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

  // Ease each ship's drawn position toward its latest server position, then draw
  // it as a haloed dot. Smoothing between snapshots is what makes a ship appear
  // to glide continuously along the shortest water route it was assigned.
  const drawShips = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.ships.size === 0) return;
    const radius = Math.max(2.5, scale * 0.45);
    for (const ship of runtime.ships.values()) {
      ship.rx += (ship.tx - ship.rx) * SHIP_EASE;
      ship.ry += (ship.ty - ship.ry) * SHIP_EASE;
      const p = worldToScreen(ship.rx, ship.ry);

      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = ship.color;
      ctx.fill();
      ctx.restore();
    }
  };

  // Draw an expanding, fading ring at each landing point for a brief moment.
  const drawLandings = (now: number, ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.landings.length === 0) return;
    const survivors: Landing[] = [];
    for (const landing of runtime.landings) {
      const t = (now - landing.start) / LANDING_DURATION_MS;
      if (t >= 1) continue;
      survivors.push(landing);

      const c = worldToScreen(landing.x + 0.5, landing.y + 0.5);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = landing.color;
      ctx.lineWidth = Math.max(1.5, scale * 0.3);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(3, scale * (0.4 + t * 0.9)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    runtime.landings = survivors;
  };

  /**
   * Refresh the top resource bar (OpenFront-style), the build menu and the
   * contextual build hint. The resource bar reads out troops, gold and held
   * territory with their growth rates, plus the player's building tallies.
   */
  const renderEconomy = (): void => {
    // Only "live" once the start phase is over and we hold land — until then the
    // resource bar shows a status hint rather than economy figures.
    const live = runtime.spawned && runtime.phase === "playing";
    if (!live) {
      const hint = !runtime.spawned
        ? "Pick a starting tile to begin"
        : `Battle begins in ${runtime.spawnRemainingSeconds}s`;
      ui.goldInfo.innerHTML = `<span class="res res-muted">${escapeHtml(hint)}</span>`;
    } else {
      const maxPool = runtime.myTiles * MAX_POOL_PER_TILE;
      const pct = runtime.capturableTotal > 0 ? (runtime.myTiles / runtime.capturableTotal) * 100 : 0;
      const pctStr = pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1);
      ui.goldInfo.innerHTML =
        `<span class="res"><span class="res-ico">👥</span>` +
        `<span class="res-val">${formatCount(runtime.pool)}/${formatCount(maxPool)}</span>` +
        `<span class="res-rate">+${formatRate(runtime.troopsPerSecond)}/s</span></span>` +
        `<span class="res"><span class="res-ico">🪙</span>` +
        `<span class="res-val">${formatCount(runtime.gold)}</span>` +
        `<span class="res-rate">+${formatRate(runtime.goldPerSecond)}/s</span></span>` +
        `<span class="res"><span class="res-ico">🗺️</span>` +
        `<span class="res-val">${pctStr}%</span></span>` +
        `<span class="res res-builds">🏛️ ${runtime.myCities} ⚓ ${runtime.myPorts} 🛡️ ${runtime.myForts}</span>`;
    }
    refreshBuildMenu();
    if (!live) {
      ui.buildHint.textContent = "";
    } else if (runtime.buildMode) {
      const def = BUILDING_DEFS[runtime.buildMode];
      ui.buildHint.innerHTML =
        `<strong>Placing ${escapeHtml(def.name)}.</strong> Click a tile you own. ` +
        `<em>Click the button again to cancel.</em>`;
    } else {
      ui.buildHint.textContent = "Select a structure above, then click your land to build it.";
    }
  };

  /**
   * Show or hide the big start-phase countdown banner over the map. Visible only
   * during the `spawn` phase; its copy changes once the player has founded their
   * nation and is just waiting for the game to begin.
   */
  const updateStartBanner = (): void => {
    if (runtime.phase !== "spawn") {
      ui.startBanner.classList.add("hidden");
      return;
    }
    const secs = runtime.spawnRemainingSeconds;
    const title = runtime.spawned ? "Get ready — the battle begins" : "Start phase — choose your spawn";
    const sub = runtime.spawned
      ? "Your nation is founded. Territory opens when the timer hits zero."
      : "Click anywhere on open land to found your nation.";
    ui.startBanner.innerHTML =
      `<span class="start-banner-title">${escapeHtml(title)}</span>` +
      `<span class="start-banner-timer">${secs}s</span>` +
      `<span class="start-banner-sub">${escapeHtml(sub)}</span>`;
    ui.startBanner.classList.remove("hidden");
  };

  const renderSidebar = (): void => {
    renderEconomy();
    // Pre-game: either still choosing a spawn, or founded but waiting out the
    // start-phase countdown. Either way territory can't be taken yet.
    if (!runtime.spawned || runtime.phase === "spawn") {
      const secs = runtime.spawnRemainingSeconds;
      ui.selectionInfo.innerHTML = !runtime.spawned
        ? `<strong>Choose your start position${runtime.phase === "spawn" ? ` — ${secs}s` : ""}.</strong><br/>` +
          `<em>Click anywhere on open land to found your nation. Drag to pan, scroll to zoom.</em>`
        : `<strong>Nation founded — the battle begins in ${secs}s.</strong><br/>` +
          `<em>Hold tight: you can't take territory until the start phase ends. Drag to pan, scroll to zoom.</em>`;
      ui.eventsPanel.innerHTML = runtime.recentEvents
        .map((ev) => `<div class="event">${escapeHtml(ev)}</div>`)
        .join("");
      renderLeaderboard();
      return;
    }

    ui.selectionInfo.innerHTML =
      `<strong>Orders</strong><br/>` +
      `<strong>Ships at sea:</strong> ${runtime.myShips} / 3<br/>` +
      `<em>Click adjacent land to expand. Click any landmass across water to send a transport ship ` +
      `to its nearest reachable shore (one per click, max 3 at sea). Drag to pan, scroll to zoom.</em>`;

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
        const name = `${playerEmoji(p.playerId)} ${escapeHtml(p.name)}` + (isMe ? " (you)" : "");
        const maxPool = p.tiles * MAX_POOL_PER_TILE;
        const own = runtime.capturableTotal > 0 ? (p.tiles / runtime.capturableTotal) * 100 : 0;
        const ownStr = own >= 10 ? String(Math.round(own)) : own.toFixed(1);
        const stats =
          `${ownStr}% · ${formatCount(p.troops)}/${formatCount(maxPool)} (+${formatRate(p.troopsPerSecond)}/s)` +
          ` · ${formatCount(p.gold)}g`;
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

    const { x, y } = toCanvasPixels(event);
    const tileX = Math.floor(runtime.view.x + x / runtime.view.scale);
    const tileY = Math.floor(runtime.view.y + y / runtime.view.scale);
    if (tileX < 0 || tileY < 0 || tileX >= runtime.map.width || tileY >= runtime.map.height) return;

    // During the start phase the only meaningful click is choosing a start
    // position; once founded the player waits out the countdown before acting.
    if (runtime.phase === "spawn") {
      if (!runtime.spawned) {
        sendSelectSpawn(tileX, tileY);
        setStatus(ui, `Founding at (${tileX}, ${tileY})…`);
      } else {
        setStatus(ui, `The battle hasn't begun yet — ${runtime.spawnRemainingSeconds}s left in the start phase.`);
      }
      return;
    }

    // Game phase. We're normally seated already (auto-seated if we never picked),
    // but in a session with no start phase the first click still founds us.
    if (!runtime.spawned) {
      sendSelectSpawn(tileX, tileY);
      setStatus(ui, `Founding at (${tileX}, ${tileY})…`);
      return;
    }

    // In build mode a click places the selected structure instead of expanding.
    if (runtime.buildMode) {
      const def = BUILDING_DEFS[runtime.buildMode];
      sendBuild(tileX, tileY, runtime.buildMode);
      setStatus(ui, `Building ${def.name} at (${tileX}, ${tileY})…`);
      return;
    }

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

  // Lay out the build menu once and seed its initial (disabled, pre-spawn) state.
  renderBuildMenuOnce();
  refreshBuildMenu();

  // Match the canvas backing store to its rendered size now and whenever the
  // window changes, so the map fills the available play area at all times.
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  requestAnimationFrame(renderFrame);
};

/**
 * Compact integer formatting for large counts (troops, tiles): 1234 → "1.2k",
 * 19595 → "20k", 1_250_000 → "1.3M". Keeps the sidebar and leaderboard legible
 * once empires reach tens of thousands of tiles/troops instead of showing raw
 * six-digit numbers.
 */
const formatCount = (n: number): string => {
  const v = Math.round(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};

/**
 * Format a troops-per-second rate compactly: large rates use the compact
 * notation (k/M); small early-game rates keep one decimal so they don't read as
 * "+0/s".
 */
const formatRate = (rate: number): string =>
  rate >= 1000 ? formatCount(rate) : rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);

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
