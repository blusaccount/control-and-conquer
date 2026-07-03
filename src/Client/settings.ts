/**
 * Lightweight client-side settings, persisted in localStorage.
 *
 * The HUD ships with a minimal default: secondary panels that clutter the map
 * are hidden until the player opts into them from the gear menu. The event log
 * (captures/eliminations feed) is off by default and toggled on here; sound
 * effects are on by default and toggled off here.
 */

import { setSoundEnabled } from "./sound.js";

const STORAGE_PREFIX = "cnc.settings.";

/** Read a boolean setting, falling back to `fallback` when unset or unreadable. */
export const readBoolSetting = (key: string, fallback: boolean): boolean => readBool(key, fallback);

/** Read a boolean setting, falling back to `fallback` when unset or unreadable. */
const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
};

/** Persist a boolean setting; storage failures (private mode, quota) are ignored. */
const writeBool = (key: string, value: boolean): void => {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, value ? "1" : "0");
  } catch {
    /* best-effort persistence only */
  }
};

/**
 * Wire up the settings gear and its panel. Safe to call once on page load even
 * if some elements are missing — each lookup no-ops independently.
 */
export const initSettings = (): void => {
  const button = document.querySelector<HTMLButtonElement>("#settingsButton");
  const panel = document.querySelector<HTMLDivElement>("#settingsPanel");
  const eventsPanel = document.querySelector<HTMLDivElement>("#eventsPanel");
  const toggleEvents = document.querySelector<HTMLInputElement>("#toggleEvents");
  const toggleSound = document.querySelector<HTMLInputElement>("#toggleSound");
  const toggleLeftClickMenu = document.querySelector<HTMLInputElement>("#toggleLeftClickMenu");

  // Event log: hidden by default, revealed when the player turns it on.
  const applyEvents = (show: boolean): void => {
    eventsPanel?.classList.toggle("hidden", !show);
  };
  if (toggleEvents) {
    const showEvents = readBool("showEvents", false);
    toggleEvents.checked = showEvents;
    applyEvents(showEvents);
    toggleEvents.addEventListener("change", () => {
      writeBool("showEvents", toggleEvents.checked);
      applyEvents(toggleEvents.checked);
    });
  }

  // Sound effects: on by default, muted from here.
  if (toggleSound) {
    const soundOn = readBool("sound", true);
    toggleSound.checked = soundOn;
    setSoundEnabled(soundOn);
    toggleSound.addEventListener("change", () => {
      writeBool("sound", toggleSound.checked);
      setSoundEnabled(toggleSound.checked);
    });
  }

  // Left-click behaviour: attack directly (default) vs open the radial menu —
  // OpenFront's `leftClickOpensMenu`. rasterClient reads the persisted value at
  // click time, so this only needs to write it.
  if (toggleLeftClickMenu) {
    toggleLeftClickMenu.checked = readBool("leftClickOpensMenu", false);
    toggleLeftClickMenu.addEventListener("change", () => {
      writeBool("leftClickOpensMenu", toggleLeftClickMenu.checked);
    });
  }

  // Gear toggles the panel; a click anywhere outside closes it.
  if (button && panel) {
    const setOpen = (open: boolean): void => {
      panel.classList.toggle("hidden", !open);
      button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(panel.classList.contains("hidden"));
    });
    panel.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", () => setOpen(false));
  }
};

/**
 * Wire the top-right frame controls (fullscreen toggle, leave match) — the
 * page chrome around the match, not game state, so this is independent of
 * whether a match is running and safe to call once at page load.
 */
export const initFrameControls = (): void => {
  const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreenButton");
  if (fullscreenButton) {
    fullscreenButton.addEventListener("click", () => {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void document.documentElement.requestFullscreen().catch(() => {
          // Fullscreen can be denied (e.g. iframe without the allow attribute,
          // or a user gesture requirement not met) — fail silently rather than
          // surface a broken feature as an error.
        });
      }
    });
  }

  const leaveButton = document.querySelector<HTMLButtonElement>("#leaveButton");
  if (leaveButton) {
    leaveButton.addEventListener("click", () => {
      if (window.confirm("Leave this match and return to the menu?")) {
        window.location.reload();
      }
    });
  }
};
