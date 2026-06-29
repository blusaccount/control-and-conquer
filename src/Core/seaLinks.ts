import type { GameMap, TileRef } from "./GameMap.js";

/**
 * Precomputed amphibious-crossing adjacency for a static {@link GameMap}.
 *
 * Land expansion in the raster engine follows 4-connected land borders, which
 * makes open water a hard wall. To let fronts cross narrow seas (the
 * openfront-style "boat" mechanic) we precompute, once per map, every pair of
 * passable coastal tiles separated by no more than `maxCrossing` tiles of open
 * water. The conflict engine then treats those pairs as extra neighbours when
 * looking for an attacker's frontier.
 *
 * Terrain is immutable, so these links never change during a match and are
 * built a single time. The relation is symmetric: if A can land on B, B can
 * land on A.
 */
/** A single amphibious link: the reachable coastal tile and the water distance. */
export interface SeaLink {
  ref: TileRef;
  /** Water tiles crossed to reach `ref` (1 = tiles share a one-tile strait). */
  dist: number;
}

export class SeaLinks {
  /** source TileRef -> links sorted by ascending target TileRef. */
  private readonly links: Map<TileRef, SeaLink[]>;
  /** The `maxCrossing` the graph was built with — the widest link it can hold. */
  readonly maxCrossing: number;

  private constructor(links: Map<TileRef, SeaLink[]>, maxCrossing: number) {
    this.links = links;
    this.maxCrossing = maxCrossing;
  }

  /** Every coastal tile reachable from `ref` by a crossing (up to the built max). */
  neighborsOf(ref: TileRef): readonly TileRef[] {
    const list = this.links.get(ref);
    return list ? list.map((l) => l.ref) : EMPTY;
  }

  /**
   * Coastal tiles reachable from `ref` within `maxDist` water tiles — the
   * range-aware lookup the frontier scan uses so a player's sea reach can be
   * scaled by perks (e.g. Sea God). `maxDist` is clamped to the built maximum.
   */
  neighborsWithin(ref: TileRef, maxDist: number): readonly TileRef[] {
    const list = this.links.get(ref);
    if (!list) return EMPTY;
    if (maxDist >= this.maxCrossing) return list.map((l) => l.ref);
    const out: TileRef[] = [];
    for (const link of list) if (link.dist <= maxDist) out.push(link.ref);
    return out;
  }

  /** True if `a` and `b` are connected by a sea crossing. */
  areLinked(a: TileRef, b: TileRef): boolean {
    return (this.links.get(a)?.some((l) => l.ref === b)) ?? false;
  }

  /**
   * Build the crossing graph for a map. A tile qualifies as a coast endpoint
   * when it is passable land bordering water. From each such tile we BFS through
   * water tiles up to `maxCrossing` steps; every passable coastal land tile we
   * reach becomes a link recording the water distance. `maxCrossing <= 0` yields
   * an empty graph (crossing disabled).
   */
  static build(map: GameMap, maxCrossing: number): SeaLinks {
    const links = new Map<TileRef, SeaLink[]>();
    if (maxCrossing <= 0) return new SeaLinks(links, 0);

    const isCoast = (ref: TileRef): boolean =>
      map.isLand(ref) && !map.isImpassable(ref) && map.isShore(ref);

    // Reused BFS scratch buffers, cleared lazily via a generation stamp so we
    // don't reallocate per source tile.
    const distance = new Int32Array(map.size).fill(-1);
    const stamp = new Int32Array(map.size).fill(-1);
    let generation = 0;
    const queue: TileRef[] = [];

    for (let source = 0; source < map.size; source += 1) {
      if (!isCoast(source)) continue;

      generation += 1;
      queue.length = 0;
      // Target coastal tile -> minimum water distance at which it was reached.
      const reached = new Map<TileRef, number>();

      // Seed the BFS with the water tiles directly bordering the source.
      for (const n of map.neighbors(source)) {
        if (map.isWater(n) && stamp[n] !== generation) {
          stamp[n] = generation;
          distance[n] = 1;
          queue.push(n);
        }
      }

      for (let head = 0; head < queue.length; head += 1) {
        const water = queue[head];
        const d = distance[water];
        for (const n of map.neighbors(water)) {
          if (map.isWater(n)) {
            if (d < maxCrossing && stamp[n] !== generation) {
              stamp[n] = generation;
              distance[n] = d + 1;
              queue.push(n);
            }
          } else if (isCoast(n) && n !== source) {
            // Landing on the far bank: keep the shortest crossing to this target.
            const existing = reached.get(n);
            if (existing === undefined || d < existing) reached.set(n, d);
          }
        }
      }

      if (reached.size > 0) {
        const list = [...reached.entries()]
          .map(([ref, dist]) => ({ ref, dist }))
          .sort((a, b) => a.ref - b.ref);
        links.set(source, list);
      }
    }

    return new SeaLinks(links, maxCrossing);
  }
}

const EMPTY: readonly TileRef[] = [];
