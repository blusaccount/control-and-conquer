import type { Point } from "../Core/types.js";

/**
 * Ray-casting point-in-polygon test. Returns true when (x, y) lies inside the
 * polygon described by `points`. Pure — no DOM access, so it is unit-testable.
 */
export const pointInPolygon = (x: number, y: number, points: Point[]): boolean => {
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;

    const crossesScanline = (yi > y) !== (yj > y);
    const denominator = yj - yi;
    if (denominator === 0) {
      continue;
    }
    const edgeIntersectionX = ((xj - xi) * (y - yi)) / denominator + xi;
    const isLeftOfIntersection = x < edgeIntersectionX;

    if (crossesScanline && isLeftOfIntersection) {
      inside = !inside;
    }
  }

  return inside;
};

/**
 * Compute the integer troop count to send given the slider percentage and the
 * current source garrison. Always leaves at least 1 troop behind.
 */
export const computeAttackTroops = (sourceTroops: number, percent: number): number => {
  const maxSendable = sourceTroops - 1;
  if (maxSendable < 1) {
    return 0;
  }
  const raw = Math.floor((sourceTroops * percent) / 100);
  return Math.max(1, Math.min(raw, maxSendable));
};
