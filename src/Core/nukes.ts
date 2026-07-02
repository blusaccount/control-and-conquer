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
 * Radii and the inner-full / outer-50%-chance blast shape match OpenFront's
 * `nukeMagnitudes(AtomBomb) = { inner: 12, outer: 30 }` and its
 * `rand.chance(2)` outer draw. The lasting effect is **fallout** (see
 * {@link FALLOUT_DURATION_TICKS}): OpenFront marks destroyed tiles radioactive
 * — recoloured, un-ownable, decaying over time — rather than always turning
 * them to water (that is a separate `waterNukes` config mode). We replicate the
 * fallout mechanic; land→water conversion is left out (terrain is immutable
 * after generation here).
 */

/** Gold spent per Atom Bomb launch (on top of the Missile Silo's own build cost). */
export const ATOM_BOMB_COST = 750_000;

/** Tiles (Euclidean radius) fully irradiated — every tile in range is cleared. Matches OpenFront's AtomBomb inner. */
export const ATOM_BOMB_INNER_RADIUS = 12;

/** Tiles (Euclidean radius) of the outer ring — each tile has a chance to clear. Matches OpenFront's AtomBomb outer. */
export const ATOM_BOMB_OUTER_RADIUS = 30;

/** Per-tile clear chance in the outer ring (deterministic, hashed — see RasterConflict). OpenFront's `rand.chance(2)` = 50%. */
export const ATOM_BOMB_OUTER_DESTROY_CHANCE = 0.5;

/**
 * Ticks a destroyed tile stays **radioactive fallout** after a blast: it is
 * cleared to neutral, rendered with a sickly irradiated tint, and cannot be
 * (re)captured until the fallout decays — a temporary denial zone, mirroring
 * OpenFront's fallout (which recolours nuked ground and blocks ownership). At
 * 10 ticks/s this is ~15s.
 */
export const FALLOUT_DURATION_TICKS = 150;

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
