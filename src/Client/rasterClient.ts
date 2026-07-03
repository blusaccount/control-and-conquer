import { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import type {
  RasterAllianceInfo,
  RasterAllianceRequest,
  RasterAttackFront,
  RasterBuilding,
  RasterClientMessage,
  RasterCrossing,
  RasterEmbargoPair,
  RasterEmojiReaction,
  RasterTargetRequestInfo,
  RasterExpandMode,
  RasterMatchEndedPayload,
  RasterMatchPhase,
  RasterNuke,
  RasterNukeDetonation,
  RasterNukeInterception,
  RasterPlayerAssignedPayload,
  RasterPlayerInfo,
  RasterRail,
  RasterServerMessage,
  RasterShip,
  RasterWarship,
  RasterSnapshot,
  RasterTrade,
  RasterTrain,
} from "../Core/types.js";
import { hideMenu, setStatus, type UiElements } from "./dom.js";
import { formatCount, formatDuration, formatRate } from "./format.js";
import { createWebSocketTransport, createWorkerTransport, type RasterTransport } from "./transport.js";
import { paintRaster, paintTileInto } from "./rasterPaint.js";
import { borderColor, playerColor, playerEmoji } from "./rasterPalette.js";
import { drawIcon, iconSvgMarkup } from "./icons.js";
import { loadRunHistory, recordRun, type RunRecord, type StorageLike } from "./runHistory.js";
import { computeNameAnchors, type NameAnchor } from "./nameLayout.js";
import {
  BUILDING_DEFS,
  BUILDING_TYPES,
  buildingCost,
  costCounterTypes,
  UPGRADABLE_BUILDING_TYPES,
  type BuildingType,
} from "../Core/buildings.js";
import { RASTER_EMOJIS, type RasterDifficulty } from "../Core/messages.js";
import { ALLIANCE_RENEWAL_WINDOW_TICKS } from "../Core/alliances.js";
import { WIN_TILE_FRACTION } from "../Core/rasterCombatConfig.js";
import { SIMULATION_TICK_RATE } from "../Server/simulationConfig.js";
import { sfx } from "./sound.js";
import { NUKE_DEFS, NUKE_KINDS, nukeBlast, nukeCost, type NukeKind } from "../Core/nukes.js";

/** Options for starting a raster match: the chosen map and difficulty. */
export interface RasterClientOptions {
  /** Selected map-choice id (see `mapCatalog`). */
  mapId: string;
  /** Selected difficulty (size + aggression of the AI field). */
  difficulty: RasterDifficulty;
  /**
   * How the match is hosted. `"worker"` (default) runs the whole solo sim in a
   * browser Web Worker with no network round-trip (OpenFront-style client-side
   * lockstep); `"websocket"` connects to the authoritative server instead.
   */
  transport?: "worker" | "websocket";
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

/**
 * A mobile warship being drawn — same eased-position idea as {@link ShipDot},
 * plus the current/max HP (for the health bar, drawn only while damaged) and
 * whether it's currently retreating home to heal (a distinct visual cue from
 * an "angry"/engaging one).
 */
interface WarshipDot {
  rx: number;
  ry: number;
  tx: number;
  ty: number;
  color: string;
  hp: number;
  maxHp: number;
  retreating: boolean;
  seen: number;
}

/**
 * A brief expanding ring drawn at the world-space tile the player just clicked
 * to order an expansion (or a spawn). Gives immediate visual confirmation that
 * the click registered before the server responds. Fades and grows outward like
 * a sonar ping in the player's hue.
 */
interface ClickRipple {
  /** Tile column of the click target. */
  x: number;
  /** Tile row of the click target. */
  y: number;
  /** CSS colour of the ring (player colour for expand, white for spawn). */
  color: string;
  /** performance.now() when the ripple started. */
  start: number;
}

/** A short-lived flash where a transport ship disembarked and took its beachhead. */
interface Landing {
  x: number;
  y: number;
  color: string;
  /** performance.now() timestamp when the landing started animating. */
  start: number;
}

/** A blooming-and-fading ring marking a warhead's blast, centred on impact. */
interface NukeExplosion {
  x: number;
  y: number;
  kind: NukeKind;
  /** performance.now() timestamp when the explosion started animating. */
  start: number;
}

/** A brief flash marking a warhead shot down by a SAM Launcher before impact. */
interface NukeIntercept {
  x: number;
  y: number;
  /** performance.now() timestamp when the interception started animating. */
  start: number;
}

/**
 * A short-lived glow over a tile that just changed hands, in the conqueror's
 * (brightened) colour. Painted as a fading wash over the base raster so an
 * advancing front reads as a bright wave sweeping across the land — OpenFront's
 * conquest ripple — rather than tiles silently snapping to a new colour.
 */
interface CaptureFlash {
  /** Tile index (a `TileRef`) the flash sits on. */
  ref: number;
  /** Pre-brightened CSS colour of the capturing player. */
  css: string;
  /** performance.now() timestamp when the flash started. */
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

/** Sortable leaderboard columns (OpenFront: Owned % | Gold | Max Troops, + name). */
type LeaderboardSortKey = "owned" | "gold" | "max" | "name";

interface RasterRuntime {
  map: GameMap | null;
  owner: Uint16Array | null;
  myPlayerId: PlayerId | null;
  myName: string;
  myColor: string;
  pool: number;
  myTiles: number;
  /** Our territory-scaled troop ceiling (server-computed), for the pool/max HUD. */
  myMaxTroops: number;
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
  myFactories: number;
  mySilos: number;
  myWarships: number;
  mySams: number;
  /** The structure type the player is placing, or null when not in build mode. */
  buildMode: BuildingType | null;
  /** Which warhead the player is targeting, or null when not in nuke mode. */
  nukeMode: NukeKind | null;
  /** Forced route for the next expand click (B/G hotkeys), reset to "auto" after use. */
  expandMode: RasterExpandMode;
  /** Player id who most recently attacked us (0 = nobody yet), for Shift+R "retaliate". */
  lastAttackedBy: number;
  /** True while the terrain-only "alt view" (Space) is active — hides the ownership tint. */
  showTerrainOnly: boolean;
  /** True while the coordinate grid overlay (M) is shown. */
  showCoordinateGrid: boolean;
  /** Offscreen 1px-per-tile render of terrain alone (no ownership), built lazily for the alt view. */
  terrainOnlyBase: HTMLCanvasElement | null;
  /** Tile under the cursor, for the build-mode ghost preview. Null off-canvas. */
  hoverTileX: number | null;
  hoverTileY: number | null;
  /** Structures on the map this snapshot, drawn as icon markers. */
  buildings: RasterBuilding[];
  /** Warheads in flight this snapshot, drawn as travelling icons. */
  nukes: RasterNuke[];
  /** Tile refs currently under radioactive fallout, drawn as a lingering tint. */
  fallout: Set<number>;
  /** Auto-routed railroads this snapshot, drawn as track polylines. */
  rails: RasterRail[];
  /** Trains riding the rails this snapshot, drawn as moving dots. */
  trains: RasterTrain[];
  /** Trade ships sailing between ports this snapshot, drawn as moving sea dots. */
  tradeShips: RasterTrade[];
  capturableTotal: number;
  /** Full player standings from the latest snapshot, for the leaderboard. */
  players: RasterPlayerInfo[];
  /** Which leaderboard column the standings are sorted by, and the direction. */
  leaderboardSort: { key: LeaderboardSortKey; dir: 1 | -1 };
  recentEvents: string[];
  matchEnded: boolean;
  /**
   * True when *this player* was eliminated mid-match. Actions are blocked but
   * the map keeps updating so they can spectate the rest of the game.
   */
  myEliminated: boolean;
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
  /** Mobile warships currently being drawn, keyed by server warship id. */
  warships: Map<number, WarshipDot>;
  /** Monotonic counter bumped per snapshot to expire warships that were sunk. */
  warshipGeneration: number;
  /** In-flight landing flashes. */
  landings: Landing[];
  /** In-flight nuke explosion rings. */
  nukeExplosions: NukeExplosion[];
  /** In-flight SAM-interception flashes. */
  nukeIntercepts: NukeIntercept[];
  /** Active attack fronts this snapshot, drawn as on-map troop-count labels. */
  fronts: RasterAttackFront[];
  /** Active alliances (pair + countdown + renewal votes), mirrored from the snapshot. */
  alliances: RasterAllianceInfo[];
  /** Pending alliance proposals (directed from→to), mirrored from the snapshot. */
  allianceRequests: RasterAllianceRequest[];
  /** Active trade embargoes (directed [from, to] pairs), mirrored from the snapshot. */
  embargoes: RasterEmbargoPair[];
  /** Standing target requests (from→ally, against target), mirrored from the snapshot. */
  targetRequests: RasterTargetRequestInfo[];
  /** Floating emoji reactions this snapshot, with client-side interpolated rise. */
  emojis: RasterEmojiReaction[];
  /** Recently-captured tiles still glowing, for the conquest-ripple animation. */
  captureFlashes: CaptureFlash[];
  /** Expanding rings confirming recent expand/spawn clicks. */
  clickRipples: ClickRipple[];
  /** Tile the local player picked to spawn on, for the start-of-run auto-zoom. */
  spawnX: number;
  spawnY: number;
  /** Nation-name labels, centred in each player's territory mass. */
  nameAnchors: NameAnchor[];
  /** performance.now() of the last name-anchor recompute (throttled). */
  lastNameComputeMs: number;
  /** Combined tile count across all players as of the last name-anchor recompute. */
  lastNameTileTotal: number;
  /** Whether we've picked a start position yet (false until we found a nation). */
  spawned: boolean;
  /** Current match phase, mirrored from the latest snapshot. */
  phase: RasterMatchPhase;
  /** Whole seconds left in the start phase (0 once the game phase is live). */
  spawnRemainingSeconds: number;
}

/** How long a click-ripple ring expands before vanishing, in milliseconds. */
const CLICK_RIPPLE_MS = 450;

/** How long a landing flash lasts, in milliseconds. */
const LANDING_DURATION_MS = 700;

/** How long a nuke's explosion ring takes to bloom and fade, in milliseconds. */
const NUKE_EXPLOSION_DURATION_MS = 900;

/** How long a freshly-captured tile glows before settling, in milliseconds. */
const CAPTURE_FLASH_MS = 520;

/** Peak opacity of the conquest-ripple glow (fades to 0 over its lifetime). */
const CAPTURE_FLASH_ALPHA = 0.65;

/**
 * Hard cap on glowing tiles tracked at once. A huge multi-front war can flip
 * thousands of tiles a tick; past this we keep the most recent and drop the
 * rest so the per-frame glow pass stays bounded.
 */
const MAX_CAPTURE_FLASHES = 4000;

/**
 * Zoom (screen pixels per tile) at or above which anti-aliased vector nation
 * borders are overlaid on top of the crisp pixel terrain. Below it the camera is
 * far enough out that individual tile borders are sub-pixel, so the (per-visible-
 * tile) overlay pass is skipped to stay cheap. This is purely a detail/perf gate
 * — the base map itself is always drawn nearest-neighbour (see `renderFrame`).
 */
const BORDER_DETAIL_SCALE = 2.5;

/**
 * Skip the crisp border overlay when more than this many tiles are on screen:
 * at that point the camera is far enough out that individual borders are sub-
 * pixel anyway, and scanning every visible tile per frame would cost too much.
 */
const BORDER_OVERLAY_TILE_BUDGET = 90000;

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

/** Decode a base64-packed little-endian `Uint32Array` of tile indices (fallout). */
const decodeTileList = (b64: string): number[] => {
  if (b64.length === 0) return [];
  const bytes = decodeBase64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.length / 4);
  const refs: number[] = new Array(count);
  for (let i = 0; i < count; i += 1) refs[i] = view.getUint32(i * 4, true);
  return refs;
};

const rgbaToCss = (c: { r: number; g: number; b: number }): string => `rgb(${c.r}, ${c.g}, ${c.b})`;

/**
 * A brightened CSS colour for a capturing player's conquest-ripple glow: their
 * nation colour pushed toward white so the freshly-taken tile flares before it
 * settles into the ownership wash. Memoised by player id since it is computed
 * once per captured tile on the snapshot path.
 */
const flashCssCache = new Map<PlayerId, string>();
const flashCss = (id: PlayerId): string => {
  let css = flashCssCache.get(id);
  if (css === undefined) {
    const c = playerColor(id);
    const lift = (ch: number): number => Math.round(ch + (255 - ch) * 0.55);
    css = `rgb(${lift(c.r)}, ${lift(c.g)}, ${lift(c.b)})`;
    flashCssCache.set(id, css);
  }
  return css;
};

/** Trace a rounded-rectangle path (for the on-map front labels' pill). */
const traceRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
};

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
    myMaxTroops: 0,
    myShips: 0,
    troopsPerSecond: 0,
    gold: 0,
    goldPerSecond: 0,
    myCities: 0,
    myPorts: 0,
    myForts: 0,
    myFactories: 0,
    mySilos: 0,
    myWarships: 0,
    mySams: 0,
    buildMode: null,
    nukeMode: null,
    expandMode: "auto",
    lastAttackedBy: 0,
    showTerrainOnly: false,
    showCoordinateGrid: false,
    terrainOnlyBase: null,
    hoverTileX: null,
    hoverTileY: null,
    buildings: [],
    nukes: [],
    fallout: new Set<number>(),
    rails: [],
    trains: [],
    tradeShips: [],
    leaderboardSort: { key: "owned", dir: -1 },
    capturableTotal: 0,
    players: [],
    recentEvents: [],
    matchEnded: false,
    myEliminated: false,
    winnerPlayerId: null,
    base: null,
    baseImage: null,
    view: { scale: 1, x: 0, y: 0, initialized: false },
    ships: new Map(),
    shipGeneration: 0,
    warships: new Map(),
    warshipGeneration: 0,
    landings: [],
    nukeExplosions: [],
    nukeIntercepts: [],
    fronts: [],
    alliances: [],
    allianceRequests: [],
    embargoes: [],
    targetRequests: [],
    emojis: [],
    captureFlashes: [],
    clickRipples: [],
    spawnX: -1,
    spawnY: -1,
    nameAnchors: [],
    lastNameComputeMs: Number.NEGATIVE_INFINITY,
    lastNameTileTotal: -1,
    spawned: false,
    phase: "spawn",
    spawnRemainingSeconds: 0,
  };

  const transport: RasterTransport =
    options.transport === "websocket" ? createWebSocketTransport() : createWorkerTransport();

  const sendExpand = (targetX: number, targetY: number, percent: number, mode: RasterExpandMode = "auto"): void => {
    const message: RasterClientMessage = {
      type: "CLIENT_RASTER_EXPAND",
      payload: { targetX, targetY, percent, ...(mode !== "auto" ? { mode } : {}) },
    };
    transport.send(message);
  };

  const sendSelectSpawn = (x: number, y: number): void => {
    // Remember where we asked to spawn so the start-of-run auto-zoom can centre
    // on it (there is no capital tile to read back from the snapshot anymore).
    runtime.spawnX = x;
    runtime.spawnY = y;
    const message: RasterClientMessage = { type: "CLIENT_RASTER_SELECT_SPAWN", payload: { x, y } };
    transport.send(message);
  };

  const sendBuild = (targetX: number, targetY: number, building: BuildingType): void => {
    const message: RasterClientMessage = {
      type: "CLIENT_RASTER_BUILD",
      payload: { targetX, targetY, building },
    };
    transport.send(message);
  };

  const sendNuke = (targetX: number, targetY: number, kind: NukeKind): void => {
    const message: RasterClientMessage = {
      type: "CLIENT_RASTER_NUKE",
      payload: { targetX, targetY, kind },
    };
    transport.send(message);
  };

  const sendAllyPropose = (targetId: number): void => {
    const message: RasterClientMessage = { type: "CLIENT_RASTER_ALLY_PROPOSE", payload: { targetId } };
    transport.send(message);
  };

  const sendAllyRespond = (targetId: number, accept: boolean): void => {
    const message: RasterClientMessage = { type: "CLIENT_RASTER_ALLY_RESPOND", payload: { targetId, accept } };
    transport.send(message);
  };

  const sendAllyBreak = (targetId: number): void => {
    const message: RasterClientMessage = { type: "CLIENT_RASTER_ALLY_BREAK", payload: { targetId } };
    transport.send(message);
  };

  const sendAllyRenew = (targetId: number): void => {
    const message: RasterClientMessage = { type: "CLIENT_RASTER_ALLY_RENEW", payload: { targetId } };
    transport.send(message);
  };

  const sendDonate = (targetId: number, resource: "troops" | "gold"): void => {
    const percent = Number(ui.attackPercentInput.value) || 20;
    transport.send({ type: "CLIENT_RASTER_DONATE", payload: { targetId, resource, percent } });
  };

  const sendEmbargo = (targetId: number, on: boolean): void => {
    transport.send({ type: "CLIENT_RASTER_EMBARGO", payload: { targetId, on } });
  };

  const sendEmoji = (targetId: number, emoji: number): void => {
    transport.send({ type: "CLIENT_RASTER_EMOJI", payload: { targetId, emoji } });
  };

  /** Ask every current ally to attack `targetId` (OpenFront's target request, fanned out). */
  const requestAlliesAttack = (targetId: number): void => {
    const { allies } = diplomacyState();
    for (const allyId of allies) {
      transport.send({ type: "CLIENT_RASTER_TARGET_REQUEST", payload: { allyId, targetId } });
    }
  };

  /** How many of `type` we currently own — feeds the geometric cost ramp. */
  const myBuildingCount = (type: BuildingType): number => {
    switch (type) {
      case "city":
        return runtime.myCities;
      case "port":
        return runtime.myPorts;
      case "factory":
        return runtime.myFactories;
      case "fort":
        return runtime.myForts;
      case "warship":
        return runtime.myWarships;
      case "silo":
        return runtime.mySilos;
      case "sam":
        return runtime.mySams;
    }
  };

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
        `<span class="icon">${iconSvgMarkup(type, 19)}</span>` +
        `<span class="label">${escapeHtml(def.name)}<span class="sub">${escapeHtml(def.description)}</span></span>` +
        `<span class="cost" data-cost></span>` +
        `</button>`
      );
    }).join("");
    for (const btn of ui.buildMenu.querySelectorAll<HTMLButtonElement>("[data-building]")) {
      btn.addEventListener("click", () => {
        const type = btn.getAttribute("data-building") as BuildingType;
        toggleBuildMode(type);
      });
    }
  };

  /**
   * Enter (or toggle off) build mode for `type`, shared by the build-menu buttons
   * and the number-key hotkeys. Re-selecting the active type, or passing `null`,
   * cancels build mode. No-op while we can't build (unspawned, spectating, ended).
   */
  const toggleBuildMode = (type: BuildingType | null): void => {
    if (type !== null) {
      const canBuild = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
      if (!canBuild) return;
    }
    runtime.buildMode = type === null || runtime.buildMode === type ? null : type;
    if (runtime.buildMode) {
      runtime.nukeMode = null;
      runtime.expandMode = "auto";
    }
    refreshBuildMenu();
    refreshWeaponsMenu();
    renderSidebar();
    setStatus(
      ui,
      runtime.buildMode
        ? `Build mode: click a tile you own to place a ${BUILDING_DEFS[runtime.buildMode].name}.`
        : "Build cancelled.",
    );
  };

  /** Refresh each build button's cost, affordability and selected state. */
  const refreshBuildMenu = (): void => {
    const canBuild = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
    for (const btn of ui.buildMenu.querySelectorAll<HTMLButtonElement>("[data-building]")) {
      const type = btn.getAttribute("data-building") as BuildingType;
      // Ports and Factories share a cost counter — sum the group's owned counts.
      const owned = costCounterTypes(type).reduce((s, t) => s + myBuildingCount(t), 0);
      const cost = buildingCost(type, owned);
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

  /** Icon glyph shown on each weapon button — distinct at a glance, like the Atom Bomb's original radiation symbol. */
  const NUKE_GLYPH: Readonly<Record<NukeKind, string>> = {
    atom: "\u{2622}\u{FE0E}",
    hydrogen: "\u{269B}\u{FE0F}",
    mirv: "\u{2604}\u{FE0F}",
  };

  /** Build the (static) weapon buttons once and wire each to toggle nuke mode for its kind. */
  const renderWeaponsMenuOnce = (): void => {
    if (ui.weaponsMenu.children.length > 0) return;
    ui.weaponsMenu.innerHTML = NUKE_KINDS.map((kind) => {
      const def = NUKE_DEFS[kind];
      return (
        `<button class="build-btn" type="button" data-weapon="${kind}">` +
        `<span class="icon">${NUKE_GLYPH[kind]}</span>` +
        `<span class="label">${escapeHtml(def.name)}<span class="sub">${escapeHtml(def.description)}</span></span>` +
        `<span class="cost" data-cost></span>` +
        `</button>`
      );
    }).join("");
    for (const btn of ui.weaponsMenu.querySelectorAll<HTMLButtonElement>("[data-weapon]")) {
      btn.addEventListener("click", () => toggleNukeMode(btn.getAttribute("data-weapon") as NukeKind));
    }
  };

  /**
   * Enter (or toggle off) nuke-targeting mode for `kind`, mutually exclusive
   * with build mode — the next map click launches that warhead instead of
   * expanding or building. Re-selecting the armed kind cancels it, like
   * {@link toggleBuildMode}. No-op while we can't act (unspawned, spectating,
   * ended).
   */
  const toggleNukeMode = (kind: NukeKind): void => {
    const canAct = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
    if (!canAct && runtime.nukeMode === null) return;
    runtime.nukeMode = runtime.nukeMode === kind ? null : kind;
    if (runtime.nukeMode) {
      runtime.buildMode = null;
      runtime.expandMode = "auto";
    }
    refreshBuildMenu();
    refreshWeaponsMenu();
    renderSidebar();
    setStatus(
      ui,
      runtime.nukeMode
        ? `${NUKE_DEFS[runtime.nukeMode].name} armed — click a land tile to launch.`
        : "Launch cancelled.",
    );
  };

  /** Refresh each weapon button's cost, affordability and selected state. */
  const refreshWeaponsMenu = (): void => {
    const canAct = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
    for (const btn of ui.weaponsMenu.querySelectorAll<HTMLButtonElement>("[data-weapon]")) {
      const kind = btn.getAttribute("data-weapon") as NukeKind;
      const cost = nukeCost(kind, runtime.mySilos);
      const affordable = runtime.gold >= cost;
      btn.classList.toggle("selected", runtime.nukeMode === kind);
      btn.disabled = !canAct;
      const costEl = btn.querySelector<HTMLSpanElement>("[data-cost]");
      if (costEl) {
        costEl.textContent = `${formatCount(cost)}g`;
        costEl.classList.toggle("unaffordable", !affordable);
      }
    }
  };

  /**
   * Arm (or toggle off) a forced route for the next expand click — OpenFront's
   * B(oat)/G(round) hotkeys. Mutually exclusive with build/nuke mode, and with
   * each other (arming one clears the other); re-pressing the armed mode's key
   * cancels it back to `"auto"`. No-op while we can't act.
   */
  const toggleExpandMode = (mode: "land" | "sea"): void => {
    const canAct = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
    if (!canAct) return;
    runtime.expandMode = runtime.expandMode === mode ? "auto" : mode;
    if (runtime.expandMode !== "auto") {
      runtime.buildMode = null;
      runtime.nukeMode = null;
      refreshBuildMenu();
      refreshWeaponsMenu();
      renderSidebar();
    }
    setStatus(
      ui,
      runtime.expandMode === "sea"
        ? "Boat attack armed — the next click always sails, even across a land border."
        : runtime.expandMode === "land"
          ? "Ground attack armed — the next click requires a land route."
          : "Forced route cancelled.",
    );
  };

  // Seat ourselves on the chosen map as soon as the transport is ready.
  transport.onOpen(() => {
    const join: RasterClientMessage = {
      type: "CLIENT_RASTER_JOIN",
      payload: { mapId: options.mapId, difficulty: options.difficulty },
    };
    transport.send(join);
  });
  transport.onMessage((message) => handleMessage(message));
  transport.onClose(() => {
    setStatus(ui, "Connection closed.", "error");
  });
  transport.start();

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
    // A mid-match elimination sends winnerPlayerId=null + stats.eliminated=true.
    // In that case we enter spectate mode rather than ending the match — the player
    // can dismiss the defeat overlay and keep watching the remaining action.
    const isEliminatedMidMatch = payload.stats.eliminated && payload.winnerPlayerId === null;

    if (isEliminatedMidMatch) {
      runtime.myEliminated = true;
      // Don't set matchEnded: keep receiving snapshots for spectating.
      ui.teamInfo.textContent = `Spectating — ${runtime.myName}`;
      ui.teamInfo.style.color = "#94a3b8";
    } else {
      runtime.matchEnded = true;
      runtime.winnerPlayerId = payload.winnerPlayerId;
    }

    if (payload.stats.won) sfx.victory();
    else sfx.defeat();
    setStatus(ui, payload.stats.won ? "You won the run!" : isEliminatedMidMatch ? "Eliminated — spectating." : "Run over.", "victory");

    const storage = safeStorage();
    const record = recordRun(storage, payload, Date.now());
    showStatsScreen(payload, record, loadRunHistory(storage), isEliminatedMidMatch);
  };

  /**
   * Render the post-match stats screen: this run's verdict and key figures, a
   * Play-Again button, and a short tail of previous runs from local history.
   * When `spectateMode` is true (mid-match elimination), a "Spectate" button is
   * shown that dismisses the overlay so the player can watch the rest of the game.
   */
  const showStatsScreen = (
    payload: RasterMatchEndedPayload,
    record: RunRecord,
    history: RunRecord[],
    spectateMode = false,
  ): void => {
    const { stats, reason, durationTicks, tickRate } = payload;
    const verdictClass = stats.won ? "win" : "loss";
    const verdictText = stats.won ? "Victory!" : stats.eliminated ? "Eliminated!" : "Defeated";
    const reasonText = spectateMode
      ? "Your nation was conquered"
      : reason === "conquest" ? "by conquest" : "on the clock";
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

    const spectateBtn = spectateMode
      ? `<button id="statsSpectate" class="menu-button" type="button" style="width:100%;margin-top:8px;">Spectate the battle</button>`
      : "";

    ui.statsOverlay.innerHTML =
      `<div class="stats-card">` +
      `<p class="verdict ${verdictClass}">${verdictText}</p>` +
      `<p class="run-label">` +
      (spectateMode ? `${escapeHtml(reasonText)} after ${formatDuration(matchSeconds)}` : `Run #${record.run} · ${escapeHtml(reasonText)} · match ${formatDuration(matchSeconds)}`) +
      `</p>` +
      `<div class="stats-grid">` +
      `<span class="k">Peak territory</span><span class="v">${stats.peakTiles} tiles</span>` +
      `<span class="k">Final territory</span><span class="v">${stats.finalTiles} tiles</span>` +
      `<span class="k">Eliminations</span><span class="v">${stats.kills}</span>` +
      `<span class="k">Survival time</span><span class="v">${formatDuration(record.survivedSeconds)}</span>` +
      `</div>` +
      spectateBtn +
      `<button id="statsPlayAgain" class="menu-button primary" type="button" style="width:100%;margin-top:${spectateMode ? "8" : "16"}px;">Play Again</button>` +
      (recent && !spectateMode ? `<div class="stats-history"><h3>Recent runs</h3>${recent}</div>` : "") +
      `</div>`;
    ui.statsOverlay.classList.remove("hidden");

    const again = ui.statsOverlay.querySelector<HTMLButtonElement>("#statsPlayAgain");
    again?.addEventListener("click", () => window.location.reload());

    // Spectate: dismiss the overlay so the player can watch the rest of the battle
    const spectateButton = ui.statsOverlay.querySelector<HTMLButtonElement>("#statsSpectate");
    spectateButton?.addEventListener("click", () => {
      ui.statsOverlay.classList.add("hidden");
      setStatus(ui, "Spectating — your nation was eliminated. Watch the rest of the battle.");
    });
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

  // Same reconciliation as updateShips, but a warship's own tile-space (x,y)
  // is already itself smoothly interpolated server-side (fractional
  // movement, not a discrete tile hop like transports), so the client eases
  // on top of that for an extra-smooth glide; hp/maxHp/retreating are just
  // copied straight through (no interpolation needed for a health bar).
  const updateWarships = (warships: RasterWarship[]): void => {
    const generation = (runtime.warshipGeneration += 1);
    for (const w of warships) {
      const existing = runtime.warships.get(w.warshipId);
      if (existing) {
        existing.tx = w.x;
        existing.ty = w.y;
        existing.hp = w.hp;
        existing.maxHp = w.maxHp;
        existing.retreating = w.retreating;
        existing.seen = generation;
      } else {
        runtime.warships.set(w.warshipId, {
          rx: w.x,
          ry: w.y,
          tx: w.x,
          ty: w.y,
          color: rgbaToCss(playerColor(w.playerId)),
          hp: w.hp,
          maxHp: w.maxHp,
          retreating: w.retreating,
          seen: generation,
        });
      }
    }
    for (const [id, dot] of runtime.warships) {
      if (dot.seen !== generation) runtime.warships.delete(id);
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

  const spawnNukeExplosions = (detonations: RasterNukeDetonation[]): void => {
    if (detonations.length === 0) return;
    const now = performance.now();
    for (const d of detonations) {
      runtime.nukeExplosions.push({ x: d.x, y: d.y, kind: d.kind, start: now });
    }
    sfx.nukeDetonate();
  };

  const spawnNukeIntercepts = (interceptions: RasterNukeInterception[]): void => {
    if (interceptions.length === 0) return;
    const now = performance.now();
    for (const i of interceptions) {
      runtime.nukeIntercepts.push({ x: i.x, y: i.y, start: now });
    }
    sfx.nukeIntercepted();
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
    const nextAlliances = snapshot.alliances ?? [];
    // A new pact involving us — whichever side accepted — gets the chime. Diffed
    // against the snapshot (rather than fired from the accept click) so both "I
    // accepted their offer" and "they accepted mine" play the same cue exactly
    // once, off the confirmed server state instead of an optimistic guess.
    if (runtime.myPlayerId !== null) {
      const had = new Set(
        runtime.alliances
          .filter((al) => al.a === runtime.myPlayerId || al.b === runtime.myPlayerId)
          .map((al) => `${al.a}-${al.b}`),
      );
      const gainedMine = nextAlliances.some(
        (al) => (al.a === runtime.myPlayerId || al.b === runtime.myPlayerId) && !had.has(`${al.a}-${al.b}`),
      );
      if (gainedMine) sfx.allyAccepted();
    }
    runtime.alliances = nextAlliances;
    runtime.allianceRequests = snapshot.allianceRequests ?? [];
    runtime.embargoes = snapshot.embargoes ?? [];
    runtime.targetRequests = snapshot.targetRequests ?? [];
    runtime.emojis = snapshot.emojis ?? [];
    runtime.phase = snapshot.phase;
    runtime.spawnRemainingSeconds = snapshot.spawnRemainingSeconds;
    updateStartBanner();
    updateMatchTimer(snapshot.tick);

    const me = snapshot.players.find((p) => p.playerId === runtime.myPlayerId);
    runtime.pool = me?.troops ?? 0;
    runtime.myTiles = me?.tiles ?? 0;
    runtime.myMaxTroops = me?.maxTroops ?? 0;
    runtime.troopsPerSecond = me?.troopsPerSecond ?? 0;
    runtime.gold = me?.gold ?? 0;
    runtime.goldPerSecond = me?.goldPerSecond ?? 0;
    runtime.myCities = me?.cities ?? 0;
    runtime.myPorts = me?.ports ?? 0;
    runtime.myForts = me?.forts ?? 0;
    runtime.myFactories = me?.factories ?? 0;
    runtime.mySilos = me?.silos ?? 0;
    runtime.myWarships = me?.warships ?? 0;
    runtime.mySams = me?.sams ?? 0;
    runtime.lastAttackedBy = me?.lastAttackedBy ?? 0;
    runtime.buildings = snapshot.buildings ?? [];
    runtime.nukes = snapshot.nukes ?? [];
    // Fallout is sent whole each snapshot (empty string = nowhere irradiated),
    // so replace the set outright rather than diffing.
    if (snapshot.falloutBase64 !== undefined) {
      runtime.fallout = new Set(decodeTileList(snapshot.falloutBase64));
    }
    runtime.rails = snapshot.rails ?? [];
    runtime.trains = snapshot.trains ?? [];
    runtime.tradeShips = snapshot.tradeShips ?? [];

    // The first snapshot in which we hold land marks the end of the spawn phase:
    // zoom the camera in on the tile we founded on so the run starts at home.
    if (!runtime.spawned && me && me.tiles > 0 && runtime.spawnX >= 0) {
      runtime.spawned = true;
      centerOnTile(runtime.spawnX, runtime.spawnY, SPAWN_ZOOM_TILES);
      setStatus(ui, `Founded at (${runtime.spawnX}, ${runtime.spawnY}).`);
    }

    runtime.fronts = snapshot.fronts ?? [];

    // When spectating (eliminated mid-match), watch for the match to end via
    // the snapshot's winnerPlayerId — eliminated players don't receive the
    // SERVER_RASTER_MATCH_ENDED broadcast, so we pick it up here instead.
    if (runtime.myEliminated && !runtime.matchEnded && snapshot.winnerPlayerId !== null) {
      runtime.matchEnded = true;
      runtime.winnerPlayerId = snapshot.winnerPlayerId;
      const winnerInfo = snapshot.players.find((p) => p.playerId === snapshot.winnerPlayerId);
      const winnerName = winnerInfo?.name ?? `Player ${snapshot.winnerPlayerId}`;
      setStatus(ui, `Match over — ${escapeHtml(winnerName)} won!`, "victory");
    }

    const ships = snapshot.ships ?? [];
    runtime.myShips = ships.reduce((n, s) => (s.playerId === runtime.myPlayerId ? n + 1 : n), 0);
    updateShips(ships);
    updateWarships(snapshot.warships ?? []);
    spawnLandings(snapshot.crossings ?? []);
    spawnNukeExplosions(snapshot.nukeDetonations ?? []);
    spawnNukeIntercepts(snapshot.nukeInterceptions ?? []);
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
    // A full repaint means we have no per-tile change set to glow (first
    // snapshot, or a high-churn full resend); drop any stale flashes.
    runtime.captureFlashes.length = 0;
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
    const now = performance.now();
    const dirty = new Set<number>();
    for (let k = 0; k < records; k += 1) {
      const index = view.getUint32(k * 6, true);
      const newOwner = view.getUint16(k * 6 + 4, true);
      if (index < owner.length) {
        const prevOwner = owner[index];
        owner[index] = newOwner;
        dirty.add(index);
        for (const n of map.neighbors(index)) dirty.add(n);
        // Glow only on a genuine capture by a real player (skip collapses back to
        // neutral), so the wash reads as an advancing front rather than churn.
        if (newOwner !== 0 && newOwner !== prevOwner) {
          runtime.captureFlashes.push({ ref: index, css: flashCss(newOwner), start: now });
        }
      }
    }
    if (runtime.captureFlashes.length > MAX_CAPTURE_FLASHES) {
      runtime.captureFlashes.splice(0, runtime.captureFlashes.length - MAX_CAPTURE_FLASHES);
    }
    // Repaint each touched tile and track their bounding box, so the GPU upload
    // below covers only the changed region instead of re-uploading the whole
    // (up to 1.6M-pixel) base every snapshot. Per-tick churn at a front is a tiny
    // fraction of the map, so this keeps `putImageData` cheap on big maps.
    const highlight = runtime.myPlayerId ?? -1;
    let minX = map.width;
    let minY = map.height;
    let maxX = -1;
    let maxY = -1;
    for (const ref of dirty) {
      paintTileInto(map, owner, ref, target.image.data, undefined, highlight);
      const tx = ref % map.width;
      const ty = (ref - tx) / map.width;
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    if (maxX >= 0) {
      target.base
        .getContext("2d")
        ?.putImageData(target.image, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    }
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

  /**
   * Ensure a terrain-only offscreen base (no ownership tint/borders) exists
   * for the Space "alt view" — built once from a computed all-neutral owner
   * array and cached forever, since terrain never changes after generation.
   */
  const ensureTerrainOnlyBase = (): HTMLCanvasElement | null => {
    const map = runtime.map;
    if (!map) return null;
    let tbase = runtime.terrainOnlyBase;
    if (!tbase || tbase.width !== map.width || tbase.height !== map.height) {
      tbase = document.createElement("canvas");
      tbase.width = map.width;
      tbase.height = map.height;
      const ctx = tbase.getContext("2d");
      if (ctx) {
        const image = ctx.createImageData(map.width, map.height);
        paintRaster(map, new Uint16Array(map.size), image.data);
        ctx.putImageData(image, 0, 0);
      }
      runtime.terrainOnlyBase = tbase;
    }
    return tbase;
  };

  /** Composite the base map plus transport ships and landings onto the canvas. */
  const renderFrame = (now: number): void => {
    const map = runtime.map;
    const base = runtime.showTerrainOnly ? ensureTerrainOnlyBase() ?? runtime.base : runtime.base;
    const ctx = ui.mapContext;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const { scale, x, y } = runtime.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (map && base) {
      // Draw the base raster under the camera transform with image smoothing
      // OFF at every zoom level, exactly like OpenFront's TransformHandler
      // (`context.imageSmoothingEnabled = false`). The base is one pixel per
      // tile; bilinear upscaling smears that low-res grid into a blurry wash that
      // reads as "pixelated", whereas nearest-neighbour keeps each tile a clean,
      // crisp pixel. Anti-aliased vector borders are overlaid separately below so
      // nation outlines still read smooth on diagonal edges.
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      ctx.drawImage(base, 0, 0);
      drawCaptureFlashes(now, ctx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      drawFallout(ctx, scale);
      drawBorders(ctx, scale);
      drawCoordinateGrid(ctx, scale);
      recomputeNames(now);
      drawNames(ctx, scale);
      drawRails(ctx, scale);
      drawBuildings(ctx, scale);
      drawTrains(ctx, scale);
      drawTradeShips(ctx, scale);
      drawShips(ctx, scale);
      drawWarships(ctx, scale);
      drawNukes(ctx, scale);
      drawLandings(now, ctx, scale);
      drawNukeExplosions(now, ctx, scale);
      drawNukeIntercepts(now, ctx, scale);
      drawClickRipples(now, ctx, scale);
      drawFronts(ctx, scale);
      drawEmojis(ctx, scale);
      drawBuildGhost(ctx, scale);
      drawNukeTargetPreview(ctx, scale);
    }
    drawMinimap();
    requestAnimationFrame(renderFrame);
  };

  /**
   * Wash a brief, fading glow over every tile captured in the last few hundred
   * ms, in the conqueror's brightened colour. Drawn in world space (tile units)
   * under the camera transform so the glow lands exactly on its tiles, turning an
   * advancing front into a visible wave of conquest. Expired flashes are pruned
   * here so the list stays bounded between snapshots.
   */
  const drawCaptureFlashes = (now: number, ctx: CanvasRenderingContext2D): void => {
    const map = runtime.map;
    if (!map || runtime.captureFlashes.length === 0) return;
    const left = runtime.view.x;
    const top = runtime.view.y;
    const right = left + ui.mapCanvas.width / runtime.view.scale;
    const bottom = top + ui.mapCanvas.height / runtime.view.scale;
    const survivors: CaptureFlash[] = [];
    ctx.save();
    for (const flash of runtime.captureFlashes) {
      const t = (now - flash.start) / CAPTURE_FLASH_MS;
      if (t >= 1) continue;
      survivors.push(flash);
      const tx = map.x(flash.ref);
      const ty = map.y(flash.ref);
      if (tx < left - 1 || ty < top - 1 || tx > right || ty > bottom) continue;
      ctx.globalAlpha = (1 - t) * CAPTURE_FLASH_ALPHA;
      ctx.fillStyle = flash.css;
      ctx.fillRect(tx, ty, 1, 1);
    }
    ctx.restore();
    runtime.captureFlashes = survivors;
  };

  /**
   * Recompute each nation's name anchor (throttled). Operates on the live owner
   * raster for every player still holding land, so labels track territory as it
   * changes hands without paying the cost every frame.
   */
  const recomputeNames = (now: number): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner) return;
    // Recompute less often on big maps — labels drift slowly and the pass is a
    // full O(size) owner scan (~10ms on the 1.6M-tile Earth), so a longer
    // interval keeps the hitch rare.
    const interval = map.size > 600_000 ? 900 : NAME_RECOMPUTE_MS;
    if (now - runtime.lastNameComputeMs < interval) return;
    runtime.lastNameComputeMs = now;

    const players = runtime.players
      .filter((p) => !p.eliminated && p.tiles > 0)
      .map((p) => ({ playerId: p.playerId, nameLength: p.name.length }));

    // Skip the whole (full-raster) pass when the camera is zoomed out far enough
    // that no label would clear the minimum on-screen font size AND territory
    // hasn't grown since the last pass — otherwise an early computation done
    // while everyone's territory was still tiny (fresh spawns) would freeze
    // `nameAnchors` at that size forever, since growth alone never re-triggers
    // the scan. `drawNames` culls per-anchor anyway, so keeping the previous
    // anchors is harmless; the next zoom-in or territory change recomputes them.
    const tileTotal = runtime.players.reduce((sum, p) => sum + p.tiles, 0);
    let maxSize = 0;
    for (const a of runtime.nameAnchors) if (a.size > maxSize) maxSize = a.size;
    if (maxSize > 0 && tileTotal === runtime.lastNameTileTotal && maxSize * runtime.view.scale < MIN_NAME_FONT_PX) return;
    runtime.lastNameTileTotal = tileTotal;

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
   * Draw the auto-routed railroads as track polylines: a dark casing with a
   * lighter steel rail on top so the network reads as track, not borders. Drawn
   * beneath the building icons (the stations) it links. Zoomed far out the
   * ballast/sleeper detail collapses into a single thin line so the clean
   * spanning network still reads alongside the station dots.
   */
  const drawRails = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.rails.length === 0) return;

    // Zoomed out: the ballast/sleeper detail is illegible and only muddies the
    // map, so draw the network as a single thin dark line — enough to read the
    // links between the (now-visible) station dots without clutter.
    if (scale < 2) {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(40, 42, 52, 0.75)";
      ctx.lineWidth = Math.max(1, 1.2 * dpr);
      ctx.beginPath();
      for (const rail of runtime.rails) {
        if (rail.points.length < 2) continue;
        for (let i = 0; i < rail.points.length; i += 1) {
          const p = worldToScreen(rail.points[i][0] + 0.5, rail.points[i][1] + 0.5);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    const lw = Math.max(1, scale * 0.5);
    // Sleepers (perpendicular ties) only when there's room to read them.
    const showSleepers = scale >= 5;
    const tieSpacing = Math.max(5, scale * 0.85);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const rail of runtime.rails) {
      if (rail.points.length < 2) continue;
      const pts = rail.points.map((p) => worldToScreen(p[0] + 0.5, p[1] + 0.5));

      // Dark ballast casing under the rails.
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 1) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.strokeStyle = "rgba(30, 32, 40, 0.9)";
      ctx.lineWidth = lw * 2.1;
      ctx.stroke();

      // Wooden sleepers: short perpendicular ties stepped along each segment, so
      // the line reads as railroad track rather than a plain stroke.
      if (showSleepers) {
        ctx.strokeStyle = "rgba(122, 96, 70, 0.95)";
        ctx.lineWidth = Math.max(1, lw * 0.5);
        const tieLen = lw * 1.3;
        for (let i = 1; i < pts.length; i += 1) {
          const ax = pts[i - 1].x;
          const ay = pts[i - 1].y;
          const dx = pts[i].x - ax;
          const dy = pts[i].y - ay;
          const segLen = Math.hypot(dx, dy);
          if (segLen < 1) continue;
          const nx = -dy / segLen; // unit normal
          const ny = dx / segLen;
          for (let d = tieSpacing / 2; d < segLen; d += tieSpacing) {
            const cx = ax + (dx * d) / segLen;
            const cy = ay + (dy * d) / segLen;
            ctx.beginPath();
            ctx.moveTo(cx - nx * tieLen, cy - ny * tieLen);
            ctx.lineTo(cx + nx * tieLen, cy + ny * tieLen);
            ctx.stroke();
          }
        }
      }

      // Steel rail on top.
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 1) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.strokeStyle = "rgba(196, 202, 214, 0.95)";
      ctx.lineWidth = Math.max(0.7, lw * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * Draw each train as a small owner-coloured dot with a dark halo, at its
   * fractional position along the track. Trains earn gold at every city/port
   * they reach, so seeing them roll is the visible payoff of a rail network.
   */
  const drawTrains = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.trains.length === 0 || scale < 2) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const radius = Math.max(1.6, scale * 0.28);
    ctx.save();
    for (const train of runtime.trains) {
      const p = worldToScreen(train.x + 0.5, train.y + 0.5);
      if (p.x < -radius || p.y < -radius || p.x > cw + radius || p.y > ch + radius) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = rgbaToCss(playerColor(train.playerId));
      ctx.fill();
    }
    ctx.restore();
  };

  /**
   * Draw each trade ship as an owner-coloured dot ringed in gold, at its
   * fractional position along the sea lane between two ports. A completed trip
   * pays both ports gold, so a busy sea lane is the visible payoff of a port
   * network — distinguished from trains by the gold ring.
   */
  const drawTradeShips = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.tradeShips.length === 0 || scale < 2) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const radius = Math.max(1.6, scale * 0.28);
    ctx.save();
    for (const ship of runtime.tradeShips) {
      const p = worldToScreen(ship.x + 0.5, ship.y + 0.5);
      if (p.x < -radius || p.y < -radius || p.x > cw + radius || p.y > ch + radius) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(234, 179, 8, 0.85)"; // gold halo marks a trade run
      ctx.fill();
      ctx.fillStyle = rgbaToCss(playerColor(ship.playerId));
      drawIcon(ctx, "ship", p.x, p.y, radius);
    }
    ctx.restore();
  };

  /**
   * Draw each structure as an OpenFront-style marker: a filled **disc in the
   * owner's colour** (darkened) with a brighter owner-colour ring, and the
   * building icon laid on top. Anchoring the icon on a player-coloured base —
   * rather than floating a bare emoji over the terrain — makes structures read
   * as *owned* and legible against any ground, at a deliberately generous size.
   *
   * Zoom LOD keeps a crowded map tidy: below a readable size the marker collapses
   * to a small owner-coloured dot (no icon), and when fully zoomed out it is
   * hidden entirely — detail is *removed*, not shrunk into mush.
   */
  const drawBuildings = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.buildings.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    // Radii are in backing-store (device) pixels, so a legible on-screen size has
    // to be expressed in CSS px × DPR — otherwise the markers vanish on retina
    // displays. This is why structures used to be "barely visible zoomed out":
    // the dot floor was a sub-CSS-pixel 1.8 device px, and we bailed entirely
    // below scale 2 — which is the *fit* zoom for the default Large/Huge maps,
    // so at full-map view no structures showed at all.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // Below this zoom the shaped icon tokens are too big/cluttered, so we draw
    // plain owner dots — but with a firm minimum screen size so they always read.
    const dotMode = scale < 6;
    const radius = dotMode
      ? Math.max(3.2 * dpr, Math.min(scale * 0.7, 6 * dpr))
      : Math.max(12, Math.min(scale * 0.72, 30));
    // Monochrome glyphs read clearly even when large, so the icon fills most of
    // the disc (OpenFront's white-on-colour markers).
    const iconPx = radius * 1.5;

    type Rgb = { r: number; g: number; b: number };
    const lighten = (c: Rgb, t: number): string =>
      rgbaToCss({ r: c.r + (255 - c.r) * t, g: c.g + (255 - c.g) * t, b: c.b + (255 - c.b) * t });
    const darken = (c: Rgb, t: number): string =>
      rgbaToCss({ r: c.r * (1 - t), g: c.g * (1 - t), b: c.b * (1 - t) });
    // Distinct silhouette per structure type (like OpenFront's per-type shapes),
    // so a glance at the outline already tells city from port from fort. `sides`
    // 0 means a circle; `rot` orients the polygon.
    const SHAPE: Record<string, { sides: number; rot: number }> = {
      city: { sides: 0, rot: 0 },
      port: { sides: 5, rot: -Math.PI / 2 },
      factory: { sides: 6, rot: -Math.PI / 2 },
      fort: { sides: 8, rot: Math.PI / 8 },
      warship: { sides: 4, rot: 0 },
      silo: { sides: 3, rot: -Math.PI / 2 },
    };
    const tracePath = (cx: number, cy: number, r: number, type: string): void => {
      const shape = SHAPE[type] ?? { sides: 0, rot: 0 };
      ctx.beginPath();
      if (shape.sides === 0) {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        return;
      }
      for (let i = 0; i < shape.sides; i += 1) {
        const a = shape.rot + (i * 2 * Math.PI) / shape.sides;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    ctx.save();
    for (const b of runtime.buildings) {
      const { x: sx, y: sy } = worldToScreen(b.x + 0.5, b.y + 0.5);
      if (sx < -radius * 2 || sy < -radius * 2 || sx > cw + radius * 2 || sy > ch + radius * 2) continue;
      const col = playerColor(b.playerId);

      if (dotMode) {
        // Zoomed out: a small owner-coloured dot with a dark halo — shows where
        // structures stand without drawing unreadable icons. Cities (the anchor
        // of an empire) get a slightly fatter dot so they stand out from ports,
        // forts and the rest at a glance.
        const r = b.type === "city" ? radius * 1.35 : radius;
        ctx.beginPath();
        ctx.arc(sx, sy, r + dpr, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = rgbaToCss(col);
        ctx.fill();
        continue;
      }

      // A structure still going up is drawn dimmed, with a progress bar below.
      if (b.underConstruction) ctx.globalAlpha = 0.5;

      // 1. Cast shadow — a soft ellipse below the marker so it sits ON the land
      //    and casts a shadow, instead of floating flat on top of it.
      ctx.beginPath();
      ctx.ellipse(sx, sy + radius * 0.6, radius * 0.95, radius * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.30)";
      ctx.fill();

      // 2. Shaped base, filled with a radial gradient (light top-left → dark
      //    bottom-right) so the token reads as a raised dome, not a flat disc.
      const grad = ctx.createRadialGradient(
        sx - radius * 0.38, sy - radius * 0.42, radius * 0.1,
        sx, sy, radius * 1.08,
      );
      grad.addColorStop(0, lighten(col, 0.5));
      grad.addColorStop(0.55, rgbaToCss(col));
      grad.addColorStop(1, darken(col, 0.5));
      tracePath(sx, sy, radius, b.type);
      ctx.fillStyle = grad;
      ctx.fill();
      // Crisp dark outline around the silhouette.
      ctx.lineWidth = Math.max(1.2, radius * 0.11);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
      ctx.stroke();

      // 3. Rim highlight along the top edge — the glint that sells the volume.
      ctx.beginPath();
      ctx.arc(sx, sy, radius * 0.82, Math.PI * 1.12, Math.PI * 1.92);
      ctx.lineWidth = Math.max(1, radius * 0.13);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      ctx.stroke();

      // 4. A faint dark well behind the glyph so the icon reads cleanly on top.
      ctx.beginPath();
      ctx.arc(sx, sy, radius * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
      ctx.fill();

      // 5. The building icon: a crisp **white** vector silhouette (custom-drawn,
      //    not a system emoji font) so it reads cleanly and identically across
      //    every platform, on top of any owner colour.
      ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
      drawIcon(ctx, b.type, sx, sy, iconPx * 0.5);

      // 5b. Level badge on an upgraded structure (OpenFront's level digits): a
      //     small dark disc with the level, bottom-right of the token.
      if (b.level > 1) {
        const br = Math.max(5, radius * 0.42);
        const bcx = sx + radius * 0.78;
        const bcy = sy + radius * 0.78;
        ctx.beginPath();
        ctx.arc(bcx, bcy, br, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(15, 17, 23, 0.92)";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.font = `600 ${Math.max(7, br * 1.3)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(b.level), bcx, bcy + 0.5);
      }

      // 6. Build-progress bar under a structure still under construction.
      if (b.underConstruction) {
        ctx.globalAlpha = 1;
        const bw = radius * 1.8;
        const bh = Math.max(2.5, radius * 0.22);
        const bx = sx - bw / 2;
        const by = sy + radius + bh * 1.4;
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = "rgba(70, 72, 82, 0.95)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = "rgba(250, 204, 21, 0.95)"; // amber fill
        ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, b.buildProgress)), bh);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  };

  /**
   * Overlay anti-aliased nation borders along the actual tile edges in the
   * viewport. The base terrain is drawn nearest-neighbour (crisp pixels), so its
   * baked 1px outline is already sharp but stair-steps on diagonals; this thin
   * vector line on top softens those diagonals into clean, continuous outlines —
   * OpenFront-style. Each boundary edge is traced once and batched by colour so
   * we stroke a handful of paths, not thousands of segments. Only runs when
   * zoomed in enough that borders read and the visible-tile count stays in budget.
   */
  const drawBorders = (ctx: CanvasRenderingContext2D, scale: number): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner || scale < BORDER_DETAIL_SCALE) return;
    const view = runtime.view;
    const x0 = Math.max(0, Math.floor(view.x));
    const y0 = Math.max(0, Math.floor(view.y));
    const x1 = Math.min(map.width - 1, Math.ceil(view.x + ui.mapCanvas.width / scale));
    const y1 = Math.min(map.height - 1, Math.ceil(view.y + ui.mapCanvas.height / scale));
    if (x1 < x0 || y1 < y0) return;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > BORDER_OVERLAY_TILE_BUDGET) return;

    const me = runtime.myPlayerId ?? -1;
    const meKey = "me";
    const cssCache = new Map<number, string>();
    const ownerCss = (id: number): string => {
      let css = cssCache.get(id);
      if (!css) {
        css = rgbaToCss(borderColor(id));
        cssCache.set(id, css);
      }
      return css;
    };
    // One Path2D per stroke colour; the local player's edges go in their own
    // (white, slightly thicker) path so "me" reads at a glance.
    const paths = new Map<string, Path2D>();
    const pathFor = (key: string): Path2D => {
      let p = paths.get(key);
      if (!p) {
        p = new Path2D();
        paths.set(key, p);
      }
      return p;
    };
    const edge = (a: number, b: number, ax: number, ay: number, bx: number, by: number): void => {
      if (a === b || (a === 0 && b === 0)) return;
      const key = a === me || b === me ? meKey : ownerCss(a !== 0 ? a : b);
      const p = pathFor(key);
      p.moveTo((ax - view.x) * scale, (ay - view.y) * scale);
      p.lineTo((bx - view.x) * scale, (by - view.y) * scale);
    };

    const width = map.width;
    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        const ref = ty * width + tx;
        const a = owner[ref];
        if (tx + 1 < width) {
          // Vertical edge between this tile and its right neighbour.
          edge(a, owner[ref + 1], tx + 1, ty, tx + 1, ty + 1);
        }
        if (ty + 1 < map.height) {
          // Horizontal edge between this tile and the one below.
          edge(a, owner[ref + width], tx, ty + 1, tx + 1, ty + 1);
        }
      }
    }

    ctx.save();
    ctx.lineCap = "round";
    for (const [key, path] of paths) {
      if (key === meKey) continue;
      ctx.strokeStyle = key;
      ctx.lineWidth = 1.8;
      ctx.stroke(path);
    }
    const mePath = paths.get(meKey);
    if (mePath) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 2.4;
      ctx.stroke(mePath);
    }
    ctx.restore();
  };

  /**
   * Draw a troop-count label on each active attack front, so it is visible at a
   * glance which border is being fought over and with how many troops. Rendered
   * in screen space as a rounded pill in the attacker's colour with the count in
   * white — OpenFront's on-map combat readout.
   */
  const drawFronts = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.fronts.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const px = clamp(scale * 0.85, 11, 17);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${px}px Inter, system-ui, sans-serif`;
    for (const front of runtime.fronts) {
      if (front.troops <= 0) continue;
      const { x: sx, y: sy } = worldToScreen(front.x + 0.5, front.y + 0.5);
      if (sx < -90 || sy < -40 || sx > cw + 90 || sy > ch + 40) continue;
      const text = `⚔ ${formatCount(front.troops)}`;
      const w = ctx.measureText(text).width + px;
      const h = px * 1.5;
      const rx = sx - w / 2;
      const ry = sy - h / 2;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      traceRoundRect(ctx, rx - 1.5, ry - 1.5, w + 3, h + 3, (h + 3) / 2);
      ctx.fill();
      ctx.fillStyle = rgbaToCss(playerColor(front.playerId));
      traceRoundRect(ctx, rx, ry, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(text, sx, sy + 0.5);
    }
    ctx.restore();
  };

  /**
   * Float the transient emoji reactions over the map — each rises and fades
   * over its ~2s life (server-supplied `age` in ticks, EMOJI_LIFETIME_TICKS=20).
   * A small owner-coloured dot ties the emoji to who sent it. Purely cosmetic.
   */
  const drawEmojis = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.emojis.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const px = clamp(scale * 1.4, 18, 40);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${px}px system-ui, sans-serif`;
    for (const e of runtime.emojis) {
      const glyph = RASTER_EMOJIS[e.emoji];
      if (!glyph) continue;
      const life = Math.min(1, e.age / 20); // 0 fresh → 1 expiring
      const { x: bx, y: by } = worldToScreen(e.x + 0.5, e.y + 0.5);
      const sx = bx;
      const sy = by - life * px * 1.6; // rise as it ages
      if (sx < -px || sy < -px || sx > cw + px || sy > ch + px) continue;
      ctx.globalAlpha = 1 - life * 0.85;
      // A small sender-coloured dot anchors the reaction to its author.
      ctx.beginPath();
      ctx.arc(sx, sy + px * 0.55, Math.max(2, px * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = rgbaToCss(playerColor(e.from));
      ctx.fill();
      ctx.fillText(glyph, sx, sy);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /**
   * In build mode, outline the hovered tile with the structure's own colour
   * and icon before the player commits — OpenFront's ghost-build preview.
   * Green when the tile is a legal build site (owned, no existing structure),
   * amber over your own same-type structure (an **upgrade** — the click raises
   * its level), red otherwise, so the outline itself answers "can I build here?".
   */
  const drawBuildGhost = (ctx: CanvasRenderingContext2D, scale: number): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    const type = runtime.buildMode;
    if (!map || !owner || !type || runtime.hoverTileX === null || runtime.hoverTileY === null) return;
    const tx = runtime.hoverTileX;
    const ty = runtime.hoverTileY;
    if (!map.inBounds(tx, ty)) return;

    const ref = map.ref(tx, ty);
    const isMine = owner[ref] === runtime.myPlayerId;
    const hoverBuilding = runtime.buildings.find((b) => b.x === tx && b.y === ty);
    const isUpgrade =
      hoverBuilding !== undefined &&
      hoverBuilding.playerId === runtime.myPlayerId &&
      hoverBuilding.type === type &&
      !hoverBuilding.underConstruction &&
      UPGRADABLE_BUILDING_TYPES.includes(type);
    const valid = isMine && (hoverBuilding === undefined || isUpgrade);
    const outline = isUpgrade
      ? "rgba(250, 204, 21, 0.95)"
      : valid
        ? "rgba(74, 222, 128, 0.9)"
        : "rgba(248, 113, 113, 0.9)";
    const fill = isUpgrade
      ? "rgba(250, 204, 21, 0.22)"
      : valid
        ? "rgba(74, 222, 128, 0.22)"
        : "rgba(248, 113, 113, 0.18)";

    const { x: sx, y: sy } = worldToScreen(tx, ty);
    const size = scale;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(1.5, scale * 0.08);
    ctx.fillRect(sx, sy, size, size);
    ctx.strokeRect(sx, sy, size, size);
    if (scale >= 10) {
      ctx.fillStyle = isUpgrade ? "#facc15" : valid ? "#4ade80" : "#f87171";
      drawIcon(ctx, type, sx + size / 2, sy + size / 2, Math.min(scale * 0.3, 11));
      if (isUpgrade) {
        // Spell out what the click does: raise this structure to the next level.
        ctx.font = `600 ${Math.max(9, Math.min(scale * 0.35, 13))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`Lv ${hoverBuilding.level + 1}`, sx + size / 2, sy - 2);
      }
    }
    ctx.restore();
  };

  /**
   * While nuke mode is armed, show the armed warhead's blast radii at the
   * hovered tile — a dashed outer ring for the partial-destruction band, a
   * solid inner ring for the fully-irradiated zone — so the player sees the
   * strike's real footprint before committing. A MIRV shows one warhead's
   * footprint at the aim point; the actual launch scatters several of them.
   */
  const drawNukeTargetPreview = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (!runtime.nukeMode || runtime.hoverTileX === null || runtime.hoverTileY === null) return;
    if (!runtime.map || !runtime.map.inBounds(runtime.hoverTileX, runtime.hoverTileY)) return;
    const c = worldToScreen(runtime.hoverTileX + 0.5, runtime.hoverTileY + 0.5);
    const { inner, outer } = nukeBlast(runtime.nukeMode);
    const innerPx = inner * scale;
    const outerPx = outer * scale;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 120, 40, 0.75)";
    ctx.lineWidth = Math.max(1, scale * 0.06);
    ctx.setLineDash([Math.max(4, scale * 0.3), Math.max(4, scale * 0.3)]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, outerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255, 60, 20, 0.9)";
    ctx.lineWidth = Math.max(1.2, scale * 0.08);
    ctx.beginPath();
    ctx.arc(c.x, c.y, innerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
      // The ship has no owner-coloured badge behind it (unlike buildings), so
      // the icon itself is tinted directly to the owner's colour.
      ctx.fillStyle = ship.color;
      drawIcon(ctx, "ship", p.x, p.y, radius);
      ctx.restore();
    }
  };

  /**
   * Ease and draw every mobile warship: the hull icon (owner-tinted, like a
   * transport ship), a health bar above it once damaged (OpenFront: "only
   * warships have health bars"), and a cyan halo instead of white while
   * retreating home to heal — a distinct "fleeing" cue from its normal/
   * engaging look.
   */
  const drawWarships = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.warships.size === 0) return;
    const radius = Math.max(3, scale * 0.5);
    for (const w of runtime.warships.values()) {
      w.rx += (w.tx - w.rx) * SHIP_EASE;
      w.ry += (w.ty - w.ry) * SHIP_EASE;
      const p = worldToScreen(w.rx, w.ry);

      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = w.retreating ? "rgba(56, 189, 248, 0.9)" : "rgba(255, 255, 255, 0.85)";
      ctx.fill();
      ctx.fillStyle = w.color;
      drawIcon(ctx, "warship", p.x, p.y, radius);

      if (w.hp < w.maxHp) {
        const barW = Math.max(14, radius * 2.2);
        const barH = Math.max(2, scale * 0.12);
        const barX = p.x - barW / 2;
        const barY = p.y - radius - barH - 3;
        const frac = Math.max(0, Math.min(1, w.hp / w.maxHp));
        // Red at 0hp, amber at half, green at full — a smooth two-segment lerp.
        const hue = frac < 0.5 ? frac * 2 * 45 : 45 + (frac - 0.5) * 2 * 75;
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
        ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        ctx.fillRect(barX, barY, barW * frac, barH);
      }
      ctx.restore();
    }
  };

  /** Flight-icon fill colour per warhead kind — distinguishes them at a glance in the air. */
  const NUKE_FLIGHT_COLOR: Readonly<Record<NukeKind, string>> = {
    atom: "#f97316",
    hydrogen: "#ef4444",
    mirv: "#a855f7",
  };

  /**
   * Draw each warhead in flight as a small travelling missile icon, tinted and
   * glyphed by kind. A MIRV launch appears as several independent entries
   * (one per scattered warhead), each drawn separately.
   */
  const drawNukes = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.nukes.length === 0) return;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const radius = Math.max(3, scale * 0.5);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const nuke of runtime.nukes) {
      const p = worldToScreen(nuke.x, nuke.y);
      if (p.x < -40 || p.y < -40 || p.x > cw + 40 || p.y > ch + 40) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = NUKE_FLIGHT_COLOR[nuke.kind];
      ctx.fill();
      ctx.font = `${Math.max(8, radius * 1.4)}px "Segoe UI Symbol", "Noto Sans Symbols2", system-ui, sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.fillText(NUKE_GLYPH[nuke.kind], p.x, p.y);
    }
    ctx.restore();
  };

  /**
   * The bright flash at each warhead's impact: a bloomed fireball + expanding
   * shockwave ring over ~900ms, sized to that kind's real blast radii. The
   * *lasting* mark on the ground is the server-authoritative fallout tint (see
   * {@link drawFallout}), not this transient flash.
   */
  const drawNukeExplosions = (now: number, ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.nukeExplosions.length === 0) return;
    const survivors: NukeExplosion[] = [];
    for (const exp of runtime.nukeExplosions) {
      const t = (now - exp.start) / NUKE_EXPLOSION_DURATION_MS;
      if (t >= 1) continue;
      survivors.push(exp);
      const { inner, outer } = nukeBlast(exp.kind);
      const innerPx = inner * scale;
      const outerPx = outer * scale;
      const ease = 1 - (1 - t) * (1 - t);
      const c = worldToScreen(exp.x + 0.5, exp.y + 0.5);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = "rgba(255, 200, 90, 0.45)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, outerPx * ease, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 245, 0.8)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, innerPx * ease, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 120, 30, 0.95)";
      ctx.lineWidth = Math.max(2, scale * 0.2);
      ctx.beginPath();
      ctx.arc(c.x, c.y, outerPx * ease, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    runtime.nukeExplosions = survivors;
  };

  /**
   * A brief cyan "X" burst where a SAM Launcher shot down a warhead before
   * impact — visually distinct from a real detonation's orange fireball, so
   * the player can tell a launch was intercepted rather than landed.
   */
  const drawNukeIntercepts = (now: number, ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.nukeIntercepts.length === 0) return;
    const survivors: NukeIntercept[] = [];
    const size = Math.max(4, scale * 0.35);
    for (const hit of runtime.nukeIntercepts) {
      const t = (now - hit.start) / NUKE_EXPLOSION_DURATION_MS;
      if (t >= 1) continue;
      survivors.push(hit);
      const c = worldToScreen(hit.x + 0.5, hit.y + 0.5);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = "rgba(56, 189, 248, 0.95)";
      ctx.lineWidth = Math.max(1.5, scale * 0.12);
      ctx.lineCap = "round";
      const r = size * (0.6 + t * 0.6);
      ctx.beginPath();
      ctx.moveTo(c.x - r, c.y - r);
      ctx.lineTo(c.x + r, c.y + r);
      ctx.moveTo(c.x + r, c.y - r);
      ctx.lineTo(c.x - r, c.y + r);
      ctx.stroke();
      ctx.restore();
    }
    runtime.nukeIntercepts = survivors;
  };

  /**
   * Draw faint tile-boundary lines over the visible viewport when the M
   * coordinate-grid toggle is on — OpenFront's `CoordinateGridPass`. Screen
   * space (drawn after the camera transform is reset), and skipped when
   * zoomed too far out for the lines to read as anything but noise.
   */
  const drawCoordinateGrid = (ctx: CanvasRenderingContext2D, scale: number): void => {
    if (!runtime.showCoordinateGrid || !runtime.map || scale < 3) return;
    const map = runtime.map;
    const view = runtime.view;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const x0 = Math.max(0, Math.floor(view.x));
    const y0 = Math.max(0, Math.floor(view.y));
    const x1 = Math.min(map.width, Math.ceil(view.x + cw / scale));
    const y1 = Math.min(map.height, Math.ceil(view.y + ch / scale));
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = x0; gx <= x1; gx += 1) {
      const sx = Math.round((gx - view.x) * scale) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, ch);
    }
    for (let gy = y0; gy <= y1; gy += 1) {
      const sy = Math.round((gy - view.y) * scale) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(cw, sy);
    }
    ctx.stroke();
    ctx.restore();
  };

  /**
   * Paint the lingering radioactive fallout: every tile the server currently
   * reports as irradiated (nuked ground that can't be recaptured until it
   * decays) gets a sickly yellow-green wash plus a faint flickering speckle, so
   * a struck region stays visibly scorched on the map — OpenFront's fallout
   * ground tint. Viewport-culled; drawn in screen space over the base raster.
   */
  const drawFallout = (ctx: CanvasRenderingContext2D, scale: number): void => {
    const map = runtime.map;
    if (!map || runtime.fallout.size === 0 || scale < BORDER_DETAIL_SCALE) return;
    const view = runtime.view;
    const cw = ui.mapCanvas.width;
    const ch = ui.mapCanvas.height;
    const x0 = Math.floor(view.x);
    const y0 = Math.floor(view.y);
    const x1 = Math.ceil(view.x + cw / scale);
    const y1 = Math.ceil(view.y + ch / scale);
    ctx.save();
    for (const ref of runtime.fallout) {
      const tx = ref % map.width;
      const ty = (ref / map.width) | 0;
      if (tx < x0 || tx > x1 || ty < y0 || ty > y1) continue;
      const sx = (tx - view.x) * scale;
      const sy = (ty - view.y) * scale;
      // Deterministic per-tile speckle so the wash reads as radioactive grime,
      // not a flat fill; cheap integer hash keeps it stable frame-to-frame.
      const h = ((ref * 2654435761) >>> 0) / 0x100000000;
      ctx.fillStyle = h < 0.4 ? "rgba(150, 200, 40, 0.55)" : "rgba(120, 160, 30, 0.4)";
      ctx.fillRect(sx, sy, scale + 1, scale + 1);
    }
    ctx.restore();
  };

  /**
   * Draw a sonar-ping ring at each recently-clicked tile: a quick confirmation
   * that the expand (or spawn) order registered before the server responds.
   * Two staggered rings expand from the tile centre in the player's colour.
   */
  const drawClickRipples = (now: number, ctx: CanvasRenderingContext2D, scale: number): void => {
    if (runtime.clickRipples.length === 0) return;
    const survivors: ClickRipple[] = [];
    for (const ripple of runtime.clickRipples) {
      const t = (now - ripple.start) / CLICK_RIPPLE_MS;
      if (t >= 1) continue;
      survivors.push(ripple);
      const ease = 1 - (1 - t) * (1 - t); // ease-out
      const c = worldToScreen(ripple.x + 0.5, ripple.y + 0.5);
      ctx.save();
      // Outer ring: starts at tile edge, expands to ~3× tile width
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = ripple.color;
      ctx.lineWidth = Math.max(1.5, scale * 0.25);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(4, scale * (0.5 + ease * 2.5)), 0, Math.PI * 2);
      ctx.stroke();
      // Inner ring (delayed by 80 ms, so it trails the outer one)
      const t2 = Math.max(0, t - 0.18);
      const ease2 = 1 - (1 - t2) * (1 - t2);
      ctx.globalAlpha = (1 - t2) * 0.55;
      ctx.lineWidth = Math.max(1, scale * 0.18);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(2, scale * (0.3 + ease2 * 1.5)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    runtime.clickRipples = survivors;
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
      const maxPool = runtime.myMaxTroops;
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
        `<span class="res res-builds">${iconSvgMarkup("city", 13)} ${runtime.myCities} ${iconSvgMarkup("port", 13)} ${runtime.myPorts} ${iconSvgMarkup("fort", 13)} ${runtime.myForts} ${iconSvgMarkup("factory", 13)} ${runtime.myFactories}</span>`;
    }
    refreshBuildMenu();
    refreshWeaponsMenu();
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
      ? "Your nation is founded. Click open land to move it; territory opens when the timer hits zero."
      : "Click anywhere on open land to found your nation.";
    ui.startBanner.innerHTML =
      `<span class="start-banner-title">${escapeHtml(title)}</span>` +
      `<span class="start-banner-timer">${secs}s</span>` +
      `<span class="start-banner-sub">${escapeHtml(sub)}</span>`;
    ui.startBanner.classList.remove("hidden");
  };

  /**
   * The top-right elapsed-match-time readout (mm:ss), OpenFront's frame timer.
   * Blank during the spawn phase, which has its own countdown banner instead.
   */
  const updateMatchTimer = (tick: number): void => {
    if (runtime.phase === "spawn") {
      ui.matchTimer.textContent = "0:00";
      return;
    }
    const totalSeconds = Math.floor(tick / SIMULATION_TICK_RATE);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    ui.matchTimer.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
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
          `<em>Click open land to relocate your spawn while the timer runs. Drag to pan, scroll to zoom.</em>`;
      ui.eventsPanel.innerHTML = runtime.recentEvents
        .map((ev) => `<div class="event">${escapeHtml(ev)}</div>`)
        .join("");
      renderLeaderboard();
      return;
    }

    const rel = diplomacyState();
    const diplomacyLine =
      rel.incoming.size > 0
        ? `<strong>🤝 ${rel.incoming.size} alliance offer${rel.incoming.size === 1 ? "" : "s"}</strong> — accept or decline in the leaderboard.<br/>`
        : rel.allies.size > 0
          ? `<strong>🤝 Allied with ${rel.allies.size} nation${rel.allies.size === 1 ? "" : "s"}.</strong> Allies can't attack each other.<br/>`
          : "";

    ui.selectionInfo.innerHTML =
      `<strong>Orders</strong><br/>` +
      diplomacyLine +
      `<strong>Ships at sea:</strong> ${runtime.myShips} / 3<br/>` +
      `<em>Click adjacent land to expand. Click any landmass across water to send a transport ship ` +
      `to its nearest reachable shore (one per click, max 3 at sea). Drag to pan, scroll to zoom.</em><br/>` +
      `<em>Use the leaderboard's <strong>Ally</strong> buttons to propose alliances — allied nations can't ` +
      `attack each other until the pact is broken.</em>`;

    ui.eventsPanel.innerHTML = runtime.recentEvents
      .map((ev) => `<div class="event">${escapeHtml(ev)}</div>`)
      .join("");

    renderLeaderboard();
  };

  interface DiplomacyState {
    allies: Set<number>;
    incoming: Set<number>;
    outgoing: Set<number>;
    /** Per allied partner: the pact's countdown + standing renewal votes. */
    pacts: Map<number, RasterAllianceInfo>;
    /** Players I currently embargo (my outgoing embargoes). */
    embargoed: Set<number>;
    /** Players who have asked me to attack someone (incoming target requests → set of targets). */
    incomingTargetRequests: Set<number>;
  }

  /**
   * Resolve, for the local player, who is an ally, who has an alliance offer out
   * to us, and who we have offered — plus each pact's remaining lifetime and
   * renewal votes. Derived fresh from the snapshot's alliance + proposal lists
   * so the leaderboard can label each rival and pick the right diplomacy action.
   */
  const diplomacyState = (): DiplomacyState => {
    const me = runtime.myPlayerId;
    const allies = new Set<number>();
    const incoming = new Set<number>();
    const outgoing = new Set<number>();
    const pacts = new Map<number, RasterAllianceInfo>();
    const embargoed = new Set<number>();
    const incomingTargetRequests = new Set<number>();
    if (me !== null) {
      for (const al of runtime.alliances) {
        const partner = al.a === me ? al.b : al.b === me ? al.a : null;
        if (partner === null) continue;
        allies.add(partner);
        pacts.set(partner, al);
      }
      for (const r of runtime.allianceRequests) {
        if (r.to === me) incoming.add(r.from);
        else if (r.from === me) outgoing.add(r.to);
      }
      for (const [from, to] of runtime.embargoes) {
        if (from === me) embargoed.add(to);
      }
      for (const r of runtime.targetRequests) {
        if (r.to === me) incomingTargetRequests.add(r.target);
      }
    }
    return { allies, incoming, outgoing, pacts, embargoed, incomingTargetRequests };
  };

  /**
   * The diplomacy action button(s) for a rival row: an ally row shows the
   * pact's countdown, a renew vote near expiry, and break; otherwise
   * accept/decline an incoming offer, mark an outgoing offer as sent, or
   * propose a fresh alliance. Empty while we can't act (pre-game, match over,
   * our own row).
   */
  const diplomacyActions = (id: number, rel: DiplomacyState, canDiplo: boolean): string => {
    if (!canDiplo) return "";
    if (rel.allies.has(id)) {
      const pact = rel.pacts.get(id);
      const ticksLeft = pact?.ticksLeft ?? 0;
      const clock = formatDuration(Math.ceil(ticksLeft / SIMULATION_TICK_RATE));
      const timer = `<span class="lb-pact" title="Alliance expires in ${clock} unless both sides renew">${clock}</span>`;
      const voted = runtime.myPlayerId !== null && (pact?.renewVotes.includes(runtime.myPlayerId) ?? false);
      const renew =
        ticksLeft > ALLIANCE_RENEWAL_WINDOW_TICKS
          ? ""
          : voted
            ? `<button class="lb-act pending" disabled title="Waiting for your ally's renewal vote">⏳</button>`
            : `<button class="lb-act renew" data-ally-renew="${id}" title="Vote to renew the alliance">Renew</button>`;
      return timer + renew + `<button class="lb-act break" data-ally-break="${id}" title="Break alliance">Break</button>`;
    }
    if (rel.incoming.has(id)) {
      return (
        `<button class="lb-act accept" data-ally-accept="${id}" title="Accept alliance">✓</button>` +
        `<button class="lb-act decline" data-ally-decline="${id}" title="Decline alliance">✕</button>`
      );
    }
    if (rel.outgoing.has(id)) {
      return `<button class="lb-act pending" disabled title="Offer pending">Sent</button>`;
    }
    return `<button class="lb-act ally" data-ally-propose="${id}" title="Propose alliance">Ally</button>`;
  };

  /**
   * Live standings: every active (non-eliminated) player, sorted by tiles held
   * descending. Each row shows a colour dot, name, tile count and pool with its
   * growth rate, plus a diplomacy action against each rival. Your own row is
   * highlighted, and turns green while you hold the lead ("du gewinnst"); allies
   * are flagged with a 🤝.
   */
  /** Sortable leaderboard columns, in OpenFront's order (rank is implicit). */
  const LEADERBOARD_COLUMNS: ReadonlyArray<{ key: LeaderboardSortKey; label: string; cls: string }> = [
    { key: "name", label: "Player", cls: "name" },
    { key: "owned", label: "Owned", cls: "num" },
    { key: "gold", label: "Gold", cls: "num" },
    { key: "max", label: "Max", cls: "num" },
  ];

  const leaderboardValue = (p: RasterPlayerInfo, key: LeaderboardSortKey): number | string =>
    key === "name" ? p.name.toLowerCase() : key === "gold" ? p.gold : key === "max" ? p.maxTroops : p.tiles;

  const renderLeaderboard = (): void => {
    const activeAll = runtime.players.filter((p) => !p.eliminated);
    if (activeAll.length === 0) {
      ui.leaderboard.innerHTML = `<div class="lb-empty">No active players.</div>`;
      return;
    }
    // The leader crown always tracks territory, whatever the table is sorted by.
    const leaderId = activeAll.reduce((best, p) => (p.tiles > best.tiles ? p : best)).playerId;

    const { key, dir } = runtime.leaderboardSort;
    const active = [...activeAll].sort((a, b) => {
      const av = leaderboardValue(a, key);
      const bv = leaderboardValue(b, key);
      let cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      if (cmp === 0) cmp = a.playerId - b.playerId; // stable tiebreak
      return cmp * dir;
    });

    const rel = diplomacyState();
    const canDiplo = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated && runtime.myPlayerId !== null;

    const arrow = (colKey: LeaderboardSortKey): string => (colKey === key ? (dir < 0 ? " ▾" : " ▴") : "");
    const header =
      `<div class="lb-head">` +
      `<span class="lb-rank">#</span>` +
      LEADERBOARD_COLUMNS.map(
        (c) => `<button type="button" data-sort="${c.key}" class="${c.cls}${c.key === key ? " active" : ""}">${c.label}${arrow(c.key)}</button>`,
      ).join("") +
      `</div>`;

    const rows = active
      .map((p, i) => {
        const isMe = p.playerId === runtime.myPlayerId;
        const isLeader = p.playerId === leaderId;
        const isAlly = rel.allies.has(p.playerId);
        const rowClass = ["lb-row", isMe ? "me" : "", isLeader ? "leader" : "", isAlly ? "ally" : ""].filter(Boolean).join(" ");
        const allyMark = isAlly ? "🤝 " : "";
        const traitorMark = p.betrayals > 0
          ? ` <span class="lb-traitor" title="Broke ${p.betrayals} alliance${p.betrayals === 1 ? "" : "s"}">🗡${p.betrayals > 1 ? `×${p.betrayals}` : ""}</span>`
          : "";
        const embargoMark = rel.embargoed.has(p.playerId) ? ` <span class="lb-embargo" title="You are embargoing this player">🚫</span>` : "";
        const targetMark = rel.incomingTargetRequests.has(p.playerId) ? ` <span class="lb-target" title="An ally asked you to attack this player">🎯</span>` : "";
        const name = `${allyMark}${playerEmoji(p.playerId)} ${escapeHtml(p.name)}` + (isMe ? " (you)" : "") + traitorMark + embargoMark + targetMark;
        const own = runtime.capturableTotal > 0 ? (p.tiles / runtime.capturableTotal) * 100 : 0;
        const ownStr = own >= 10 ? `${Math.round(own)}%` : `${own.toFixed(1)}%`;
        const actions = isMe ? "" : diplomacyActions(p.playerId, rel, canDiplo);
        return (
          `<div class="${rowClass}">` +
          `<span class="lb-rank">${i + 1}</span>` +
          `<span class="lb-name"><span class="lb-dot" style="background:${escapeHtml(p.color)}"></span><span class="txt">${name}</span></span>` +
          `<span class="lb-col">${ownStr}</span>` +
          `<span class="lb-col">${formatCount(p.gold)}</span>` +
          `<span class="lb-col">${formatCount(p.maxTroops)}</span>` +
          (actions ? `<span class="lb-acts">${actions}</span>` : "") +
          `</div>`
        );
      })
      .join("");
    // Victory-progress footer: the domination threshold and how close the
    // current territory leader is to it, so the race's stakes stay visible.
    const leader = activeAll.find((p) => p.playerId === leaderId);
    const leaderOwn = leader && runtime.capturableTotal > 0 ? (leader.tiles / runtime.capturableTotal) * 100 : 0;
    const leaderOwnStr = leaderOwn >= 10 ? `${Math.round(leaderOwn)}%` : `${leaderOwn.toFixed(1)}%`;
    const note = `<div class="lb-note">Win at ${Math.round(WIN_TILE_FRACTION * 100)}% of land — leader holds ${leaderOwnStr}</div>`;
    ui.leaderboard.innerHTML = header + rows + note;
  };

  /** Apply a header click: toggle direction when re-clicking a column, else sort by it. */
  const setLeaderboardSort = (key: LeaderboardSortKey): void => {
    const cur = runtime.leaderboardSort;
    // Numeric columns default to descending (biggest first); name to ascending.
    if (cur.key === key) cur.dir = cur.dir === 1 ? -1 : 1;
    else runtime.leaderboardSort = { key, dir: key === "name" ? 1 : -1 };
    renderLeaderboard();
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

  // ---- Right-click radial menu (OpenFront-style contextual pie menu) ------
  //
  // A generic two-level pie: right-clicking a tile opens a ring of icon
  // buttons around a centre "Attack" button; two of those (Build/Nuke) morph
  // the ring into a sub-menu of building/weapon icons with a "Back" centre
  // button, mirroring OpenFront's nested `RadialMenu`. Every leaf reuses the
  // exact same send*/state functions the sidebar buttons already call,
  // targeted at the tile that was right-clicked — so choosing e.g. a
  // building here places it immediately, no second click required.

  interface RadialItem {
    label: string;
    html: string;
    className?: string;
    disabled?: boolean;
    onClick: () => void;
  }

  /** Which tile the currently-open radial menu targets, and which ring it's showing. */
  let radial: { tileX: number; tileY: number; owner: number; level: "root" | "build" | "nuke" | "diplomacy" | "emoji" } | null = null;

  const RADIAL_RADIUS = 78;

  /** Close the radial menu if one is open. Returns whether it was (so callers can swallow the closing click). */
  const closeRadialMenu = (): boolean => {
    if (!radial) return false;
    radial = null;
    ui.radialMenu.classList.add("hidden");
    ui.radialMenu.innerHTML = "";
    return true;
  };

  /** Render `center` plus `ring` (evenly spaced) into the radial menu DOM, replacing whatever was there. */
  const renderRadialSlices = (center: RadialItem, ring: RadialItem[]): void => {
    ui.radialMenu.innerHTML = "";
    const place = (item: RadialItem, dx: number, dy: number): void => {
      const slice = document.createElement("div");
      slice.className = "radial-slice";
      slice.style.left = `${dx}px`;
      slice.style.top = `${dy}px`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `radial-btn${item.className ? ` ${item.className}` : ""}`;
      btn.innerHTML = item.html;
      btn.disabled = !!item.disabled;
      btn.title = item.label;
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        item.onClick();
      });
      slice.appendChild(btn);
      const label = document.createElement("span");
      label.className = "radial-label";
      label.textContent = item.label;
      slice.appendChild(label);
      ui.radialMenu.appendChild(slice);
    };
    place(center, 0, 0);
    // A denser ring (the Build sub-menu's 7 structures) needs more spread so
    // neighbouring labels don't overlap; a sparse root ring stays compact.
    const radius = Math.max(RADIAL_RADIUS, 46 + ring.length * 12);
    ring.forEach((item, i) => {
      const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
      place(item, Math.cos(angle) * radius, Math.sin(angle) * radius);
    });
  };

  /** Root ring: Attack (centre) + Boat/Ground/Build/Nuke + diplomacy actions for the tile's owner. */
  const renderRadialRoot = (): void => {
    if (!radial) return;
    const { tileX, tileY, owner } = radial;
    const percent = (): number => Number(ui.attackPercentInput.value);
    const ripple = (): void => {
      runtime.clickRipples.push({ x: tileX, y: tileY, color: runtime.myColor, start: performance.now() });
      sfx.click();
    };
    const expandFrom = (mode: RasterExpandMode, routeLabel: string): void => {
      sendExpand(tileX, tileY, percent(), mode);
      ripple();
      setStatus(ui, `Expanding toward (${tileX}, ${tileY})${routeLabel} with ${percent()}% of pool.`);
      closeRadialMenu();
    };

    const center: RadialItem = {
      label: "Attack",
      className: "center",
      html: `<span class="glyph">⚔️</span>`,
      onClick: () => expandFrom("auto", ""),
    };
    const ring: RadialItem[] = [
      { label: "Boat", html: `<span class="glyph">⛴️</span>`, onClick: () => expandFrom("sea", " by boat") },
      { label: "Ground", html: `<span class="glyph">\u{1F6E1}️</span>`, onClick: () => expandFrom("land", " by land") },
      {
        label: "Build",
        html: `<span class="glyph">\u{1F528}</span>`,
        onClick: () => {
          radial!.level = "build";
          renderRadialBuild();
        },
      },
      {
        label: "Nuke",
        html: `<span class="glyph">☢️</span>`,
        onClick: () => {
          radial!.level = "nuke";
          renderRadialNuke();
        },
      },
    ];

    // Every interaction with a rival's tile — ally/break/donate/embargo/target/
    // emoji — lives behind one Diplomacy branch so the root ring stays compact
    // (OpenFront's nested pie). Only shown for a living rival's own tile.
    if (owner !== 0 && owner !== runtime.myPlayerId) {
      ring.push({
        label: "Diplomacy",
        className: "ally-action",
        html: `<span class="glyph">\u{1F91D}</span>`,
        onClick: () => { radial!.level = "diplomacy"; renderRadialDiplomacy(); },
      });
    }
    renderRadialSlices(center, ring);
  };

  /** Diplomacy sub-ring for the right-clicked rival: context actions by relationship. */
  const renderRadialDiplomacy = (): void => {
    if (!radial) return;
    const owner = radial.owner;
    const center: RadialItem = {
      label: "Back",
      className: "center",
      html: `<span class="glyph">←</span>`,
      onClick: () => { radial!.level = "root"; renderRadialRoot(); },
    };
    const ring: RadialItem[] = [];
    const rel = diplomacyState();
    // Emoji is always available against any rival.
    ring.push({
      label: "Emoji",
      html: `<span class="glyph">\u{1F642}</span>`,
      onClick: () => { radial!.level = "emoji"; renderRadialEmoji(); },
    });

    if (rel.incoming.has(owner)) {
      ring.push({
        label: "Accept", className: "ally-action", html: `<span class="glyph">✓</span>`,
        onClick: () => { sendAllyRespond(owner, true); closeRadialMenu(); },
      });
      ring.push({
        label: "Decline", className: "break-action", html: `<span class="glyph">✕</span>`,
        onClick: () => { sendAllyRespond(owner, false); closeRadialMenu(); },
      });
    } else if (rel.allies.has(owner)) {
      // An ally: break, or send them troops/gold (a slice of your own pool).
      ring.push({
        label: "Break ally", className: "break-action", html: `<span class="glyph">\u{1F494}</span>`,
        onClick: () => { sendAllyBreak(owner); closeRadialMenu(); },
      });
      ring.push({
        label: "Send troops", className: "ally-action", html: `<span class="glyph">\u{1F6E1}️</span>`,
        onClick: () => { sendDonate(owner, "troops"); setStatus(ui, `Sent troops to ${playerName(owner)}.`); closeRadialMenu(); },
      });
      ring.push({
        label: "Send gold", className: "ally-action", html: `<span class="glyph">\u{1FA99}</span>`,
        onClick: () => { sendDonate(owner, "gold"); setStatus(ui, `Sent gold to ${playerName(owner)}.`); closeRadialMenu(); },
      });
    } else {
      // A non-ally: propose a pact, toggle a trade embargo, or flag them as a
      // target for all your allies.
      ring.push({
        label: "Ally", className: "ally-action", html: `<span class="glyph">\u{1F91D}</span>`,
        onClick: () => { sendAllyPropose(owner); setStatus(ui, "Alliance offer sent."); closeRadialMenu(); },
      });
      const embargoing = rel.embargoed.has(owner);
      ring.push({
        label: embargoing ? "Lift embargo" : "Embargo", className: "break-action",
        html: `<span class="glyph">\u{1F6AB}</span>`,
        onClick: () => { sendEmbargo(owner, !embargoing); setStatus(ui, embargoing ? `Lifted embargo on ${playerName(owner)}.` : `Embargoed ${playerName(owner)}.`); closeRadialMenu(); },
      });
      if (rel.allies.size > 0) {
        ring.push({
          label: "Ask allies to attack", className: "break-action", html: `<span class="glyph">\u{1F3AF}</span>`,
          onClick: () => { requestAlliesAttack(owner); setStatus(ui, `Asked your allies to attack ${playerName(owner)}.`); closeRadialMenu(); },
        });
      }
    }
    renderRadialSlices(center, ring);
  };

  /** Emoji sub-ring: flash one of the shared emojis over the targeted rival. */
  const renderRadialEmoji = (): void => {
    if (!radial) return;
    const owner = radial.owner;
    const center: RadialItem = {
      label: "Back",
      className: "center",
      html: `<span class="glyph">←</span>`,
      onClick: () => { radial!.level = "diplomacy"; renderRadialDiplomacy(); },
    };
    const ring: RadialItem[] = RASTER_EMOJIS.map((glyph, i) => ({
      label: glyph,
      html: `<span class="glyph">${glyph}</span>`,
      onClick: () => { sendEmoji(owner, i); closeRadialMenu(); },
    }));
    renderRadialSlices(center, ring);
  };

  /** Build sub-ring: every building type, placed immediately at the right-clicked tile. */
  const renderRadialBuild = (): void => {
    if (!radial) return;
    const { tileX, tileY } = radial;
    const center: RadialItem = {
      label: "Back",
      className: "center",
      html: `<span class="glyph">←</span>`,
      onClick: () => { radial!.level = "root"; renderRadialRoot(); },
    };
    const ring: RadialItem[] = BUILDING_TYPES.map((type) => {
      const def = BUILDING_DEFS[type];
      const owned = costCounterTypes(type).reduce((s, t) => s + myBuildingCount(t), 0);
      const cost = buildingCost(type, owned);
      return {
        label: `${def.name} (${formatCount(cost)}g)`,
        html: iconSvgMarkup(type, 22),
        disabled: runtime.gold < cost,
        onClick: () => {
          sendBuild(tileX, tileY, type);
          runtime.clickRipples.push({ x: tileX, y: tileY, color: runtime.myColor, start: performance.now() });
          sfx.click();
          setStatus(ui, `Building ${def.name} at (${tileX}, ${tileY})…`);
          closeRadialMenu();
        },
      };
    });
    renderRadialSlices(center, ring);
  };

  /** Nuke sub-ring: every warhead kind, launched immediately at the right-clicked tile. */
  const renderRadialNuke = (): void => {
    if (!radial) return;
    const { tileX, tileY } = radial;
    const center: RadialItem = {
      label: "Back",
      className: "center",
      html: `<span class="glyph">←</span>`,
      onClick: () => { radial!.level = "root"; renderRadialRoot(); },
    };
    const ring: RadialItem[] = NUKE_KINDS.map((kind) => {
      const def = NUKE_DEFS[kind];
      const cost = nukeCost(kind, runtime.mySilos);
      return {
        label: `${def.name} (${formatCount(cost)}g)`,
        html: `<span class="glyph">${NUKE_GLYPH[kind]}</span>`,
        disabled: runtime.gold < cost,
        onClick: () => {
          sendNuke(tileX, tileY, kind);
          runtime.clickRipples.push({ x: tileX, y: tileY, color: "rgba(255,120,40,0.9)", start: performance.now() });
          sfx.nukeLaunch();
          setStatus(ui, `${def.name} launched at (${tileX}, ${tileY}).`);
          closeRadialMenu();
        },
      };
    });
    renderRadialSlices(center, ring);
  };

  /** Right-click opens the radial menu on the clicked tile, suppressing the browser's own context menu. */
  ui.mapCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!runtime.map || !runtime.owner) return;
    const canAct = runtime.spawned && runtime.phase === "playing" && !runtime.matchEnded && !runtime.myEliminated;
    if (!canAct) return;
    const { x, y } = toCanvasPixels(event);
    const tileX = Math.floor(runtime.view.x + x / runtime.view.scale);
    const tileY = Math.floor(runtime.view.y + y / runtime.view.scale);
    if (!runtime.map.inBounds(tileX, tileY)) return;
    radial = { tileX, tileY, owner: runtime.owner[runtime.map.ref(tileX, tileY)], level: "root" };
    ui.radialMenu.style.left = `${event.clientX}px`;
    ui.radialMenu.style.top = `${event.clientY}px`;
    ui.radialMenu.classList.remove("hidden");
    renderRadialRoot();
  });

  // Dismiss the radial menu on any click elsewhere — the map canvas handles
  // its own dismissal (so the same click that closes it doesn't also fire an
  // expand), and clicks on the menu's own buttons are handled by their click
  // listeners, so both are excluded here.
  document.addEventListener("pointerdown", (event) => {
    if (!radial) return;
    const target = event.target;
    if (target === ui.mapCanvas) return;
    if (target instanceof Node && ui.radialMenu.contains(target)) return;
    closeRadialMenu();
  });

  // Drag-to-pan, with a small movement threshold separating a pan from a click
  // so a stationary press still registers as an expand command.
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;

  ui.mapCanvas.addEventListener("pointerdown", (event) => {
    // Only the primary (left) button drives pan/expand; the right button is
    // reserved for the radial menu's own `contextmenu` handler below.
    if (event.button !== 0) return;
    if (closeRadialMenu()) return;
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

  // Track the hovered tile at all times (not just while dragging) so build
  // mode can draw a ghost preview of where the structure would land —
  // OpenFront's ghost-build outline.
  ui.mapCanvas.addEventListener("pointermove", (event) => {
    if (!runtime.map) return;
    const { x, y } = toCanvasPixels(event);
    runtime.hoverTileX = Math.floor(runtime.view.x + x / runtime.view.scale);
    runtime.hoverTileY = Math.floor(runtime.view.y + y / runtime.view.scale);
  });
  ui.mapCanvas.addEventListener("pointerleave", () => {
    runtime.hoverTileX = null;
    runtime.hoverTileY = null;
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (moved || !runtime.map || runtime.matchEnded || runtime.myEliminated) return;

    const { x, y } = toCanvasPixels(event);
    const tileX = Math.floor(runtime.view.x + x / runtime.view.scale);
    const tileY = Math.floor(runtime.view.y + y / runtime.view.scale);
    if (tileX < 0 || tileY < 0 || tileX >= runtime.map.width || tileY >= runtime.map.height) return;

    // During the start phase every click (re)places your spawn: the first founds
    // your nation and each later one relocates it, so you can move your start
    // position freely until the countdown ends.
    if (runtime.phase === "spawn") {
      sendSelectSpawn(tileX, tileY);
      runtime.clickRipples.push({ x: tileX, y: tileY, color: "rgba(255,255,255,0.9)", start: performance.now() });
      sfx.click();
      setStatus(ui, runtime.spawned ? `Moving spawn to (${tileX}, ${tileY})…` : `Founding at (${tileX}, ${tileY})…`);
      return;
    }

    // Game phase. We're normally seated already (auto-seated if we never picked),
    // but in a session with no start phase the first click still founds us.
    if (!runtime.spawned) {
      sendSelectSpawn(tileX, tileY);
      runtime.clickRipples.push({ x: tileX, y: tileY, color: "rgba(255,255,255,0.9)", start: performance.now() });
      sfx.click();
      setStatus(ui, `Founding at (${tileX}, ${tileY})…`);
      return;
    }

    // Nuke mode takes priority over build mode (they're mutually exclusive
    // anyway) — a click launches the armed warhead at the clicked tile.
    if (runtime.nukeMode) {
      const kind = runtime.nukeMode;
      sendNuke(tileX, tileY, kind);
      runtime.clickRipples.push({ x: tileX, y: tileY, color: "rgba(255,120,40,0.9)", start: performance.now() });
      sfx.nukeLaunch();
      runtime.nukeMode = null;
      refreshWeaponsMenu();
      setStatus(ui, `${NUKE_DEFS[kind].name} launched at (${tileX}, ${tileY}).`);
      return;
    }

    // In build mode a click places the selected structure instead of expanding.
    if (runtime.buildMode) {
      const def = BUILDING_DEFS[runtime.buildMode];
      sendBuild(tileX, tileY, runtime.buildMode);
      runtime.clickRipples.push({ x: tileX, y: tileY, color: runtime.myColor, start: performance.now() });
      sfx.click();
      setStatus(ui, `Building ${def.name} at (${tileX}, ${tileY})…`);
      return;
    }

    const percent = Number(ui.attackPercentInput.value);
    const mode = runtime.expandMode;
    sendExpand(tileX, tileY, percent, mode);
    runtime.expandMode = "auto";
    runtime.clickRipples.push({ x: tileX, y: tileY, color: runtime.myColor, start: performance.now() });
    sfx.click();
    const routeLabel = mode === "sea" ? " by boat" : mode === "land" ? " by land" : "";
    setStatus(ui, `Expanding toward (${tileX}, ${tileY})${routeLabel} with ${percent}% of pool.`);
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

  // ---- Keyboard shortcuts (OpenFront-style) --------------------------------

  /** Owner id of the tile currently under the cursor, or null off-canvas/before terrain loads. */
  const hoveredOwner = (): number | null => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner || runtime.hoverTileX === null || runtime.hoverTileY === null) return null;
    if (!map.inBounds(runtime.hoverTileX, runtime.hoverTileY)) return null;
    return owner[map.ref(runtime.hoverTileX, runtime.hoverTileY)];
  };

  const playerName = (id: number): string => runtime.players.find((p) => p.playerId === id)?.name ?? `Player ${id}`;

  /** K hotkey: propose an alliance with whoever's territory is under the cursor. */
  const proposeAllianceAtCursor = (): void => {
    const target = hoveredOwner();
    if (target === null || target === 0 || target === runtime.myPlayerId) {
      setStatus(ui, "Hover a rival's territory, then press K to propose an alliance.");
      return;
    }
    const { allies, outgoing } = diplomacyState();
    if (allies.has(target)) { setStatus(ui, `Already allied with ${playerName(target)}.`); return; }
    if (outgoing.has(target)) { setStatus(ui, `Already offered an alliance to ${playerName(target)}.`); return; }
    sendAllyPropose(target);
    setStatus(ui, `Alliance offered to ${playerName(target)}.`);
  };

  /** L hotkey: break the alliance with whoever's territory is under the cursor. */
  const breakAllianceAtCursor = (): void => {
    const target = hoveredOwner();
    if (target === null || target === 0) {
      setStatus(ui, "Hover an ally's territory, then press L to break the alliance.");
      return;
    }
    const { allies } = diplomacyState();
    if (!allies.has(target)) { setStatus(ui, `Not allied with ${playerName(target)}.`); return; }
    sendAllyBreak(target);
    setStatus(ui, `Alliance with ${playerName(target)} broken.`);
  };

  /**
   * Shift+R hotkey: expand toward whoever last attacked us — OpenFront's
   * "retaliate". Scans the owner raster for any tile the attacker still
   * holds (a one-off O(map size) scan on a rare, user-triggered keypress,
   * not a per-frame cost) since the client has no per-player tile index.
   */
  const retaliate = (): void => {
    const map = runtime.map;
    const owner = runtime.owner;
    if (!map || !owner || runtime.matchEnded || runtime.myEliminated || !runtime.spawned) return;
    const attackerId = runtime.lastAttackedBy;
    if (!attackerId) { setStatus(ui, "No one has attacked you yet."); return; }
    let ref = -1;
    for (let i = 0; i < owner.length; i += 1) {
      if (owner[i] === attackerId) { ref = i; break; }
    }
    if (ref < 0) { setStatus(ui, `${playerName(attackerId)} no longer holds any territory.`); return; }
    const tx = map.x(ref);
    const ty = map.y(ref);
    const percent = Number(ui.attackPercentInput.value);
    sendExpand(tx, ty, percent);
    runtime.clickRipples.push({ x: tx, y: ty, color: runtime.myColor, start: performance.now() });
    sfx.click();
    setStatus(ui, `Retaliating against ${playerName(attackerId)} with ${percent}% of pool.`);
  };

  /** Zoom about the viewport centre, mirroring the wheel-zoom anchoring. */
  const zoomBy = (factor: number): void => {
    if (!runtime.map) return;
    const cx = ui.mapCanvas.width / 2;
    const cy = ui.mapCanvas.height / 2;
    const tileX = runtime.view.x + cx / runtime.view.scale;
    const tileY = runtime.view.y + cy / runtime.view.scale;
    runtime.view.scale *= factor;
    clampView();
    runtime.view.x = tileX - cx / runtime.view.scale;
    runtime.view.y = tileY - cy / runtime.view.scale;
    clampView();
  };

  /** Pan the view by a fraction of the current viewport (for WASD/arrow keys). */
  const panByFraction = (fx: number, fy: number): void => {
    if (!runtime.map) return;
    runtime.view.x += (ui.mapCanvas.width / runtime.view.scale) * fx;
    runtime.view.y += (ui.mapCanvas.height / runtime.view.scale) * fy;
    clampView();
  };

  /** Re-centre the camera on our home (spawn) tile, keeping the current zoom. */
  const centerCamera = (): void => {
    if (!runtime.map) return;
    runtime.view.x = runtime.spawnX - ui.mapCanvas.width / runtime.view.scale / 2;
    runtime.view.y = runtime.spawnY - ui.mapCanvas.height / runtime.view.scale / 2;
    clampView();
  };

  /** Nudge the attack-ratio slider by `delta` percent, clamped to its own range. */
  const nudgeAttackRatio = (delta: number): void => {
    const lo = Number(ui.attackPercentInput.min) || 1;
    const hi = Number(ui.attackPercentInput.max) || 100;
    const next = Math.max(lo, Math.min(hi, Number(ui.attackPercentInput.value) + delta));
    ui.attackPercentInput.value = String(next);
    ui.attackPercentOutput.textContent = `${next}%`;
  };

  window.addEventListener("keydown", (event) => {
    // Never hijack keys while the user is typing in a field.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // 1..0 select/toggle a buildable/launchable item — OpenFront binds every
    // structure and weapon across the digit row. Building types fill 1..N
    // first (menu order); any digits left over continue into the weapon
    // kinds (so with 7 building types, 8/9/0 arm Atom/Hydrogen/MIRV).
    if (/^[0-9]$/.test(event.key)) {
      const slot = event.key === "0" ? 9 : Number(event.key) - 1;
      if (slot < BUILDING_TYPES.length) {
        toggleBuildMode(BUILDING_TYPES[slot]);
        event.preventDefault();
        return;
      }
      const weaponIndex = slot - BUILDING_TYPES.length;
      if (weaponIndex < NUKE_KINDS.length) {
        toggleNukeMode(NUKE_KINDS[weaponIndex]);
        event.preventDefault();
        return;
      }
    }

    let handled = true;
    const panStep = 0.18;
    switch (event.key.toLowerCase()) {
      case "escape":
        toggleBuildMode(null);
        if (runtime.nukeMode) toggleNukeMode(runtime.nukeMode);
        runtime.expandMode = "auto";
        closeRadialMenu();
        break;
      case "t": nudgeAttackRatio(-10); break; // OpenFront: attack ratio down
      case "y": nudgeAttackRatio(10); break; //  and up
      case "b": toggleExpandMode("sea"); break; // OpenFront: force a boat attack
      case "g": toggleExpandMode("land"); break; //          force a ground attack
      case "k": proposeAllianceAtCursor(); break; // OpenFront: request alliance
      case "l": breakAllianceAtCursor(); break; //             break alliance
      case "r": if (event.shiftKey) retaliate(); else handled = false; break; // Shift+R: retaliate
      case " ": runtime.showTerrainOnly = !runtime.showTerrainOnly; break; // alt terrain view
      case "m": runtime.showCoordinateGrid = !runtime.showCoordinateGrid; break; // coordinate grid
      case "q": zoomBy(1 / 1.2); break; // zoom out
      case "e": zoomBy(1.2); break; //     zoom in
      case "c": centerCamera(); break; // centre on home
      case "w": case "arrowup": panByFraction(0, -panStep); break;
      case "s": case "arrowdown": panByFraction(0, panStep); break;
      case "a": case "arrowleft": panByFraction(-panStep, 0); break;
      case "d": case "arrowright": panByFraction(panStep, 0); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  });

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

  // Diplomacy: one delegated handler for the leaderboard's per-rival alliance
  // buttons (the rows are rebuilt every snapshot, so a delegated listener stays
  // valid across re-renders). Each button carries the counterparty's player id.
  ui.leaderboard.addEventListener("click", (event) => {
    const node = event.target as HTMLElement | null;
    // Column-header clicks re-sort the standings.
    const sortBtn = node?.closest<HTMLButtonElement>("button[data-sort]");
    if (sortBtn) {
      setLeaderboardSort(sortBtn.getAttribute("data-sort") as LeaderboardSortKey);
      return;
    }
    const btn = node?.closest<HTMLButtonElement>(
      "button[data-ally-propose], button[data-ally-accept], button[data-ally-decline], button[data-ally-break], button[data-ally-renew]",
    );
    if (!btn || btn.disabled) return;
    const propose = btn.getAttribute("data-ally-propose");
    const accept = btn.getAttribute("data-ally-accept");
    const decline = btn.getAttribute("data-ally-decline");
    const broke = btn.getAttribute("data-ally-break");
    const renew = btn.getAttribute("data-ally-renew");
    if (propose !== null) {
      sendAllyPropose(Number(propose));
      setStatus(ui, "Alliance offer sent.");
    } else if (accept !== null) {
      sendAllyRespond(Number(accept), true);
      setStatus(ui, "Alliance accepted.");
    } else if (decline !== null) {
      sendAllyRespond(Number(decline), false);
      setStatus(ui, "Alliance offer declined.");
    } else if (broke !== null) {
      sendAllyBreak(Number(broke));
      setStatus(ui, "Alliance broken.");
    } else if (renew !== null) {
      sendAllyRenew(Number(renew));
      setStatus(ui, "Renewal vote sent — the pact extends when your ally agrees.");
    }
  });

  // Lay out the build menu once and seed its initial (disabled, pre-spawn) state.
  renderBuildMenuOnce();
  refreshBuildMenu();
  renderWeaponsMenuOnce();
  refreshWeaponsMenu();

  // Match the canvas backing store to its rendered size now and whenever the
  // window changes, so the map fills the available play area at all times.
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  requestAnimationFrame(renderFrame);
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
