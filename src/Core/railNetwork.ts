/**
 * Automatic railroad routing between a player's station buildings.
 *
 * OpenFront never lets a player draw track by hand: place a **Factory** near a
 * city or port and the game spawns railroads linking them, fanning out into a
 * mesh as more stations come within reach (see the Railroad wiki). This module is
 * the pure, deterministic core of that — given the current stations it returns
 * the rail links and the station adjacency they form. The train simulation
 * (`railSystem.ts`) layers movement and gold payouts on top.
 *
 * Rules replicated 1:1 from OpenFront (values in `buildings.ts`):
 *   - Only a player's own stations connect, and only owners holding a **factory**
 *     lay track (the factory is the catalyst). A **city/port becomes a station**
 *     only when a factory sits within {@link RAIL_STATION_MAX_RANGE} of it; a
 *     factory is always a station.
 *   - Two stations link when their straight-line distance is within
 *     [{@link RAIL_STATION_MIN_RANGE}, {@link RAIL_STATION_MAX_RANGE}].
 *   - Track is routed by **A\*** over the tile grid, **cardinal only** (4-neighbour),
 *     with OpenFront's costs: base 1/step, {@link RAIL_DIRECTION_CHANGE_PENALTY}
 *     on every turn (favours straight runs), {@link RAIL_WATER_PENALTY} onto a
 *     water/shoreline tile (favours dry land, short water bridges), and a
 *     Manhattan × {@link RAIL_HEURISTIC_WEIGHT} heuristic. Open water is only
 *     traversable as a shore-to-shore hop; impassable rock never.
 *   - A route whose track exceeds {@link RAIL_MAX_TRACK_LENGTH} is dropped.
 *
 * Everything is a pure function of (map, stations) with deterministic ordering
 * (including A\* tie-breaks), so the network is replay-stable and unit-testable
 * without a running match.
 */
import type { GameMap, TileRef } from "./GameMap.js";
import type { PlayerId } from "./TerritoryGrid.js";
import {
  type BuildingType,
  RAIL_DIRECTION_CHANGE_PENALTY,
  RAIL_HEURISTIC_WEIGHT,
  RAIL_MAX_TRACK_LENGTH,
  RAIL_STATION_MAX_RANGE,
  RAIL_STATION_MIN_RANGE,
  RAIL_WATER_PENALTY,
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
   * Ordered corner tiles of the routed cardinal path from `a` to `b`: the turn
   * points, starting at `a` and ending at `b`. Consecutive corners share a row or
   * column (each run is a single cardinal direction), so they render as a polyline
   * and carry a train along the line.
   */
  corners: TileRef[];
  /** Track length in tiles (number of steps along the routed path). */
  length: number;
}

/** The computed rail layer: every link plus the station→stations adjacency. */
export interface RailNetwork {
  edges: RailEdge[];
  /** Station ref → the station refs it is directly linked to (both directions). */
  adjacency: Map<TileRef, TileRef[]>;
}

/** True when a tile can anchor a station / carry track end: passable land. */
const isTrackableLand = (map: GameMap, ref: TileRef): boolean =>
  map.isLand(ref) && !map.isImpassable(ref);

/** The four cardinal moves, in a fixed order for deterministic expansion. */
const DIRS: ReadonlyArray<{ dx: number; dy: number; code: number }> = [
  { dx: 1, dy: 0, code: 1 }, // east
  { dx: -1, dy: 0, code: 2 }, // west
  { dx: 0, dy: -1, code: 3 }, // north
  { dx: 0, dy: 1, code: 4 }, // south
];

/**
 * A tiny binary min-heap of A\* nodes, ordered by `f` then `g` then tile then dir
 * so pops are fully deterministic (equal-cost paths resolve the same way every
 * run, keeping replays identical).
 */
interface AStarNode {
  f: number;
  g: number;
  len: number;
  tile: TileRef;
  dir: number;
}
const nodeLess = (a: AStarNode, b: AStarNode): boolean =>
  a.f !== b.f ? a.f < b.f : a.g !== b.g ? a.g < b.g : a.tile !== b.tile ? a.tile < b.tile : a.dir < b.dir;

class NodeHeap {
  private readonly items: AStarNode[] = [];
  get size(): number {
    return this.items.length;
  }
  push(node: AStarNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (nodeLess(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }
  pop(): AStarNode {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && nodeLess(items[l], items[smallest])) smallest = l;
        if (r < items.length && nodeLess(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Safety cap on A\* node expansions per route, so an impossible link fails fast. */
const RAIL_ASTAR_MAX_EXPANSIONS = 60_000;

/**
 * Route a railroad from station `a` to station `b` with OpenFront's A\*: cardinal
 * moves, direction-change and water penalties, weighted Manhattan heuristic, and
 * the {@link RAIL_MAX_TRACK_LENGTH} track cap. Returns the turn-point corners and
 * the track length, or null if no route stays within the cap.
 */
const routeRail = (map: GameMap, a: TileRef, b: TileRef): { corners: TileRef[]; length: number } | null => {
  if (!isTrackableLand(map, a) || !isTrackableLand(map, b)) return null;
  const bx = map.x(b);
  const by = map.y(b);
  const heuristic = (tile: TileRef): number =>
    (Math.abs(map.x(tile) - bx) + Math.abs(map.y(tile) - by)) * RAIL_HEURISTIC_WEIGHT;

  // State = (tile, arrival direction). dir 0 = start (no direction yet).
  const stateKey = (tile: TileRef, dir: number): number => tile * 5 + dir;
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();

  const start = stateKey(a, 0);
  gScore.set(start, 0);
  const open = new NodeHeap();
  open.push({ f: heuristic(a), g: 0, len: 0, tile: a, dir: 0 });

  let expansions = 0;
  while (open.size > 0) {
    if (++expansions > RAIL_ASTAR_MAX_EXPANSIONS) return null;
    const cur = open.pop();
    const curKey = stateKey(cur.tile, cur.dir);
    if (cur.g > (gScore.get(curKey) ?? Infinity)) continue; // stale heap entry

    if (cur.tile === b) {
      // Reconstruct the tile path, then reduce it to turn-point corners.
      const path: TileRef[] = [];
      let key = curKey;
      let tile = cur.tile;
      let dir = cur.dir;
      for (;;) {
        path.push(tile);
        const prev = cameFrom.get(key);
        if (prev === undefined) break;
        tile = Math.floor(prev / 5);
        dir = prev % 5;
        key = prev;
      }
      path.reverse();
      const corners = reduceToCorners(map, path);
      return { corners, length: path.length - 1 };
    }

    const cx = map.x(cur.tile);
    const cy = map.y(cur.tile);
    for (const move of DIRS) {
      const nx = cx + move.dx;
      const ny = cy + move.dy;
      if (!map.inBounds(nx, ny)) continue;
      const next = map.ref(nx, ny);
      if (map.isImpassable(next)) continue;

      const nextWater = map.isWater(next);
      const nextShore = map.isShore(next);
      // Open water is only crossable as a shore-to-shore hop.
      if (nextWater && !nextShore && !map.isShore(cur.tile)) continue;

      const nextLen = cur.len + 1;
      if (nextLen > RAIL_MAX_TRACK_LENGTH) continue; // over the track cap — prune

      let step = 1;
      if (nextWater || nextShore) step += RAIL_WATER_PENALTY;
      if (cur.dir !== 0 && move.code !== cur.dir) step += RAIL_DIRECTION_CHANGE_PENALTY;

      const nextG = cur.g + step;
      const nextKey = stateKey(next, move.code);
      if (nextG < (gScore.get(nextKey) ?? Infinity)) {
        gScore.set(nextKey, nextG);
        cameFrom.set(nextKey, curKey);
        open.push({ f: nextG + heuristic(next), g: nextG, len: nextLen, tile: next, dir: move.code });
      }
    }
  }
  return null;
};

/** Reduce a full tile path to its turn-point corners (endpoints always kept). */
const reduceToCorners = (map: GameMap, path: TileRef[]): TileRef[] => {
  if (path.length <= 2) return [...path];
  const corners: TileRef[] = [path[0]];
  const dirOf = (p: TileRef, q: TileRef): number => Math.sign(map.x(q) - map.x(p)) * 2 + Math.sign(map.y(q) - map.y(p));
  for (let i = 1; i < path.length - 1; i += 1) {
    if (dirOf(path[i - 1], path[i]) !== dirOf(path[i], path[i + 1])) corners.push(path[i]);
  }
  corners.push(path[path.length - 1]);
  return corners;
};

const addAdjacency = (adjacency: Map<TileRef, TileRef[]>, from: TileRef, to: TileRef): void => {
  const list = adjacency.get(from);
  if (list) list.push(to);
  else adjacency.set(from, [to]);
};

/**
 * Compute the rail network for the current set of stations. Pure and
 * deterministic: per owner (only owners holding a factory lay track), a city/port
 * becomes a station only if a factory is within {@link RAIL_STATION_MAX_RANGE};
 * then every eligible station pair within the [min, max] range is routed by A\*
 * and linked when a route within the track cap exists.
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

  const minSq = RAIL_STATION_MIN_RANGE * RAIL_STATION_MIN_RANGE;
  const maxSq = RAIL_STATION_MAX_RANGE * RAIL_STATION_MAX_RANGE;
  const distSq = (p: TileRef, q: TileRef): number => {
    const dx = map.x(p) - map.x(q);
    const dy = map.y(p) - map.y(q);
    return dx * dx + dy * dy;
  };

  for (const owner of [...byOwner.keys()].sort((p, q) => p - q)) {
    const own = byOwner.get(owner)!;
    const factories = own.filter((s) => s.type === "factory");
    // The factory is the catalyst: without one, a player's cities/ports lay no
    // track even when they sit side by side.
    if (factories.length === 0) continue;

    // A factory is always a station; a city/port is a station only if some factory
    // sits within the max range of it.
    const eligible = own
      .filter((s) => s.type === "factory" || factories.some((f) => distSq(f.ref, s.ref) <= maxSq))
      .sort((p, q) => p.ref - q.ref);

    for (let i = 0; i < eligible.length; i += 1) {
      for (let j = i + 1; j < eligible.length; j += 1) {
        const a = eligible[i].ref;
        const b = eligible[j].ref;
        const d = distSq(a, b);
        if (d < minSq || d > maxSq) continue;
        const route = routeRail(map, a, b);
        if (!route) continue;
        edges.push({ owner, a, b, corners: route.corners, length: route.length });
        addAdjacency(adjacency, a, b);
        addAdjacency(adjacency, b, a);
      }
    }
  }

  return { edges, adjacency };
};

/** Stable key for the unordered station pair `{a, b}` (used to look up an edge). */
export const railPairKey = (a: TileRef, b: TileRef): string =>
  a < b ? `${a}-${b}` : `${b}-${a}`;
