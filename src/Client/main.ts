import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import { LOBBY_CODE_PATTERN, PLAYER_NAME_PATTERN, RASTER_DIFFICULTIES, type RasterDifficulty } from "../Core/messages.js";
import { getUiElements } from "./dom.js";
import { connectLobby, type LobbyClient } from "./lobby.js";
import { startRasterClient } from "./rasterClient.js";
import { initSettings, initFrameControls } from "./settings.js";

const ui = getUiElements();

// Wire the settings gear (event-log toggle, etc.) and the frame controls
// (fullscreen, leave) before the menu interactions.
initSettings();
initFrameControls();

// The player picks a map + difficulty in the main menu, then presses Start. Each
// card group is single-select (one stays highlighted); Start launches the run
// with whatever is currently selected.
let selectedMapId = DEFAULT_MAP_CHOICE_ID;
let selectedDifficulty: RasterDifficulty = "medium";

const DIFFICULTY_INFO: Record<RasterDifficulty, { name: string; description: string }> = {
  easy: { name: "Easy", description: "Fewer, more cautious rivals — room to find your feet." },
  medium: { name: "Medium", description: "A balanced field of opponents pressing at a steady pace." },
  hard: { name: "Hard", description: "A dense, aggressive crowd of nations fighting for every tile." },
  impossible: { name: "Impossible", description: "Bigger, faster, flawless nations that outgrow a human. Good luck." },
};

/**
 * Approx. tile count shown on a map card. Mirrors the server's height formula
 * (Earth's cropped 136° latitude band, rounded to an even height — see
 * `resolveHeightmapSize` in heightmapMaps) so the menu matches the real grid.
 */
const estimateTiles = (mapSize: number): string => {
  const height = Math.round((mapSize * (136 / 360)) / 2) * 2;
  const tiles = mapSize * height;
  if (tiles >= 1_000_000) return `~${(tiles / 1_000_000).toFixed(1)}M tiles`;
  return `~${Math.round(tiles / 1000)}k tiles`;
};

/** Split "Earth — Large" into a kicker ("Earth") and a prominent tier ("Large"). */
const splitMapName = (name: string): { kicker?: string; title: string } => {
  const parts = name.split(/\s*—\s*/);
  return parts.length > 1 ? { kicker: parts[0], title: parts.slice(1).join(" — ") } : { title: name };
};

const mapCards = document.querySelector<HTMLDivElement>("#mapCards");
if (mapCards) {
  // Build the map cards from the shared catalogue so the menu and the server
  // never drift on the set of selectable maps.
  mapCards.innerHTML = MAP_CHOICES.map((choice) => {
    const selected = choice.id === selectedMapId ? " selected" : "";
    const { kicker, title } = splitMapName(choice.name);
    const isDefault = choice.id === DEFAULT_MAP_CHOICE_ID;
    const tiles = choice.options.mapSize ? estimateTiles(choice.options.mapSize) : "";
    return (
      `<button class="perk-card map-card${selected}" type="button" data-map="${choice.id}" aria-pressed="${choice.id === selectedMapId}">` +
      `<div class="map-card-head">` +
      (kicker ? `<span class="map-kicker">${kicker}</span>` : "") +
      (isDefault ? `<span class="map-default">Default</span>` : "") +
      `</div>` +
      `<h3>${title}</h3><p>${choice.description}</p>` +
      (tiles ? `<div class="map-meta">${tiles}</div>` : "") +
      `</button>`
    );
  }).join("");

  for (const card of mapCards.querySelectorAll<HTMLButtonElement>("[data-map]")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-map");
      const choice = MAP_CHOICES.find((c) => c.id === id);
      if (!choice) return;
      selectedMapId = choice.id;
      for (const other of mapCards.querySelectorAll<HTMLButtonElement>(".map-card")) {
        const isSelected = other === card;
        other.classList.toggle("selected", isSelected);
        other.setAttribute("aria-pressed", String(isSelected));
      }
    });
  }
}

const difficultyCards = document.querySelector<HTMLDivElement>("#difficultyCards");
if (difficultyCards) {
  difficultyCards.innerHTML = RASTER_DIFFICULTIES.map((id) => {
    const info = DIFFICULTY_INFO[id];
    const selected = id === selectedDifficulty ? " selected" : "";
    return (
      `<button class="perk-card map-card${selected}" type="button" data-difficulty="${id}" aria-pressed="${id === selectedDifficulty}">` +
      `<h3>${info.name}</h3><p>${info.description}</p>` +
      `</button>`
    );
  }).join("");

  for (const card of difficultyCards.querySelectorAll<HTMLButtonElement>("[data-difficulty]")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-difficulty");
      const choice = RASTER_DIFFICULTIES.find((d) => d === id);
      if (!choice) return;
      selectedDifficulty = choice;
      for (const other of difficultyCards.querySelectorAll<HTMLButtonElement>(".map-card")) {
        const isSelected = other === card;
        other.classList.toggle("selected", isSelected);
        other.setAttribute("aria-pressed", String(isSelected));
      }
    });
  }
}

// AI-opponents field-size slider: 0 = "Auto" (server scales to the map), any
// other value seats exactly that many AI (bot-heavy split). Mirrors OpenFront's
// bots slider.
const fieldSizeInput = document.querySelector<HTMLInputElement>("#fieldSizeInput");
const fieldSizeOutput = document.querySelector<HTMLOutputElement>("#fieldSizeOutput");
const renderFieldSize = (): void => {
  if (!fieldSizeInput || !fieldSizeOutput) return;
  const n = Number(fieldSizeInput.value);
  fieldSizeOutput.textContent = n === 0 ? "Auto (scaled to map)" : `${n} opponents`;
};
fieldSizeInput?.addEventListener("input", renderFieldSize);
renderFieldSize();

// Start the run on the currently selected map + difficulty + field size.
const startButton = document.querySelector<HTMLButtonElement>("#startButton");
// Wire-mode override, mainly for testing the multiplayer paths against a real
// server: `?net=lockstep` joins in server-refereed lockstep (intents up, relay
// turns down, local replica sim — see `Core/lockstep.ts`); `?net=ws` uses the
// snapshot-streaming thin client. Default remains the local solo Web Worker.
const netParam = new URLSearchParams(window.location.search).get("net");
const transport = netParam === "lockstep" ? "lockstep" as const
  : netParam === "ws" ? "websocket" as const
  : undefined;

startButton?.addEventListener("click", () => {
  const raw = fieldSizeInput ? Number(fieldSizeInput.value) : 0;
  // 0 is the "Auto" sentinel → omit so the server auto-scales to the map.
  const fieldSize = raw > 0 ? raw : undefined;
  startRasterClient(ui, { mapId: selectedMapId, difficulty: selectedDifficulty, fieldSize, ...(transport ? { transport } : {}) });
});

// ---------------------------------------------------------------------------
// Multiplayer lobby: create a room with the currently selected map/difficulty
// (the host's menu selection IS the room's settings), or join one by code.
// When the host starts, the server hands every member into one shared
// lockstep match; the open socket + setup are passed straight to the game
// client (see `connectLobby`).
// ---------------------------------------------------------------------------
const lobbyEls = {
  form: document.querySelector<HTMLDivElement>("#lobbyForm"),
  name: document.querySelector<HTMLInputElement>("#playerNameInput"),
  code: document.querySelector<HTMLInputElement>("#lobbyCodeInput"),
  create: document.querySelector<HTMLButtonElement>("#createLobbyButton"),
  join: document.querySelector<HTMLButtonElement>("#joinLobbyButton"),
  panel: document.querySelector<HTMLDivElement>("#lobbyPanel"),
  codeBadge: document.querySelector<HTMLSpanElement>("#lobbyCode"),
  meta: document.querySelector<HTMLDivElement>("#lobbyMeta"),
  members: document.querySelector<HTMLUListElement>("#lobbyMembers"),
  start: document.querySelector<HTMLButtonElement>("#lobbyStartButton"),
  leave: document.querySelector<HTMLButtonElement>("#lobbyLeaveButton"),
  status: document.querySelector<HTMLParagraphElement>("#lobbyStatus"),
};

let lobby: LobbyClient | null = null;

const lobbyStatus = (text: string): void => {
  if (lobbyEls.status) lobbyEls.status.textContent = text;
};

const resetLobbyUi = (): void => {
  // Close any dangling socket too, or every failed attempt would leak one.
  lobby?.dispose();
  lobby = null;
  lobbyEls.panel?.classList.add("hidden");
  lobbyEls.form?.classList.remove("hidden");
};

const playerName = (): string | undefined => {
  const raw = lobbyEls.name?.value.trim() ?? "";
  return PLAYER_NAME_PATTERN.test(raw) ? raw : undefined;
};

const openLobby = (action: (client: LobbyClient) => void): void => {
  if (lobby) return; // already in a room
  const client = connectLobby({
    onState(state) {
      lobbyEls.form?.classList.add("hidden");
      lobbyEls.panel?.classList.remove("hidden");
      if (lobbyEls.codeBadge) lobbyEls.codeBadge.textContent = state.code;
      if (lobbyEls.meta) lobbyEls.meta.textContent = `${state.mapName} · ${state.difficulty} · ${state.members.length} player${state.members.length === 1 ? "" : "s"}`;
      if (lobbyEls.members) {
        lobbyEls.members.replaceChildren(...state.members.map((m) => {
          const li = document.createElement("li");
          li.textContent = m.name;
          if (m.isHost) li.insertAdjacentHTML("beforeend", `<span class="host-tag">HOST</span>`);
          if (m.you) li.insertAdjacentHTML("beforeend", `<span class="you-tag">you</span>`);
          return li;
        }));
      }
      lobbyEls.start?.classList.toggle("hidden", !state.youAreHost);
      lobbyStatus(state.youAreHost
        ? "Share the code — start when everyone is in."
        : "Waiting for the host to start…");
    },
    onError(message, fatal) {
      lobbyStatus(message);
      // A fatal error means this connection holds no room (bad code, full
      // room, host left) — drop back to the form so Create/Join work again.
      if (fatal) resetLobbyUi();
    },
    onMatchStart(attach) {
      // Hand the socket to the game client; the lobby UI is done.
      startRasterClient(ui, { mapId: selectedMapId, difficulty: selectedDifficulty, attach });
    },
    onClosed() {
      lobbyStatus("Connection lost.");
      resetLobbyUi();
    },
  });
  lobby = client;
  action(client);
};

lobbyEls.create?.addEventListener("click", () => {
  openLobby((client) => {
    const raw = fieldSizeInput ? Number(fieldSizeInput.value) : 0;
    client.create({
      mapId: selectedMapId,
      difficulty: selectedDifficulty,
      ...(raw > 0 ? { fieldSize: raw } : {}),
      ...(playerName() ? { name: playerName() } : {}),
    });
  });
});

lobbyEls.join?.addEventListener("click", () => {
  const code = lobbyEls.code?.value.trim().toUpperCase() ?? "";
  if (!LOBBY_CODE_PATTERN.test(code)) {
    lobbyStatus("Enter the 6-character lobby code.");
    return;
  }
  openLobby((client) => client.join(code, playerName()));
});

lobbyEls.start?.addEventListener("click", () => {
  lobby?.start();
  lobbyStatus("Starting…");
});

lobbyEls.leave?.addEventListener("click", () => {
  lobby?.leave();
  resetLobbyUi();
  lobbyStatus("");
});
