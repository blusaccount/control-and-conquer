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
 *   - The network spans **all players** (the public wiki: railroads connect
 *     "with other non-military buildings", including other players' — that is
 *     what foreign/ally train stops are). A **factory** is the catalyst: a
 *     city/port becomes a station only when *some* factory — anyone's — sits
 *     within {@link RAIL_STATION_MAX_RANGE} of it; a factory is always a
 *     station. No factory on the map, no track.
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

/**
 * One railroad link. Its endpoints `a`/`b` are network **nodes** — usually
 * stations, but either may be a **junction**: a tile where a later station
 * tapped into the middle of this track, splitting the original edge in two.
 * Trains pay out only at station nodes; junctions are pass-through. `owner` is
 * the owner of the station whose joining laid this track (edges may span two
 * players' stations — the network is cross-player); it only drives rendering.
 */
export interface RailEdge {
  owner: PlayerId;
  /** Endpoint nodes (station or junction). Corners run from `a` to `b`. */
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
 * Memoised routes per map: terrain is immutable, so the A\* result between two
 * tiles (including "unroutable", stored as null) never changes for the life of
 * a map. Station churn re-runs `computeRailNetwork` often — every owner flip
 * of a station tile during a border war — and without this cache each rebuild
 * re-paid the full A\* (up to 60k heap expansions, worst for *failed* routes)
 * for links it had already routed, which profiled at ~75% of total server CPU
 * in the late game. Entries are shared arrays — callers must not mutate them.
 */
const routeCache = new WeakMap<GameMap, Map<string, TileRef[] | null>>();

const routeRailCached = (map: GameMap, a: TileRef, b: TileRef): TileRef[] | null => {
  let cache = routeCache.get(map);
  if (!cache) {
    cache = new Map();
    routeCache.set(map, cache);
  }
  const key = `${a}-${b}`;
  let path = cache.get(key);
  if (path === undefined) {
    path = routeRail(map, a, b);
    cache.set(key, path);
  }
  return path;
};

/**
 * Route a railroad from `a` to `b` with OpenFront's A\*: cardinal moves,
 * direction-change and water penalties, weighted Manhattan heuristic, and the
 * {@link RAIL_MAX_TRACK_LENGTH} track cap. Returns the **full tile path** (`a`…`b`
 * inclusive), or null if no route stays within the cap. Callers reduce the path
 * to turn-point corners and can split it at an interior tile to graft a junction.
 */
// ---------------------------------------------------------------------------
// A* search scratch. Any route obeying the RAIL_MAX_TRACK_LENGTH cap stays
// within that many steps of its start, so the whole search fits in a fixed
// (2·cap+1)² window around `a` — which lets the per-(tile,dir) g-scores and
// parent pointers live in flat, generation-stamped typed arrays allocated
// once, instead of per-call Maps. A *failed* route (the worst case — it
// explores the entire reachable window before giving up) profiled ~10× faster
// this way, and routing is the dominant cost of every network rebuild.
// ---------------------------------------------------------------------------
const WINDOW_SIDE = 2 * RAIL_MAX_TRACK_LENGTH + 1;
const WINDOW_STATES = WINDOW_SIDE * WINDOW_SIDE * 5; // (tile in window) × (dir 0-4)
let searchG: Float64Array | null = null;
let searchCame: Int32Array | null = null;
let searchStamp: Int32Array | null = null;
let searchGeneration = 0;

const routeRail = (map: GameMap, a: TileRef, b: TileRef): TileRef[] | null => {
  if (!isTrackableLand(map, a) || !isTrackableLand(map, b)) return null;
  const ax = map.x(a);
  const ay = map.y(a);
  const bx = map.x(b);
  const by = map.y(b);
  // Beyond the window, `b` cannot be reached under the track cap at all.
  if (Math.abs(bx - ax) + Math.abs(by - ay) > RAIL_MAX_TRACK_LENGTH) return null;
  const heuristic = (x: number, y: number): number =>
    (Math.abs(x - bx) + Math.abs(y - by)) * RAIL_HEURISTIC_WEIGHT;

  const g = (searchG ??= new Float64Array(WINDOW_STATES));
  const came = (searchCame ??= new Int32Array(WINDOW_STATES));
  const stamp = (searchStamp ??= new Int32Array(WINDOW_STATES).fill(-1));
  const generation = ++searchGeneration;
  // Window origin: tile (ox, oy) maps to local cell 0.
  const ox = ax - RAIL_MAX_TRACK_LENGTH;
  const oy = ay - RAIL_MAX_TRACK_LENGTH;
  // State = (tile within the window, arrival direction). dir 0 = start.
  const stateOf = (x: number, y: number, dir: number): number =>
    ((y - oy) * WINDOW_SIDE + (x - ox)) * 5 + dir;

  const start = stateOf(ax, ay, 0);
  g[start] = 0;
  came[start] = -1;
  stamp[start] = generation;
  const open = new NodeHeap();
  open.push({ f: heuristic(ax, ay), g: 0, len: 0, tile: a, dir: 0 });

  let expansions = 0;
  while (open.size > 0) {
    if (++expansions > RAIL_ASTAR_MAX_EXPANSIONS) return null;
    const cur = open.pop();
    const cx = map.x(cur.tile);
    const cy = map.y(cur.tile);
    const curKey = stateOf(cx, cy, cur.dir);
    if (stamp[curKey] === generation && cur.g > g[curKey]) continue; // stale heap entry

    if (cur.tile === b) {
      // Reconstruct the tile path by walking the parent states.
      const path: TileRef[] = [];
      for (let key = curKey; key !== -1; key = came[key]) {
        const cell = Math.floor(key / 5);
        path.push(map.ref((cell % WINDOW_SIDE) + ox, Math.floor(cell / WINDOW_SIDE) + oy));
      }
      path.reverse();
      return path;
    }

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
      // Off the search window ⇒ already over the cap; guarded above, but keep
      // the state math safe.
      if (nx < ox || ny < oy || nx >= ox + WINDOW_SIDE || ny >= oy + WINDOW_SIDE) continue;

      let step = 1;
      if (nextWater || nextShore) step += RAIL_WATER_PENALTY;
      if (cur.dir !== 0 && move.code !== cur.dir) step += RAIL_DIRECTION_CHANGE_PENALTY;

      const nextG = cur.g + step;
      const nextKey = stateOf(nx, ny, move.code);
      if (stamp[nextKey] !== generation || nextG < g[nextKey]) {
        stamp[nextKey] = generation;
        g[nextKey] = nextG;
        came[nextKey] = curKey;
        open.push({ f: nextG + heuristic(nx, ny), g: nextG, len: nextLen, tile: next, dir: move.code });
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
 * Union-find (disjoint set) over station refs, used to build a **spanning**
 * network: we only lay a link when it joins two parts that aren't already
 * connected. `find` path-compresses; `union` merges two roots. Ordering never
 * affects the final connectivity, so the network stays replay-stable.
 */
class DisjointSet {
  private readonly parent = new Map<TileRef, TileRef>();
  find(x: TileRef): TileRef {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root)!;
    // Path-compress the walked chain onto the root.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  /** True if `a` and `b` were already connected (no merge happened). */
  connected(a: TileRef, b: TileRef): boolean {
    return this.find(a) === this.find(b);
  }
  union(a: TileRef, b: TileRef): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** A rail link during the incremental build: its node endpoints and full path. */
interface BuildEdge {
  a: TileRef;
  b: TileRef;
  /** Every tile from `a` to `b` inclusive, so the edge can be split at a junction. */
  path: TileRef[];
}

/**
 * Compute the rail network for the current set of stations. Pure and
 * deterministic. The network is **global across owners** (the wiki's
 * cross-player connections): every factory is a station, and a city/port is a
 * station once *any* factory sits within {@link RAIL_STATION_MAX_RANGE}.
 *
 * The network is grown **incrementally**, exactly like OpenFront's `connectStation`
 * rather than as a full mesh: stations join in ref order and each new station
 * connects to the nearest thing already on the network — another station **or the
 * nearest point on existing track** (a **T-junction**, splitting that edge) —
 * skipping any target it can already reach. A station in range of two separate
 * sub-networks bridges (merges) them. The result is a clean spanning tree of
 * single connections, with mid-track junctions instead of long parallel tracks —
 * OpenFront's "snap to existing rails, else nearest station" behaviour.
 */
export const computeRailNetwork = (
  map: GameMap,
  stations: readonly RailStation[],
): RailNetwork => {
  const edges: RailEdge[] = [];
  const adjacency = new Map<TileRef, TileRef[]>();

  const minSq = RAIL_STATION_MIN_RANGE * RAIL_STATION_MIN_RANGE;
  const maxSq = RAIL_STATION_MAX_RANGE * RAIL_STATION_MAX_RANGE;
  const distSq = (p: TileRef, q: TileRef): number => {
    const dx = map.x(p) - map.x(q);
    const dy = map.y(p) - map.y(q);
    return dx * dx + dy * dy;
  };

  const factories = stations.filter((s) => s.type === "factory");
  // The factory is the catalyst: with none on the map, nobody's cities/ports
  // lay any track even when they sit side by side.
  if (factories.length === 0) return { edges, adjacency };

  // A factory is always a station; a city/port is a station only if some
  // factory — anyone's — sits within the max range of it.
  const eligible = stations
    .filter((s) => s.type === "factory" || factories.some((f) => distSq(f.ref, s.ref) <= maxSq))
    .sort((p, q) => p.ref - q.ref);
  const ownerOf = new Map<TileRef, PlayerId>(eligible.map((s) => [s.ref, s.owner]));

  const eList: BuildEdge[] = [];
  const edgeOwner: PlayerId[] = []; // laid-by owner per eList entry, for rendering
  const nodes = new Set<TileRef>(); // stations + grafted junctions
  const forest = new DisjointSet();

  // Split edge `idx` at interior tile `j`, turning it into a→j and j→b and
  // making `j` a junction node. `j` must lie strictly inside the edge's path.
  const splitEdge = (idx: number, j: TileRef): void => {
    const e = eList[idx];
    const m = e.path.indexOf(j);
    eList[idx] = { a: e.a, b: j, path: e.path.slice(0, m + 1) };
    eList.push({ a: j, b: e.b, path: e.path.slice(m) });
    edgeOwner.push(edgeOwner[idx]);
    nodes.add(j);
    forest.union(e.a, j); // same component; just record the new node
  };

  for (const station of eligible) {
    const s = station.ref;
    nodes.add(s);
    forest.find(s); // register in the disjoint set

    // Index interior track tiles → their edge, rebuilt each connection so it
    // reflects freshly grafted junctions. Node tiles are excluded (connecting
    // to a node is handled by the node scan, not as a mid-track snap).
    const failed = new Set<TileRef>(); // targets whose route couldn't be laid
    // A station whose nearest targets keep failing almost certainly can't
    // route to *anything* (blocked terrain, over the track cap in every
    // direction) — and each failure is a worst-case A* that explores its whole
    // search window. Give up after a few, instead of burning one full search
    // per candidate track tile in range (profiled as multi-second ticks).
    let routeFailures = 0;
    const MAX_ROUTE_FAILURES = 4;
    for (;;) {
      if (routeFailures >= MAX_ROUTE_FAILURES) break;
      const tileToEdge = new Map<TileRef, number>();
      eList.forEach((e, idx) => {
        for (let i = 1; i < e.path.length - 1; i += 1) {
          if (!nodes.has(e.path[i])) tileToEdge.set(e.path[i], idx);
        }
      });

      // Nearest unconnected target within range: a node (respecting the min
      // station spacing) or a mid-track tile (a T-junction, no min spacing).
      let best: { ref: TileRef; d: number; edgeIdx: number | null } | null = null;
      const consider = (ref: TileRef, d: number, edgeIdx: number | null): void => {
        if (best === null || d < best.d || (d === best.d && ref < best.ref)) best = { ref, d, edgeIdx };
      };
      for (const n of nodes) {
        if (n === s || failed.has(n) || forest.connected(s, n)) continue;
        const d = distSq(s, n);
        if (d < minSq || d > maxSq) continue;
        consider(n, d, null);
      }
      for (const [tile, idx] of tileToEdge) {
        if (failed.has(tile) || forest.connected(s, eList[idx].a)) continue;
        const d = distSq(s, tile);
        if (d > maxSq) continue;
        consider(tile, d, idx);
      }
      if (best === null) break;

      const target: { ref: TileRef; d: number; edgeIdx: number | null } = best;
      const path = routeRailCached(map, s, target.ref);
      if (!path) {
        failed.add(target.ref); // unroutable (blocked/over the cap) — try the next
        routeFailures += 1;
        continue;
      }
      if (target.edgeIdx !== null) splitEdge(target.edgeIdx, target.ref);
      forest.union(s, target.ref);
      eList.push({ a: s, b: target.ref, path });
      edgeOwner.push(station.owner);
    }
  }

  eList.forEach((e, idx) => {
    edges.push({
      owner: edgeOwner[idx] ?? ownerOf.get(e.a) ?? ownerOf.get(e.b)!,
      a: e.a,
      b: e.b,
      corners: reduceToCorners(map, e.path),
      length: e.path.length - 1,
    });
    addAdjacency(adjacency, e.a, e.b);
    addAdjacency(adjacency, e.b, e.a);
  });

  return { edges, adjacency };
};

/** Stable key for the unordered station pair `{a, b}` (used to look up an edge). */
export const railPairKey = (a: TileRef, b: TileRef): string =>
  a < b ? `${a}-${b}` : `${b}-${a}`;
