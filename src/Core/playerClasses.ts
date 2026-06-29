/**
 * Starter classes (Phase 2, Feature 7).
 *
 * A class is the player's loadout *before* any perks: a base {@link PlayerModifiers}
 * bundle plus a spawn tweak (extra starting tiles). Perks chosen later fold on
 * top of the class base. Pure and framework-free so it's unit-testable.
 *
 * Original design — values are our own balancing, not copied from any other game.
 */

import { IDENTITY_MODIFIERS, type PlayerModifiers } from "./perks.js";
import { MAX_SEA_CROSSING_TILES } from "./rasterCombatConfig.js";

/** Stable identifiers for the three selectable classes. */
export type PlayerClassId = "imperialist" | "admiral" | "partisan";

export const ALL_PLAYER_CLASS_IDS: readonly PlayerClassId[] = ["imperialist", "admiral", "partisan"];

/** Runtime guard for an arbitrary value being a known class id. */
export const isPlayerClassId = (value: unknown): value is PlayerClassId =>
  typeof value === "string" && (ALL_PLAYER_CLASS_IDS as readonly string[]).includes(value);

export interface PlayerClassDefinition {
  readonly id: PlayerClassId;
  readonly name: string;
  readonly description: string;
  /**
   * Extra capturable tiles claimed around the spawn at match start, on top of
   * the single capital tile (so the player begins with `1 + bonusStartingTiles`).
   */
  readonly bonusStartingTiles: number;
  /** Base modifiers applied before perks. */
  readonly modifiers: PlayerModifiers;
}

// Admiral's "+2 range" expressed as a multiplier over the base crossing range,
// so it composes with the multiplicative Sea God perk. effectiveSeaRange rounds
// `MAX_SEA_CROSSING_TILES * seaRange`, so this yields exactly base + 2 tiles.
const ADMIRAL_SEA_RANGE = (MAX_SEA_CROSSING_TILES + 2) / MAX_SEA_CROSSING_TILES;

export const PLAYER_CLASS_DEFINITIONS: Record<PlayerClassId, PlayerClassDefinition> = {
  imperialist: {
    id: "imperialist",
    name: "Imperialist",
    description: "Starts with 3 tiles — a head start on territory and income.",
    bonusStartingTiles: 2,
    modifiers: { ...IDENTITY_MODIFIERS },
  },
  admiral: {
    id: "admiral",
    name: "Admiral",
    description: "Cheap, fast boats and +2 sea-crossing range.",
    bonusStartingTiles: 0,
    modifiers: { ...IDENTITY_MODIFIERS, seaSpeed: 2, seaRange: ADMIRAL_SEA_RANGE },
  },
  partisan: {
    id: "partisan",
    name: "Partisan",
    description: "+40% troop growth, but -20% attack speed.",
    bonusStartingTiles: 0,
    modifiers: { ...IDENTITY_MODIFIERS, income: 1.4, expansionSpeed: 0.8 },
  },
};

/** The base modifiers for a class, or identity when no class is selected (bots). */
export const classModifiers = (id: PlayerClassId | null): PlayerModifiers =>
  id ? { ...PLAYER_CLASS_DEFINITIONS[id].modifiers } : { ...IDENTITY_MODIFIERS };

/** Extra starting tiles for a class (0 when no class is selected). */
export const classBonusStartingTiles = (id: PlayerClassId | null): number =>
  id ? PLAYER_CLASS_DEFINITIONS[id].bonusStartingTiles : 0;
