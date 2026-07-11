import { DEFAULT_MAP_CHOICE_ID, MAP_CHOICES } from "../Core/mapCatalog.js";
import {
  LOBBY_CODE_PATTERN,
  PLAYER_NAME_PATTERN,
  RASTER_DIFFICULTIES,
  type LobbyDirectoryEntry,
  type LobbyDirectoryResponse,
  type RasterDifficulty,
} from "../Core/messages.js";
import { CRESTS, DEFAULT_CREST, isValidCrest } from "../Core/identity.js";
import { decodeCustomMapFile } from "../Core/customMap.js";
import { getUiElements } from "./dom.js";
import { connectLobby, type LobbyClient } from "./lobby.js";
import { initMapEditor } from "./mapEditor.js";
import { fetchPrebuiltMap } from "./mapFetch.js";
import { terrainColor } from "./rasterPalette.js";
import { loadRunHistory } from "./runHistory.js";
import { startRasterClient } from "./rasterClient.js";
import { initSettings, initFrameControls } from "./settings.js";

/**
 * The multiplayer-first homepage: identity (name + crest) up top, the live
 * directory of open lobbies as the dominant element, and a slim rail with
 * Create-lobby / Quick-play / code-join plus the local record. Creating a
 * lobby (or practicing vs. AI) runs through a two-step wizard — settings,
 * then the battlefield: a catalogue Earth, a freshly painted editor map, or
 * an imported .ccmap file.
 */

const ui = getUiElements();
initSettings();
initFrameControls();

// ---------------------------------------------------------------------------
// Identity: display name + crest, persisted locally. Set once, used everywhere
// (lobby list, waiting room, in-game nameplates).
// ---------------------------------------------------------------------------
const IDENTITY_KEY = "cnc-identity";

interface StoredIdentity {
  name?: string;
  crest?: string;
}

const loadIdentity = (): StoredIdentity => {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return {};
    const { name, crest } = parsed as Record<string, unknown>;
    return {
      ...(typeof name === "string" && PLAYER_NAME_PATTERN.test(name) ? { name } : {}),
      ...(isValidCrest(crest) ? { crest } : {}),
    };
  } catch {
    return {};
  }
};

const saveIdentity = (identity: StoredIdentity): void => {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    // Storage may be unavailable (private mode); identity just won't persist.
  }
};

const nameInput = document.querySelector<HTMLInputElement>("#playerNameInput");
const crestButton = document.querySelector<HTMLButtonElement>("#crestButton");
const crestPicker = document.querySelector<HTMLDivElement>("#crestPicker");

const identity = loadIdentity();
if (nameInput && identity.name) nameInput.value = identity.name;
if (crestButton) crestButton.textContent = identity.crest ?? DEFAULT_CREST;

/** The current (validated) display name, or undefined when empty/invalid. */
const playerName = (): string | undefined => {
  const raw = nameInput?.value.trim() ?? "";
  return PLAYER_NAME_PATTERN.test(raw) ? raw : undefined;
};

/** The current crest (always valid — the picker only offers curated ones). */
const playerCrest = (): string => {
  const raw = crestButton?.textContent?.trim();
  return isValidCrest(raw) ? raw : DEFAULT_CREST;
};

nameInput?.addEventListener("change", () => {
  saveIdentity({ name: playerName(), crest: playerCrest() });
});

if (crestPicker && crestButton) {
  crestPicker.innerHTML = CRESTS.map(
    (crest) => `<button type="button" data-crest="${crest}">${crest}</button>`,
  ).join("");
  crestButton.addEventListener("click", () => crestPicker.classList.toggle("hidden"));
  for (const option of crestPicker.querySelectorAll<HTMLButtonElement>("[data-crest]")) {
    option.addEventListener("click", () => {
      crestButton.textContent = option.getAttribute("data-crest") ?? DEFAULT_CREST;
      crestPicker.classList.add("hidden");
      saveIdentity({ name: playerName(), crest: playerCrest() });
    });
  }
  // Clicking anywhere else closes the picker.
  document.addEventListener("pointerdown", (event) => {
    if (crestPicker.classList.contains("hidden")) return;
    const target = event.target as Node;
    if (!crestPicker.contains(target) && target !== crestButton) crestPicker.classList.add("hidden");
  });
}

// ---------------------------------------------------------------------------
// Living-world backdrop: paint the real Earth terrain into the menu canvas.
// ---------------------------------------------------------------------------
const menuWorld = document.querySelector<HTMLCanvasElement>("#menuWorld");
if (menuWorld) {
  void fetchPrebuiltMap("earth-standard")
    .then(({ map }) => {
      menuWorld.width = map.width;
      menuWorld.height = map.height;
      const context = menuWorld.getContext("2d");
      if (!context) return;
      const image = context.createImageData(map.width, map.height);
      for (let i = 0; i < map.size; i += 1) {
        const color = terrainColor(map.terrain[i]);
        const o = i * 4;
        image.data[o] = color.r;
        image.data[o + 1] = color.g;
        image.data[o + 2] = color.b;
        image.data[o + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    })
    .catch(() => {
      // The backdrop is decoration — a failed fetch just leaves the dark tint.
    });
}

// ---------------------------------------------------------------------------
// Wire-mode override, mainly for testing multiplayer paths: `?net=lockstep`
// or `?net=ws`. Default remains the local solo Web Worker for practice runs.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const netParam = params.get("net");
const transport = netParam === "lockstep" ? "lockstep" as const
  : netParam === "ws" ? "websocket" as const
  : undefined;

// ---------------------------------------------------------------------------
// Local record (run history already tracked per match end).
// ---------------------------------------------------------------------------
const recordStats = document.querySelector<HTMLDivElement>("#recordStats");
if (recordStats) {
  const history = loadRunHistory(localStorage);
  const wins = history.filter((r) => r.won).length;
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].won; i -= 1) streak += 1;
  const peak = history.reduce((max, r) => Math.max(max, r.peakTiles), 0);
  const stat = (value: string, label: string): string =>
    `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  recordStats.innerHTML =
    stat(String(history.length), "matches") +
    stat(String(wins), "wins") +
    stat(String(streak), "win streak") +
    stat(peak >= 1000 ? `${(peak / 1000).toFixed(1)}k` : String(peak), "peak tiles");
}

// ---------------------------------------------------------------------------
// The live lobby directory: poll while the homepage is visible.
// ---------------------------------------------------------------------------
const lobbyRows = document.querySelector<HTMLDivElement>("#lobbyRows");
const lobbyCount = document.querySelector<HTMLSpanElement>("#lobbyCount");
const liveInfo = document.querySelector<HTMLDivElement>("#liveInfo");
const homeMain = document.querySelector<HTMLDivElement>("#homeMain");
const menuStatus = document.querySelector<HTMLParagraphElement>("#menuStatus");

const setMenuStatus = (text: string): void => {
  if (menuStatus) menuStatus.textContent = text;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let latestLobbies: LobbyDirectoryEntry[] = [];

const renderLobbies = (): void => {
  if (!lobbyRows) return;
  if (latestLobbies.length === 0) {
    lobbyRows.innerHTML =
      `<div class="lob-empty">No open lobbies right now — create one and invite the world, ` +
      `or hit Quick play.</div>`;
    if (lobbyCount) lobbyCount.textContent = "";
    return;
  }
  if (lobbyCount) {
    lobbyCount.textContent = `${latestLobbies.length} waiting for players`;
  }
  lobbyRows.innerHTML = latestLobbies
    .map((lobby) => {
      const host = `${lobby.hostCrest ? `${lobby.hostCrest} ` : ""}${escapeHtml(lobby.hostName)}`;
      const bots = lobby.fieldSize !== undefined ? `${lobby.fieldSize} bots` : "auto bots";
      const tag = lobby.customMap ? `<span class="lob-tag">CUSTOM MAP</span>` : "";
      return (
        `<div class="lob-row">` +
        `<div><div class="lob-title">${escapeHtml(lobby.lobbyName)} ${tag}</div>` +
        `<div class="lob-sub">Hosted by ${host} · ${escapeHtml(lobby.mapName)} · ${lobby.difficulty} · ${bots}</div></div>` +
        `<div class="lob-seats"><b>${lobby.members} / ${lobby.maxMembers}</b><span>players</span></div>` +
        `<button class="menu-button primary lob-join" type="button" data-join="${lobby.code}">Join</button>` +
        `</div>`
      );
    })
    .join("");
  for (const button of lobbyRows.querySelectorAll<HTMLButtonElement>("[data-join]")) {
    button.addEventListener("click", () => {
      const code = button.getAttribute("data-join");
      if (code) joinByCode(code);
    });
  }
};

const refreshLobbies = async (): Promise<void> => {
  try {
    const response = await fetch("/api/lobbies");
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as LobbyDirectoryResponse;
    latestLobbies = data.lobbies;
    if (liveInfo) {
      liveInfo.textContent =
        `${data.playersOnline} online · ${data.matchesRunning} ${data.matchesRunning === 1 ? "match" : "matches"} running`;
    }
    renderLobbies();
  } catch {
    if (liveInfo) liveInfo.textContent = "offline";
  }
};

void refreshLobbies();
setInterval(() => {
  // Poll only while the homepage is actually on screen.
  if (document.visibilityState !== "visible") return;
  if (ui.menuOverlay.classList.contains("hidden")) return;
  void refreshLobbies();
}, 3000);

// ---------------------------------------------------------------------------
// Waiting room (shared by create/join/quick play).
// ---------------------------------------------------------------------------
const lobbyEls = {
  panel: document.querySelector<HTMLDivElement>("#lobbyPanel"),
  codeBadge: document.querySelector<HTMLSpanElement>("#lobbyCode"),
  meta: document.querySelector<HTMLDivElement>("#lobbyMeta"),
  share: document.querySelector<HTMLDivElement>("#lobbyShare"),
  members: document.querySelector<HTMLUListElement>("#lobbyMembers"),
  start: document.querySelector<HTMLButtonElement>("#lobbyStartButton"),
  leave: document.querySelector<HTMLButtonElement>("#lobbyLeaveButton"),
  status: document.querySelector<HTMLParagraphElement>("#lobbyStatus"),
  codeInput: document.querySelector<HTMLInputElement>("#lobbyCodeInput"),
  join: document.querySelector<HTMLButtonElement>("#joinLobbyButton"),
};

let lobby: LobbyClient | null = null;

const lobbyStatus = (text: string): void => {
  if (lobbyEls.status) lobbyEls.status.textContent = text;
};

const showWaitingRoom = (show: boolean): void => {
  lobbyEls.panel?.classList.toggle("hidden", !show);
  homeMain?.classList.toggle("hidden", show);
};

const resetLobbyUi = (): void => {
  lobby?.dispose();
  lobby = null;
  showWaitingRoom(false);
  void refreshLobbies();
};

const openLobby = (action: (client: LobbyClient) => void): void => {
  if (lobby) return; // already in a room
  setMenuStatus("");
  const client = connectLobby({
    onState(state) {
      showWaitingRoom(true);
      if (lobbyEls.codeBadge) lobbyEls.codeBadge.textContent = state.code;
      if (lobbyEls.meta) {
        lobbyEls.meta.textContent =
          `${state.lobbyName} · ${state.mapName} · ${state.difficulty} · ` +
          `${state.members.length} player${state.members.length === 1 ? "" : "s"}`;
      }
      if (lobbyEls.share) {
        lobbyEls.share.textContent = `Invite link: ${window.location.origin}/?join=${state.code}`;
      }
      if (lobbyEls.members) {
        lobbyEls.members.replaceChildren(
          ...state.members.map((member) => {
            const li = document.createElement("li");
            li.textContent = `${member.crest ? `${member.crest} ` : ""}${member.name}`;
            if (member.isHost) li.insertAdjacentHTML("beforeend", `<span class="host-tag">HOST</span>`);
            if (member.you) li.insertAdjacentHTML("beforeend", `<span class="you-tag">you</span>`);
            return li;
          }),
        );
      }
      lobbyEls.start?.classList.toggle("hidden", !state.youAreHost);
      lobbyStatus(state.youAreHost
        ? "Share the code or link — start when everyone is in (AI fills the field)."
        : "Waiting for the host to start…");
    },
    onError(message, fatal) {
      lobbyStatus(message);
      setMenuStatus(message);
      if (fatal) resetLobbyUi();
    },
    onMatchStart(attach) {
      startRasterClient(ui, {
        mapId: DEFAULT_MAP_CHOICE_ID,
        difficulty: "medium",
        attach,
      });
    },
    onClosed() {
      setMenuStatus("Connection lost.");
      resetLobbyUi();
    },
  });
  lobby = client;
  action(client);
};

const joinByCode = (code: string): void => {
  openLobby((client) => client.join(code.toUpperCase(), playerName(), playerCrest()));
};

lobbyEls.join?.addEventListener("click", () => {
  const code = lobbyEls.codeInput?.value.trim().toUpperCase() ?? "";
  if (!LOBBY_CODE_PATTERN.test(code)) {
    setMenuStatus("Enter the 6-character lobby code.");
    return;
  }
  joinByCode(code);
});

lobbyEls.leave?.addEventListener("click", () => {
  lobby?.leave();
  resetLobbyUi();
  lobbyStatus("");
});

lobbyEls.start?.addEventListener("click", () => lobby?.start());

// Invite links: /?join=CODE drops straight into that waiting room.
const joinParam = params.get("join")?.toUpperCase();
if (joinParam && LOBBY_CODE_PATTERN.test(joinParam)) {
  joinByCode(joinParam);
}

// ---------------------------------------------------------------------------
// Quick play: join the fullest open lobby, otherwise open one for the world.
// ---------------------------------------------------------------------------
document.querySelector<HTMLButtonElement>("#quickPlayButton")?.addEventListener("click", () => {
  const open = [...latestLobbies].sort((a, b) => b.members - a.members).find((l) => l.members < l.maxMembers);
  if (open) {
    joinByCode(open.code);
    return;
  }
  openLobby((client) =>
    client.create({
      mapId: DEFAULT_MAP_CHOICE_ID,
      difficulty: "medium",
      name: playerName(),
      crest: playerCrest(),
      lobbyName: "Quick match",
    }),
  );
  setMenuStatus("No open lobby right now — opened one for you. Start any time; AI fills the field.");
});

// ---------------------------------------------------------------------------
// The create-lobby / practice wizard: settings → battlefield.
// ---------------------------------------------------------------------------
const wizard = {
  veil: document.querySelector<HTMLDivElement>("#wizardVeil"),
  title: document.querySelector<HTMLHeadingElement>("#wizardTitle"),
  steps: document.querySelector<HTMLDivElement>("#wizardSteps"),
  step1: document.querySelector<HTMLDivElement>("#wizardStep1"),
  step2: document.querySelector<HTMLDivElement>("#wizardStep2"),
  lobbyNameRow: document.querySelector<HTMLDivElement>("#wizardLobbyNameRow"),
  lobbyName: document.querySelector<HTMLInputElement>("#wizardLobbyName"),
  difficulty: document.querySelector<HTMLDivElement>("#wizardDifficulty"),
  mapCards: document.querySelector<HTMLDivElement>("#wizardMapCards"),
  importFile: document.querySelector<HTMLInputElement>("#wizardImportFile"),
  status: document.querySelector<HTMLParagraphElement>("#wizardStatus"),
  back: document.querySelector<HTMLButtonElement>("#wizardBack"),
  next: document.querySelector<HTMLButtonElement>("#wizardNext"),
};
const editorVeil = document.querySelector<HTMLDivElement>("#editorVeil");
const editorPlayButton = document.querySelector<HTMLButtonElement>("#editorPlayButton");

type WizardMode = "lobby" | "solo";
let wizardMode: WizardMode = "lobby";
let wizardStep: 1 | 2 = 1;
let wizardDifficultyChoice: RasterDifficulty = "medium";

const fieldSizeInput = document.querySelector<HTMLInputElement>("#fieldSizeInput");
const fieldSizeOutput = document.querySelector<HTMLOutputElement>("#fieldSizeOutput");
const renderFieldSize = (): void => {
  if (!fieldSizeInput || !fieldSizeOutput) return;
  const n = Number(fieldSizeInput.value);
  fieldSizeOutput.textContent = n === 0 ? "Auto (scaled to map)" : `${n} opponents`;
};
fieldSizeInput?.addEventListener("input", renderFieldSize);
renderFieldSize();

const wizardFieldSize = (): number | undefined => {
  const raw = fieldSizeInput ? Number(fieldSizeInput.value) : 0;
  return raw > 0 ? raw : undefined;
};

const setWizardStatus = (text: string): void => {
  if (wizard.status) wizard.status.textContent = text;
};

const renderWizardChrome = (): void => {
  if (wizard.title) wizard.title.textContent = wizardMode === "lobby" ? "Create lobby" : "Practice vs. AI";
  if (wizard.steps) {
    wizard.steps.innerHTML = wizardStep === 1
      ? `Step <b>1</b> of 2 — <b>Settings</b> · Battlefield`
      : `Step <b>2</b> of 2 — Settings ✓ · <b>Battlefield</b>`;
  }
  wizard.step1?.classList.toggle("hidden", wizardStep !== 1);
  wizard.step2?.classList.toggle("hidden", wizardStep !== 2);
  wizard.lobbyNameRow?.classList.toggle("hidden", wizardMode !== "lobby");
  if (wizard.back) wizard.back.textContent = wizardStep === 1 ? "Cancel" : "← Back";
  if (wizard.next) wizard.next.classList.toggle("hidden", wizardStep === 2);
};

const openWizard = (mode: WizardMode): void => {
  wizardMode = mode;
  wizardStep = 1;
  setWizardStatus("");
  renderWizardChrome();
  wizard.veil?.classList.remove("hidden");
};

const closeWizard = (): void => {
  wizard.veil?.classList.add("hidden");
  editorVeil?.classList.add("hidden");
};

/** Launch the chosen battlefield: a lobby for the world, or a solo practice run. */
const finishWizard = (mapId: string | undefined, customMap?: string): void => {
  closeWizard();
  if (wizardMode === "lobby") {
    openLobby((client) =>
      client.create({
        mapId: mapId ?? DEFAULT_MAP_CHOICE_ID,
        difficulty: wizardDifficultyChoice,
        fieldSize: wizardFieldSize(),
        name: playerName(),
        crest: playerCrest(),
        lobbyName: wizard.lobbyName?.value.trim() || undefined,
        customMap,
      }),
    );
  } else {
    startRasterClient(ui, {
      mapId: mapId ?? DEFAULT_MAP_CHOICE_ID,
      difficulty: wizardDifficultyChoice,
      fieldSize: wizardFieldSize(),
      customMap,
      playerName: playerName(),
      crest: playerCrest(),
      ...(transport ? { transport } : {}),
    });
  }
};

// Difficulty chips.
if (wizard.difficulty) {
  wizard.difficulty.innerHTML = RASTER_DIFFICULTIES.map(
    (id) =>
      `<button type="button" data-difficulty="${id}" class="${id === wizardDifficultyChoice ? "selected" : ""}">${id}</button>`,
  ).join("");
  for (const chip of wizard.difficulty.querySelectorAll<HTMLButtonElement>("[data-difficulty]")) {
    chip.addEventListener("click", () => {
      const id = chip.getAttribute("data-difficulty") as RasterDifficulty | null;
      if (!id) return;
      wizardDifficultyChoice = id;
      for (const other of wizard.difficulty!.querySelectorAll("button")) {
        other.classList.toggle("selected", other === chip);
      }
    });
  }
}

/** Approx. tile count shown on a map card (mirrors the server's height formula). */
const estimateTiles = (mapSize: number): string => {
  const height = Math.round((mapSize * (136 / 360)) / 2) * 2;
  const tiles = mapSize * height;
  return tiles >= 1_000_000 ? `~${(tiles / 1_000_000).toFixed(1)}M tiles` : `~${Math.round(tiles / 1000)}k tiles`;
};

// Battlefield cards: the Earth catalogue plus paint/import.
if (wizard.mapCards) {
  const catalogue = MAP_CHOICES.map((choice) => {
    const tiles = choice.options.mapSize ? estimateTiles(choice.options.mapSize) : "";
    return (
      `<button class="perk-card" type="button" data-wizard-map="${choice.id}">` +
      `<h3>${choice.name}</h3><p>${choice.description}</p>` +
      (tiles ? `<div class="map-meta">${tiles}</div>` : "") +
      `</button>`
    );
  }).join("");
  wizard.mapCards.innerHTML =
    catalogue +
    `<button class="perk-card" type="button" data-wizard-paint><h3>🖌️ Paint your own</h3>` +
    `<p>Open the map editor and draw land, mountains and rivers.</p></button>` +
    `<button class="perk-card" type="button" data-wizard-import><h3>📂 Import .ccmap</h3>` +
    `<p>Load a downloaded map file — yours or a friend's.</p></button>`;

  for (const card of wizard.mapCards.querySelectorAll<HTMLButtonElement>("[data-wizard-map]")) {
    card.addEventListener("click", () => finishWizard(card.getAttribute("data-wizard-map") ?? undefined));
  }
  wizard.mapCards.querySelector<HTMLButtonElement>("[data-wizard-paint]")?.addEventListener("click", () => {
    wizard.veil?.classList.add("hidden");
    if (editorPlayButton) {
      editorPlayButton.textContent = wizardMode === "lobby" ? "Use this map" : "Play this map";
    }
    editorVeil?.classList.remove("hidden");
  });
  wizard.mapCards.querySelector<HTMLButtonElement>("[data-wizard-import]")?.addEventListener("click", () => {
    wizard.importFile?.click();
  });
}

wizard.importFile?.addEventListener("change", async () => {
  const file = wizard.importFile?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    // Validation happens in Core; a bad file throws with the reason.
    const data = decodeCustomMapFile(text);
    finishWizard(undefined, text);
    setMenuStatus(`Loaded "${data.name}".`);
  } catch (error) {
    setWizardStatus(error instanceof Error ? error.message : "Could not read that map file.");
  } finally {
    if (wizard.importFile) wizard.importFile.value = "";
  }
});

wizard.back?.addEventListener("click", () => {
  if (wizardStep === 2) {
    wizardStep = 1;
    renderWizardChrome();
  } else {
    closeWizard();
  }
});
wizard.next?.addEventListener("click", () => {
  wizardStep = 2;
  setWizardStatus("");
  renderWizardChrome();
});

document.querySelector<HTMLButtonElement>("#createLobbyButton")?.addEventListener("click", () => openWizard("lobby"));
document.querySelector<HTMLAnchorElement>("#practiceLink")?.addEventListener("click", () => openWizard("solo"));

// The editor's primary button hands the painted map back to the wizard flow.
initMapEditor({
  onPlay(customMap) {
    finishWizard(undefined, customMap);
  },
});
document.querySelector<HTMLButtonElement>("#editorBackButton")?.addEventListener("click", () => {
  editorVeil?.classList.add("hidden");
  wizard.veil?.classList.remove("hidden");
});
