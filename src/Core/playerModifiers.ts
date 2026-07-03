/**
 * Per-player gameplay modifiers.
 *
 * Multiplicative tweaks the engine applies when resolving income, expansion,
 * defence and sea crossings. All default to 1 (no effect): the engine multiplies
 * the relevant base value by the matching field.
 *
 * Every player currently runs on {@link IDENTITY_MODIFIERS} — classes and perks
 * that once varied these were removed in favour of a barebones, symmetric base
 * game. The plumbing is kept so the feature can be reintroduced without touching
 * the combat/economy math.
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
  /**
   * Scales how many transport ships the player may have at sea at once (the base
   * cap times this, bounded ≥1). Mirrors `seaRange` so both naval limits flex
   * through the same per-player plumbing instead of one being a hard constant.
   */
  shipCapacity: number;
  /** Scales troop income (the per-tick growth). */
  income: number;
  /**
   * Scales the player's maximum population — their territory-scaled troop
   * ceiling. Mirrors OpenFront's per-difficulty cap multiplier for nations (and
   * the bot ÷3): a lower ceiling caps how big an AI's army can ever get, on top
   * of the {@link income} growth multiplier.
   */
  troopCapMultiplier: number;
  /**
   * Scales the troops this player spends to claim a **neutral** tile. Mirrors
   * OpenFront's cheaper Bot expansion: a Tribe pays `mag/10` per neutral tile
   * versus everyone else's `mag/5`, so passive fillers blanket the map's empty
   * land fast. 1 = the standard cost; a Bot seat runs at 0.5.
   */
  neutralCostMultiplier: number;
  /**
   * Scales the flat passive gold trickle. Mirrors OpenFront's
   * `goldAdditionRate`: a `PlayerType.Bot` earns a 50/tick base where every
   * other player earns 100/tick — so a Tribe seat runs at 0.5 and its hoard
   * (loot for whoever conquers it) grows half as fast.
   */
  goldMultiplier: number;
}

/** A modifiers bundle with no effect — every player's baseline. */
export const IDENTITY_MODIFIERS: PlayerModifiers = Object.freeze({
  expansionSpeed: 1,
  defense: 1,
  seaRange: 1,
  seaSpeed: 1,
  shipCapacity: 1,
  income: 1,
  troopCapMultiplier: 1,
  neutralCostMultiplier: 1,
  goldMultiplier: 1,
});
