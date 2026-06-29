/**
 * Roguelite perk system (Phase 2, Feature 6).
 *
 * Pure and framework-free so the whole thing is unit-testable without a browser
 * or a running server. A perk is just a named transform on a {@link PlayerModifiers}
 * bundle; the engine reads those modifiers when resolving income, expansion,
 * defence and sea crossings. Stacking the same perk multiplies its effect.
 *
 * Original design — effects and tuning are our own, not copied from any other
 * game's implementation.
 */

/** Stable identifiers for the four offerable perks. */
export type PerkId = "swift-attacker" | "fortress-wall" | "sea-god" | "growth-driver";

/** All perk ids in a fixed order (used for deterministic offers and UI). */
export const ALL_PERK_IDS: readonly PerkId[] = [
  "swift-attacker",
  "fortress-wall",
  "sea-god",
  "growth-driver",
];

/** Runtime guard: is an arbitrary value a known perk id? */
export const isPerkId = (value: unknown): value is PerkId =>
  typeof value === "string" && (ALL_PERK_IDS as readonly string[]).includes(value);

/** Human-facing metadata for a perk card. */
export interface PerkDefinition {
  readonly id: PerkId;
  readonly name: string;
  readonly description: string;
}

export const PERK_DEFINITIONS: Record<PerkId, PerkDefinition> = {
  "swift-attacker": {
    id: "swift-attacker",
    name: "Swift Attacker",
    description: "+20% attack speed — your fronts advance faster each tick.",
  },
  "fortress-wall": {
    id: "fortress-wall",
    name: "Fortress Wall",
    description: "+50% defense — your tiles cost more to capture.",
  },
  "sea-god": {
    id: "sea-god",
    name: "Sea God",
    description: "Boats travel twice as fast and twice as far.",
  },
  "growth-driver": {
    id: "growth-driver",
    name: "Growth Driver",
    description: "+30% troop growth from your territory.",
  },
};

/**
 * Multiplicative modifiers a player accumulates from perks (and, later, classes).
 * All default to 1 (no effect). The engine multiplies the relevant base value by
 * the matching field.
 */
export interface PlayerModifiers {
  /** Scales the troops an attack spends per tick (attack speed). */
  expansionSpeed: number;
  /** Scales the troop cost to capture this player's tiles (defence). */
  defense: number;
  /** Scales amphibious crossing range. */
  seaRange: number;
  /** Scales boat speed (lower sea-crossing surcharge + faster animation). */
  seaSpeed: number;
  /** Scales troop income. */
  income: number;
}

/** A modifiers bundle with no effect — the starting point before perks. */
export const IDENTITY_MODIFIERS: PlayerModifiers = Object.freeze({
  expansionSpeed: 1,
  defense: 1,
  seaRange: 1,
  seaSpeed: 1,
  income: 1,
});

const PERK_EFFECTS: Record<PerkId, (m: PlayerModifiers) => PlayerModifiers> = {
  "swift-attacker": (m) => ({ ...m, expansionSpeed: m.expansionSpeed * 1.2 }),
  "fortress-wall": (m) => ({ ...m, defense: m.defense * 1.5 }),
  "sea-god": (m) => ({ ...m, seaRange: m.seaRange * 2, seaSpeed: m.seaSpeed * 2 }),
  "growth-driver": (m) => ({ ...m, income: m.income * 1.3 }),
};

/** Apply a single perk to a modifiers bundle, returning a new bundle. */
export const applyPerk = (mods: PlayerModifiers, perk: PerkId): PlayerModifiers =>
  PERK_EFFECTS[perk](mods);

/** Fold a list of chosen perks into a single modifiers bundle. */
export const modifiersForPerks = (
  perks: readonly PerkId[],
  base: PlayerModifiers = IDENTITY_MODIFIERS,
): PlayerModifiers => perks.reduce<PlayerModifiers>((m, p) => applyPerk(m, p), { ...base });

/** Number of perk cards offered each round. */
export const PERK_OFFER_SIZE = 3;

/**
 * The perks offered on round `offerIndex` (0-based). Deterministic: a window of
 * {@link PERK_OFFER_SIZE} perks rotates over {@link ALL_PERK_IDS} so successive
 * offers vary without any randomness, keeping the engine replay-stable.
 */
export const offerPerks = (offerIndex: number): PerkId[] => {
  const n = ALL_PERK_IDS.length;
  const start = ((offerIndex % n) + n) % n;
  const out: PerkId[] = [];
  for (let i = 0; i < PERK_OFFER_SIZE; i += 1) out.push(ALL_PERK_IDS[(start + i) % n]);
  return out;
};
