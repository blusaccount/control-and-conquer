/**
 * Nuclear weapons — OpenFront's headline escalation mechanic (Missile Silo →
 * Atom Bomb) and the single most-requested feature missing from this clone,
 * per its own Steam store page and community wiki (openfront.wiki / miraheze
 * wiki / openfrontpro.com, cross-referenced). Facts and formulas only, no
 * OpenFront source or assets — see `docs/openfront-balance-replication-plan.md`
 * for the project's clean-room methodology.
 *
 * This is the **first tier** (Atom Bomb only). Hydrogen Bomb, MIRV and SAM
 * interception are documented follow-ups, not implemented here.
 *
 * One documented divergence: OpenFront turns nuked land into *water*,
 * permanently reshaping the coastline (`docs/openfront-balance-replication-plan.md`
 * §2.8). Terrain in this engine is immutable after generation — every other
 * system (sea-path BFS, land/water components) assumes it never changes — so a
 * blast here clears ownership to neutral instead. Reshaping the coastline
 * would mean invalidating those caches on every detonation, a larger change
 * left for a follow-up if it's worth the cost.
 */

/** Gold spent per Atom Bomb launch (on top of the Missile Silo's own build cost). */
export const ATOM_BOMB_COST = 750_000;

/** Tiles (Euclidean radius) fully irradiated — every tile in range is cleared. */
export const ATOM_BOMB_INNER_RADIUS = 15;

/** Tiles (Euclidean radius) of the outer ring — each tile has a chance to clear. */
export const ATOM_BOMB_OUTER_RADIUS = 40;

/** Per-tile clear chance in the outer ring (deterministic, hashed — see RasterConflict). */
export const ATOM_BOMB_OUTER_DESTROY_CHANCE = 0.5;

/**
 * Ticks a Missile Silo must wait after a launch before it can fire again,
 * matching OpenFront's `SiloCooldown` (see `docs/openfront-balance-replication-plan.md` §2.4).
 */
export const SILO_RELOAD_TICKS = 90;

/** Tiles a nuke covers per tick in flight — faster than a sailing transport ship. */
export const NUKE_TILES_PER_TICK = 4;

/** Why a nuke launch was refused. */
export type NukeRejectReason =
  | "UNKNOWN_PLAYER"
  | "INVALID_TARGET"
  | "NO_SILO_READY"
  | "INSUFFICIENT_GOLD";
