/**
 * Digit-row hotkey mapping, matching OpenFront's `getDefaultKeybinds` exactly.
 *
 * Pure and dependency-light so the exact key→action mapping is unit-testable
 * (the parity claim that "1 builds a City, 8 arms an Atom Bomb, …" is pinned by
 * a test rather than buried in the client's input closure).
 */

import type { BuildingType } from "../Core/buildings.js";
import type { NukeKind } from "../Core/nukes.js";

/** What a digit-row key arms: a structure to build, or a warhead to launch. */
export type DigitAction = { build: BuildingType } | { nuke: NukeKind };

/**
 * The digit row's fixed bindings, in slot order (index 0 = key "1" … index 9 =
 * key "0"), matching OpenFront's defaults: 1 City · 2 Factory · 3 Port ·
 * 4 Defense Post · 5 Missile Silo · 6 SAM · 7 Warship · 8 Atom · 9 Hydrogen ·
 * 0 MIRV. Fixed per key (not menu order), so an OpenFront player's muscle
 * memory carries over unchanged. (`fort` is our id for OpenFront's Defense
 * Post; `silo` its Missile Silo.)
 */
export const DIGIT_ACTIONS: readonly DigitAction[] = [
  { build: "city" },
  { build: "factory" },
  { build: "port" },
  { build: "fort" },
  { build: "silo" },
  { build: "sam" },
  { build: "warship" },
  { nuke: "atom" },
  { nuke: "hydrogen" },
  { nuke: "mirv" },
];

/**
 * Map a `KeyboardEvent.code` to a 0-based digit-row slot, or -1 if it isn't a
 * digit key. Accepts both the top-row `Digit0`–`Digit9` and the `Numpad0`–
 * `Numpad9` codes (OpenFront treats the numpad as an alias). Key "1" → slot 0
 * … "9" → slot 8, "0" → slot 9.
 */
export const digitSlotFromCode = (code: string): number => {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!m) return -1;
  const d = Number(m[1]);
  return d === 0 ? 9 : d - 1;
};

/** Resolve a `KeyboardEvent.code` to the build/weapon it arms, or null if it isn't a digit key. */
export const digitAction = (code: string): DigitAction | null => {
  const slot = digitSlotFromCode(code);
  return slot >= 0 && slot < DIGIT_ACTIONS.length ? DIGIT_ACTIONS[slot] : null;
};
