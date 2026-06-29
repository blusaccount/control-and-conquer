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
export class SeaLinks {
  /** source TileRef -> sorted list of coastal TileRefs reachable across water. */
  private readonly links: Map<TileRef, TileRef[]>;

  private constructor(links: Map<TileRef, TileRef[]>) {
    this.links = links;
  }

  /** Coastal tiles reachable from `ref` by an amphibious crossing (may be empty). */
  neighborsOf(ref: TileRef): readonly TileRef[] {
    return this.links.get(ref) ?? EMPTY;
  }

  /** True if `a` and `b` are connected by a sea crossing. */
  areLinked(a: TileRef, b: TileRef): boolean {
    return (this.links.get(a)?.includes(b)) ?? false;
  }

  /**
   * Build the crossing graph for a map. A tile qualifies as a coast endpoint
   * when it is passable land bordering water. From each such tile we BFS through
   * water tiles up to `maxCrossing` steps; every passable coastal land tile we
   * reach becomes a link. `maxCrossing <= 0` yields an empty graph (crossing
   * disabled).
   */
  static build(map: GameMap, maxCrossing: number): SeaLinks {
    const links = new Map<TileRef, TileRef[]>();
    if (maxCrossing <= 0) return new SeaLinks(links);

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
      const reached = new Set<TileRef>();

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
            // Landing on the far bank: record the link once per target.
            reached.add(n);
          }
        }
      }

      if (reached.size > 0) {
        links.set(source, [...reached].sort((a, b) => a - b));
      }
    }

    return new SeaLinks(links);
  }
}

const EMPTY: readonly TileRef[] = [];
