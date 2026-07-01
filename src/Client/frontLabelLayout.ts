/**
 * De-overlap pass for on-map attack-front troop-count labels.
 *
 * `drawFronts` in {@link "./rasterClient.js"} places one pill per active
 * attack at its frontier anchor, projected to screen space. When two fronts
 * push adjacent borders (e.g. two separate attackers pinching the same
 * target, or one attacker fighting two neighbours at once) their anchors can
 * land close enough that the pills overlap, leaving the troop counts
 * unreadable. This module resolves that: bigger battles keep their natural
 * spot, smaller/later ones nudge vertically until every pill clears every
 * other.
 *
 * Pure and DOM-free so it can be unit-tested without a canvas.
 */

/** A label's screen-space rectangle (centred on `x`,`y`) and placement priority. */
export interface FrontLabelInput {
  /** Stable identity linking a placement back to its source front. */
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Higher priority labels are placed first and keep their original spot. */
  priority: number;
}

export interface FrontLabelPlacement {
  id: number;
  x: number;
  y: number;
}

const overlaps = (
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean => Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;

/** How many alternate offsets to try before giving up and accepting overlap. */
const MAX_ATTEMPTS = 12;

/**
 * Place every label as close as possible to its requested centre while
 * clearing every higher-priority label already placed. Ties broken by `id`
 * so the result is deterministic regardless of input order.
 *
 * Candidates are tried in an expanding vertical zig-zag around the original
 * position — `[0, -step, +step, -2·step, +2·step, …]` — so a nudged label
 * still sits near its true anchor rather than drifting arbitrarily far.
 * After {@link MAX_ATTEMPTS} candidates a still-colliding label is placed at
 * its original position rather than searching forever.
 */
export const layoutFrontLabels = (labels: readonly FrontLabelInput[]): FrontLabelPlacement[] => {
  const ordered = [...labels].sort((a, b) => b.priority - a.priority || a.id - b.id);
  const placed: Array<FrontLabelInput & { px: number; py: number }> = [];

  for (const label of ordered) {
    const step = label.height + 2;
    let bestX = label.x;
    let bestY = label.y;
    let found = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !found; attempt += 1) {
      const half = Math.ceil(attempt / 2);
      const offset = attempt === 0 ? 0 : half * step * (attempt % 2 === 1 ? -1 : 1);
      const cx = label.x;
      const cy = label.y + offset;
      const collides = placed.some((p) =>
        overlaps(cx, cy, label.width, label.height, p.px, p.py, p.width, p.height),
      );
      if (!collides) {
        bestX = cx;
        bestY = cy;
        found = true;
      }
    }

    placed.push({ ...label, px: bestX, py: bestY });
  }

  const byId = new Map(placed.map((p) => [p.id, { id: p.id, x: p.px, y: p.py }]));
  return labels.map((l) => byId.get(l.id)!);
};
