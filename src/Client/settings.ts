/**
 * Lightweight client-side settings, persisted in localStorage.
 *
 * The HUD ships with a minimal default: secondary panels that clutter the map
 * are hidden until the player opts into them from the gear menu. The only
 * setting today is the event log (captures/eliminations feed), which is off by
 * default and toggled on here.
 */

const STORAGE_PREFIX = "cnc.settings.";

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
