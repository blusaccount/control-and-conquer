import type { MapDefinition, MapTerritoryDefinition, TeamId } from "./types.js";

export interface GridMapOptions {
  name: string;
  rows: number;
  cols: number;
  /** Canvas dimensions the polygons are laid out within. */
  width: number;
  height: number;
  /** Gap (px) trimmed from each cell edge so borders are visible. */
  inset?: number;
  troopsPerTile?: number;
}

const columnLabel = (row: number): string => String.fromCharCode(65 + (row % 26));

/**
 * Build a rectangular grid map. Ownership is split down the middle (left half
 * blue, right half red) and adjacency is 4-directional, so the result is always
 * symmetric and valid by construction.
 *
 * This is the seed for procedurally generated roguelite levels: the same
 * `MapDefinition` output feeds straight into `loadMap`.
 */
export const generateGridMap = (options: GridMapOptions): MapDefinition => {
  const { name, rows, cols, width, height } = options;
  if (rows < 1 || cols < 2) {
    throw new Error("Grid map needs at least 1 row and 2 columns.");
  }
  const inset = options.inset ?? 4;
  const troops = options.troopsPerTile ?? 8;
  const cellW = width / cols;
  const cellH = height / rows;
  const idAt = (row: number, col: number): string => `r${row}c${col}`;

  const territories: MapTerritoryDefinition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.round(col * cellW + inset);
      const y0 = Math.round(row * cellH + inset);
      const x1 = Math.round((col + 1) * cellW - inset);
      const y1 = Math.round((row + 1) * cellH - inset);

      const neighbors: string[] = [];
      if (row > 0) neighbors.push(idAt(row - 1, col));
      if (row < rows - 1) neighbors.push(idAt(row + 1, col));
      if (col > 0) neighbors.push(idAt(row, col - 1));
      if (col < cols - 1) neighbors.push(idAt(row, col + 1));

      const ownerId: TeamId = col < cols / 2 ? "blue" : "red";

      territories.push({
        id: idAt(row, col),
        name: `Sector ${columnLabel(row)}${col + 1}`,
        ownerId,
        troops,
        neighbors,
        polygon: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      });
    }
  }

  return { name, territories };
};
