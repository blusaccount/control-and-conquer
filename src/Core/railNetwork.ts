/**
 * Automatic railroad routing between a player's station buildings.
 *
 * OpenFront never lets a player draw track by hand: place a **Factory** near a
 * city or port and the game spawns railroads linking them, fanning out into a
 * mesh as more stations come within reach (see the Railroad wiki). This module
 * is the pure, deterministic core of that — given the current stations it
 * returns the set of rail links and the station adjacency they form. The train
 * simulation (`railSystem.ts`) layers movement and gold payouts on top.
 *
 * Rules mirrored from OpenFront (scaled to our grids in `buildings.ts`):
 *   - Only a player's own stations connect, and only if they own a factory (the
 *     factory is the catalyst; cities/ports alone lay no track).
 *   - Track runs in cardinal directions only — each link is an L-shaped path.
 *   - A link spans at most {@link RAIL_CONNECT_DISTANCE} tiles (straight line)
 *     and its routed path at most {@link RAIL_MAX_LENGTH} tiles of track.
 *   - Each station anchors at most {@link RAIL_MAX_CONNECTIONS} links; nearest
 *     candidates win, so a saturated station hands farther links to neighbours.
 *   - Track stays on land (it never crosses water or impassable rock).
 *
 * Everything is a pure function of (map, stations) with deterministic ordering,
 * so the network is replay-stable and unit-testable without a running match.
 */
import type { GameMap, TileRef } from "./GameMap.js";
import type { PlayerId } from "./TerritoryGrid.js";
import {
  type BuildingType,
  RAIL_CONNECT_DISTANCE,
  RAIL_MAX_CONNECTIONS,
  RAIL_MAX_LENGTH,
} from "./buildings.js";

/** A station building that a railroad can link, with its owner and kind. */
export interface RailStation {
  ref: TileRef;
  owner: PlayerId;
  type: BuildingType;
}

/** One railroad link between two stations of the same owner. */
export interface RailEdge {
  owner: PlayerId;
  /** Endpoint stations; `a < b` by tile ref for a stable identity. */
  a: TileRef;
  b: TileRef;
  /**
   * Ordered corner tiles of the cardinal L-path from `a` to `b`: `[a, b]` when
   * the two share a row/column, else `[a, corner, b]`. The straight runs between
   * consecutive corners are the actual track (used for rendering and for placing
   * a train along the line).
   */
  corners: TileRef[];
  /** Track length in tiles (Manhattan distance between the endpoints). */
  length: number;
}

/** The computed rail layer: every link plus the station→stations adjacency. */
export interface RailNetwork {
  edges: RailEdge[];
  /** Station ref → the station refs it is directly linked to (both directions). */
  adjacency: Map<TileRef, TileRef[]>;
}

/** True when a tile can carry track: passable land (never water or rock). */
const isTrackable = (map: GameMap, ref: TileRef): boolean =>
  map.isLand(ref) && !map.isImpassable(ref);

/**
 * Walk the cardinal segment from `p` to `q` (which must share a row or column),
 * returning false if any tile along it — endpoints included — can't carry track.
 */
const segmentClear = (map: GameMap, p: TileRef, q: TileRef): boolean => {
  const px = map.x(p);
  const py = map.y(p);
  const qx = map.x(q);
  const qy = map.y(q);
  const stepX = Math.sign(qx - px);
  const stepY = Math.sign(qy - py);
  let x = px;
  let y = py;
  for (;;) {
    if (!isTrackable(map, map.ref(x, y))) return false;
    if (x === qx && y === qy) return true;
    x += stepX;
    y += stepY;
  }
};

/**
 * Route a cardinal-only L-path between two stations, or null if none stays on
 * land within {@link RAIL_MAX_LENGTH}. Tries the horizontal-then-vertical bend
 * first, then vertical-then-horizontal, so the choice is deterministic.
 */
const routeLPath = (map: GameMap, a: TileRef, b: TileRef): RailEdge["corners"] | null => {
  const ax = map.x(a);
  const ay = map.y(a);
  const bx = map.x(b);
  const by = map.y(b);
  if (Math.abs(bx - ax) + Math.abs(by - ay) > RAIL_MAX_LENGTH) return null;
  if (ax === bx || ay === by) return segmentClear(map, a, b) ? [a, b] : null;
  const horizontalFirst = map.ref(bx, ay);
  if (segmentClear(map, a, horizontalFirst) && segmentClear(map, horizontalFirst, b)) {
    return [a, horizontalFirst, b];
  }
  const verticalFirst = map.ref(ax, by);
  if (segmentClear(map, a, verticalFirst) && segmentClear(map, verticalFirst, b)) {
    return [a, verticalFirst, b];
  }
  return null;
};

const addAdjacency = (adjacency: Map<TileRef, TileRef[]>, from: TileRef, to: TileRef): void => {
  const list = adjacency.get(from);
  if (list) list.push(to);
  else adjacency.set(from, [to]);
};

/**
 * Compute the rail network for the current set of stations. Pure and
 * deterministic: candidate links are generated per owner (only owners holding a
 * factory get track), sorted nearest-first, and added greedily while both
 * endpoints stay under the per-station connection cap.
 */
export const computeRailNetwork = (
  map: GameMap,
  stations: readonly RailStation[],
): RailNetwork => {
  const edges: RailEdge[] = [];
  const adjacency = new Map<TileRef, TileRef[]>();

  const byOwner = new Map<PlayerId, RailStation[]>();
  for (const station of stations) {
    const list = byOwner.get(station.owner);
    if (list) list.push(station);
    else byOwner.set(station.owner, [station]);
  }

  const maxDistSq = RAIL_CONNECT_DISTANCE * RAIL_CONNECT_DISTANCE;
  for (const owner of [...byOwner.keys()].sort((p, q) => p - q)) {
    const own = byOwner.get(owner)!;
    // The factory is the catalyst: without one, a player's cities/ports lay no
    // track even when they sit side by side.
    if (!own.some((s) => s.type === "factory")) continue;

    const sorted = [...own].sort((p, q) => p.ref - q.ref);
    const candidates: Array<{ a: TileRef; b: TileRef; corners: TileRef[]; length: number; distSq: number }> = [];
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i].ref;
        const b = sorted[j].ref;
        const dx = map.x(b) - map.x(a);
        const dy = map.y(b) - map.y(a);
        const distSq = dx * dx + dy * dy;
        if (distSq > maxDistSq) continue;
        const corners = routeLPath(map, a, b);
        if (!corners) continue;
        candidates.push({ a, b, corners, length: Math.abs(dx) + Math.abs(dy), distSq });
      }
    }
    // Nearest links first (ties broken by endpoint refs) so a station spends its
    // limited connection slots on its closest neighbours, exactly like OpenFront.
    candidates.sort((p, q) => p.distSq - q.distSq || p.a - q.a || p.b - q.b);

    const connections = new Map<TileRef, number>();
    for (const cand of candidates) {
      if ((connections.get(cand.a) ?? 0) >= RAIL_MAX_CONNECTIONS) continue;
      if ((connections.get(cand.b) ?? 0) >= RAIL_MAX_CONNECTIONS) continue;
      edges.push({ owner, a: cand.a, b: cand.b, corners: cand.corners, length: cand.length });
      connections.set(cand.a, (connections.get(cand.a) ?? 0) + 1);
      connections.set(cand.b, (connections.get(cand.b) ?? 0) + 1);
      addAdjacency(adjacency, cand.a, cand.b);
      addAdjacency(adjacency, cand.b, cand.a);
    }
  }

  return { edges, adjacency };
};

/** Stable key for the unordered station pair `{a, b}` (used to look up an edge). */
export const railPairKey = (a: TileRef, b: TileRef): string =>
  a < b ? `${a}-${b}` : `${b}-${a}`;
