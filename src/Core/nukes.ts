/**
 * Nuclear weapons — OpenFront's headline escalation mechanic (Missile Silo →
 * Atom Bomb / Hydrogen Bomb / MIRV, defended against by a SAM Launcher) and,
 * per its own Steam store page and community wiki (openfront.wiki / miraheze
 * wiki / openfrontpro.com, cross-referenced), one of the game's signature
 * systems. Facts and formulas only, no OpenFront source or assets — see
 * `docs/openfront-balance-replication-plan.md` for the project's clean-room
 * methodology.
 *
 * Three warhead tiers, all launched from a Missile Silo:
 *  - **Atom Bomb** — one blast, source-verified radii (see below).
 *  - **Hydrogen Bomb** — one much bigger blast. OpenFront's exact inner/outer
 *    radii weren't available in the source excerpts this project could reach,
 *    so {@link HYDROGEN_BOMB_INNER_RADIUS}/{@link HYDROGEN_BOMB_OUTER_RADIUS}
 *    are a documented clean-room scale-up of the Atom Bomb's (same shape,
 *    ~1.7×), not a source-verified figure.
 *  - **MIRV** — splits into several independent, atom-sized warheads that
 *    scatter around the aim point ({@link MIRV_WARHEAD_COUNT}/
 *    {@link MIRV_SCATTER_RADIUS} are likewise this project's own choice, not
 *    sourced — OpenFront's exact warhead count/spread wasn't found).
 *
 * A **SAM Launcher** is the counter: an active, off-cooldown, non-allied SAM
 * within {@link SAM_RANGE} of an in-flight warhead gets one intercept roll
 * each time a warhead enters its range, consuming its cooldown whether or not
 * the roll hits. OpenFront's exact intercept-probability formula wasn't found
 * in the available source excerpts either, so {@link SAM_INTERCEPT_CHANCE} is
 * this project's own reasonable constant, not a sourced figure. `samRange` and
 * `SAMCooldown` (90 ticks) themselves *are* sourced (see
 * `docs/openfront-balance-replication-plan.md` §2.3/§3c).
 *
 * The Atom Bomb's radii and the inner-full / outer-50%-chance blast shape
 * match OpenFront's `nukeMagnitudes(AtomBomb) = { inner: 12, outer: 30 }` and
 * its `rand.chance(2)` outer draw. The lasting effect is **fallout** (see
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

/** The three warhead tiers, all launched from a Missile Silo. */
export type NukeKind = "atom" | "hydrogen" | "mirv";

/** All warhead kinds, in menu order. */
export const NUKE_KINDS: readonly NukeKind[] = ["atom", "hydrogen", "mirv"];

/** Runtime guard: is `value` a known warhead kind? */
export const isNukeKind = (value: unknown): value is NukeKind =>
  typeof value === "string" && (NUKE_KINDS as readonly string[]).includes(value);

/** Gold spent per Hydrogen Bomb launch. */
export const HYDROGEN_BOMB_COST = 5_000_000;

/** Hydrogen Bomb inner (fully irradiated) radius — see the module header for sourcing. */
export const HYDROGEN_BOMB_INNER_RADIUS = 20;

/** Hydrogen Bomb outer (per-tile chance) radius — see the module header for sourcing. */
export const HYDROGEN_BOMB_OUTER_RADIUS = 50;

/** Flat gold spent per MIRV launch before the per-silo surcharge. */
export const MIRV_BASE_COST = 25_000_000;

/** Extra gold per Missile Silo the attacker owns, added to {@link MIRV_BASE_COST}. */
export const MIRV_COST_PER_SILO = 15_000_000;

/** Independent, atom-sized warheads a single MIRV launch splits into. */
export const MIRV_WARHEAD_COUNT = 6;

/** Tiles (Euclidean) each MIRV warhead's landing point may scatter from the aim point. */
export const MIRV_SCATTER_RADIUS = 45;

/** Gold cost to launch `kind`, given how many Missile Silos the attacker owns (for MIRV's surcharge). */
export const nukeCost = (kind: NukeKind, silosOwned: number): number => {
  if (kind === "atom") return ATOM_BOMB_COST;
  if (kind === "hydrogen") return HYDROGEN_BOMB_COST;
  return MIRV_BASE_COST + Math.max(0, silosOwned) * MIRV_COST_PER_SILO;
};

/** A warhead's blast shape: fully-irradiated inner radius, per-tile-chance outer radius and that chance. */
export interface NukeBlast {
  inner: number;
  outer: number;
  outerChance: number;
}

/**
 * Blast shape for warhead `kind`. A MIRV's individual warheads are each
 * atom-bomb-sized (see the module header) — the launch's destructive power
 * comes from splitting into {@link MIRV_WARHEAD_COUNT} of them, not from a
 * bigger single blast.
 */
export const nukeBlast = (kind: NukeKind): NukeBlast => {
  if (kind === "hydrogen") {
    return { inner: HYDROGEN_BOMB_INNER_RADIUS, outer: HYDROGEN_BOMB_OUTER_RADIUS, outerChance: ATOM_BOMB_OUTER_DESTROY_CHANCE };
  }
  return { inner: ATOM_BOMB_INNER_RADIUS, outer: ATOM_BOMB_OUTER_RADIUS, outerChance: ATOM_BOMB_OUTER_DESTROY_CHANCE };
};

/**
 * Tiles (Chebyshev) a SAM Launcher's interceptors reach, OpenFront's
 * `samRange(level)` evaluated at level 1 = `maxSamRange(150) − 480/(1+5)` = 70
 * (its `defaultSamRange`). This project has no per-structure upgrade levels,
 * so SAM Launchers are always this one tier.
 */
export const SAM_RANGE = 70;

/**
 * Ticks a SAM Launcher must wait after firing an interceptor (hit or miss)
 * before it can fire again, matching OpenFront's `SAMCooldown` (see
 * `docs/openfront-balance-replication-plan.md` §2.3/§3c).
 */
export const SAM_RELOAD_TICKS = 90;

/**
 * Chance a SAM Launcher's interceptor destroys a warhead that comes within
 * {@link SAM_RANGE} of it (deterministic, hashed — see RasterConflict). Our
 * own clean-room constant — see the module header for why.
 */
export const SAM_INTERCEPT_CHANCE = 0.75;

/** Static, menu-facing description of one warhead kind. */
export interface NukeDef {
  readonly kind: NukeKind;
  readonly name: string;
  /** Indefinite article ("a"/"an") for building event-log sentences. */
  readonly article: string;
  readonly description: string;
}

/** Static data for every warhead kind, keyed by kind id, in menu order. */
export const NUKE_DEFS: Readonly<Record<NukeKind, NukeDef>> = {
  atom: {
    kind: "atom",
    name: "Atom Bomb",
    article: "an",
    description: "One devastating blast. Requires a ready Missile Silo.",
  },
  hydrogen: {
    kind: "hydrogen",
    name: "Hydrogen Bomb",
    article: "a",
    description: "A far larger blast than an Atom Bomb. Requires a ready Missile Silo.",
  },
  mirv: {
    kind: "mirv",
    name: "MIRV",
    article: "a",
    description: `Splits into ${MIRV_WARHEAD_COUNT} warheads that scatter across the target area. Requires a ready Missile Silo.`,
  },
};
