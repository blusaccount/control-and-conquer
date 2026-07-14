/**
 * Per-player attitude ledger — OpenFront's *relations* system, the memory that
 * turns its nations from stat-machines into grudge-holders. Every player holds
 * a scalar attitude toward every other player in [-100, 100] (default 0),
 * moved by public acts and slowly decaying back to neutral. The AI reads the
 * ledger through four coarse tiers:
 *
 *   value < -50 → HOSTILE      (embargoed; a standing "hated" attack target)
 *   value <   0 → DISTRUSTFUL  (alliance offers refused)
 *   value <  50 → NEUTRAL
 *   otherwise   → FRIENDLY     (alliance offers welcomed)
 *
 * The deltas below are OpenFront's balancing values (behaviour constants, not
 * ported code): being attacked is the big one and scales with difficulty —
 * -60/-70/-80/-100 — so harder nations hold grudges harder; breaking a pact
 * costs -100 with the victim and -40 with every onlooking neighbour; a troop
 * donation buys +50; a gold donation buys +5 per difficulty-scaled chunk; an
 * embargo is a standing -20 (returned when lifted); asking allies to attack
 * someone costs -40 with the target; and every value drifts 0.05 per tick back
 * toward 0, so old sins fade in minutes.
 *
 * Deterministic and engine-external: the ledger never touches the grid — it
 * only feeds AI decisions — so lockstep replicas that replay recorded AI
 * commands don't need to consult it.
 */
import type { PlayerId } from "./TerritoryGrid.js";
import type { RasterDifficulty } from "./messages.js";

/** The four attitude tiers, ordered worst→best (comparable with `<`/`>=`). */
export const RELATION_HOSTILE = 0;
export const RELATION_DISTRUSTFUL = 1;
export const RELATION_NEUTRAL = 2;
export const RELATION_FRIENDLY = 3;
export type RelationTier = 0 | 1 | 2 | 3;

/** Attitude hit the *target* of a fresh attack takes toward the attacker, by difficulty. */
export const ATTACKED_RELATION_PENALTY: Record<RasterDifficulty, number> = {
  easy: -60,
  medium: -70,
  hard: -80,
  impossible: -100,
};

/** Sealing an alliance vaults both parties to full trust. */
export const ALLIANCE_FORMED_BONUS = 100;
/** Betraying a pact: the victim's attitude toward the traitor bottoms out… */
export const BREAK_ALLIANCE_VICTIM_PENALTY = -100;
/** …and every neighbour who watched it happen distrusts the traitor too. */
export const BREAK_ALLIANCE_NEIGHBOR_PENALTY = -40;
/** Painting a target on someone (asking allies to attack them). */
export const TARGET_REQUEST_PENALTY = -40;
/** A troop donation is the strongest goodwill gesture. */
export const DONATE_TROOPS_BONUS = 50;
/** A standing embargo sours the embargoed party until it is lifted. */
export const EMBARGO_MALUS = -20;
/** Honouring an ally's attack request costs a favour (their account is drawn down). */
export const ASSIST_FAVOR_COST = -20;
/** A friendly emoji (👍 🤝 🫡) warms the recipient a touch. */
export const EMOJI_NICE_BONUS = 15;
/** A hostile emoji (👎 😡 💀) stings. */
export const EMOJI_HOSTILE_PENALTY = -10;

/**
 * Gold per +5 attitude points when donating gold, by difficulty (harder
 * nations are harder to buy). The chunk inflates with match age so late-game
 * fortunes don't trivially max the ledger: at tick `t` one chunk costs
 * `base × (1 + t / 3000)` — double after five minutes, as in OpenFront.
 */
export const DONATE_GOLD_CHUNK: Record<RasterDifficulty, number> = {
  easy: 2_500,
  medium: 5_000,
  hard: 12_500,
  impossible: 25_000,
};

/** Attitude points one gold chunk buys. */
export const DONATE_GOLD_POINTS_PER_CHUNK = 5;

/** Per-tick drift of every attitude value back toward 0. */
export const RELATION_DECAY_PER_TICK = 0.05;

/** Attitude a gold donation of `gold` buys at match tick `tick` (capped at 100). */
export const donationGoldRelation = (
  gold: number,
  tick: number,
  difficulty: RasterDifficulty,
): number => {
  const base = DONATE_GOLD_CHUNK[difficulty];
  const chunk = Math.round(base + base * (tick / 3000));
  const points = Math.floor(gold / Math.max(1, chunk)) * DONATE_GOLD_POINTS_PER_CHUNK;
  return Math.min(100, points);
};

/** Coarse tier for a raw ledger value. */
export const relationTier = (value: number): RelationTier => {
  if (value < -50) return RELATION_HOSTILE;
  if (value < 0) return RELATION_DISTRUSTFUL;
  if (value < 50) return RELATION_NEUTRAL;
  return RELATION_FRIENDLY;
};

export class RelationLedger {
  /** holder → (other → attitude value). Sparse: absent = 0 (neutral). */
  private readonly values = new Map<PlayerId, Map<PlayerId, number>>();

  /** Raw attitude `holder` carries toward `other` (0 when never touched). */
  valueOf(holder: PlayerId, other: PlayerId): number {
    return this.values.get(holder)?.get(other) ?? 0;
  }

  /** Coarse tier of `holder`'s attitude toward `other`. */
  tierOf(holder: PlayerId, other: PlayerId): RelationTier {
    return relationTier(this.valueOf(holder, other));
  }

  /** Shift `holder`'s attitude toward `other` by `delta`, clamped to [-100, 100]. */
  update(holder: PlayerId, other: PlayerId, delta: number): void {
    if (holder === other || delta === 0) return;
    let row = this.values.get(holder);
    if (!row) {
      row = new Map();
      this.values.set(holder, row);
    }
    const next = Math.max(-100, Math.min(100, (row.get(other) ?? 0) + delta));
    row.set(other, next);
  }

  /**
   * `holder`'s non-neutral attitudes sorted worst-first — the "most hated"
   * scan an AI runs when picking a grudge target. Entries whose value has
   * decayed to 0 are pruned as a side effect (they mean nothing anymore).
   */
  sortedOf(holder: PlayerId): Array<{ other: PlayerId; tier: RelationTier; value: number }> {
    const row = this.values.get(holder);
    if (!row) return [];
    const out: Array<{ other: PlayerId; tier: RelationTier; value: number }> = [];
    for (const [other, value] of row) {
      if (value === 0) {
        row.delete(other);
        continue;
      }
      out.push({ other, tier: relationTier(value), value });
    }
    out.sort((a, b) => a.value - b.value || a.other - b.other);
    return out;
  }

  /**
   * Drift every stored attitude {@link RELATION_DECAY_PER_TICK} toward 0,
   * zeroing values inside the final two steps so the maps stay sparse.
   * Call once per simulation tick.
   */
  decay(): void {
    for (const row of this.values.values()) {
      for (const [other, value] of row) {
        const moved = value - Math.sign(value) * RELATION_DECAY_PER_TICK;
        if (Math.abs(moved) < RELATION_DECAY_PER_TICK * 2) row.delete(other);
        else row.set(other, moved);
      }
    }
  }

  /** Forget a dead player entirely — as holder and as everyone's counterparty. */
  removePlayer(id: PlayerId): void {
    this.values.delete(id);
    for (const row of this.values.values()) row.delete(id);
  }
}
