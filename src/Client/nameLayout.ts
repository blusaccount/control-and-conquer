/**
 * Nation-name placement — port of OpenFront.io's "largest inscribed rectangle"
 * label layout (see its `NameBoxCalculator`).
 *
 * A simple centroid of a player's tiles can land *outside* the territory when
 * the shape is concave or split (e.g. an island chain), putting the label on
 * enemy ground or open sea. Instead we find the largest axis-aligned rectangle
 * that fits entirely inside the player's mass and centre the name there — a
 * stable, always-interior anchor that scales with how much land the player
 * holds. The rectangle search runs on a downsampled grid so it stays cheap even
 * on million-tile maps.
 *
 * Pure and DOM-free so it can be unit-tested without a canvas.
 */

/** A computed label anchor in tile space. `size` is the font height in tiles. */
export interface NameAnchor {
  playerId: number;
  /** Tile-space centre of the inscribed rectangle (already nudged for baseline). */
  x: number;
  y: number;
  /** Font height in tile units; the renderer multiplies by the camera scale. */
  size: number;
}

/** The players to lay out, with the name length used for font sizing. */
export interface NameLayoutPlayer {
  playerId: number;
  nameLength: number;
}

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Pick a downsample factor from the territory's smaller span. Bigger masses are
 * sampled more coarsely so the rectangle search stays roughly constant-time
 * regardless of map size. Mirrors OpenFront's thresholds.
 */
const scalingFactorFor = (span: number): number => {
  if (span < 25) return 1;
  if (span < 50) return 2;
  if (span < 100) return 4;
  if (span < 250) return 8;
  if (span < 500) return 16;
  return 32;
};

/** Font height (in tiles) that fits `nameLength` chars inside `rect` (tiles). */
const fontSizeFor = (rect: Rectangle, nameLength: number): number => {
  const widthConstrained = (rect.width / Math.max(1, nameLength)) * 2;
  const heightConstrained = rect.height / 3;
  return Math.min(widthConstrained, heightConstrained);
};

/**
 * Largest all-`true` rectangle in a boolean column-major grid, via the classic
 * "largest rectangle in a histogram" stack sweep over each row. Returns the
 * rectangle in grid coordinates.
 */
const findLargestInscribedRectangle = (grid: boolean[][]): Rectangle => {
  const cols = grid.length;
  if (cols === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const rows = grid[0].length;
  const heights = new Array<number>(cols).fill(0);
  let best: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      heights[col] = grid[col][row] ? heights[col] + 1 : 0;
    }
    const rowRect = largestRectangleInHistogram(heights);
    if (rowRect.width * rowRect.height > best.width * best.height) {
      best = {
        x: rowRect.x,
        y: row - rowRect.height + 1,
        width: rowRect.width,
        height: rowRect.height,
      };
    }
  }
  return best;
};

/** Largest rectangle under a histogram, returned as {x,width,height} (y unused). */
const largestRectangleInHistogram = (widths: number[]): Rectangle => {
  const stack: number[] = [];
  let maxArea = 0;
  let best: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let i = 0; i <= widths.length; i += 1) {
    const h = i === widths.length ? 0 : widths[i];
    while (stack.length > 0 && h < widths[stack[stack.length - 1]]) {
      const height = widths[stack.pop()!];
      const width = stack.length === 0 ? i : i - stack[stack.length - 1] - 1;
      if (height * width > maxArea) {
        maxArea = height * width;
        best = {
          x: stack.length === 0 ? 0 : stack[stack.length - 1] + 1,
          y: 0,
          width,
          height,
        };
      }
    }
    stack.push(i);
  }
  return best;
};

/**
 * Compute a name anchor for every requested player from the ownership raster.
 *
 * One pass collects each owner's bounding box; then each player's mass is
 * downsampled into a boolean grid and its largest inscribed rectangle located.
 * Players with no tiles are skipped (no entry returned).
 */
export const computeNameAnchors = (
  width: number,
  height: number,
  owner: Uint16Array,
  players: readonly NameLayoutPlayer[],
): NameAnchor[] => {
  if (players.length === 0) return [];
  const wanted = new Map<number, NameLayoutPlayer>();
  for (const p of players) wanted.set(p.playerId, p);

  // Pass 1: bounding box per wanted owner.
  const boxes = new Map<number, BoundingBox>();
  for (let i = 0; i < owner.length; i += 1) {
    const pid = owner[i];
    if (pid === 0 || !wanted.has(pid)) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const box = boxes.get(pid);
    if (box === undefined) {
      boxes.set(pid, { minX: x, minY: y, maxX: x, maxY: y });
    } else {
      if (x < box.minX) box.minX = x;
      else if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      else if (y > box.maxY) box.maxY = y;
    }
  }

  const anchors: NameAnchor[] = [];
  for (const [pid, box] of boxes) {
    const player = wanted.get(pid)!;
    const bw = box.maxX - box.minX;
    const bh = box.maxY - box.minY;
    const sf = scalingFactorFor(Math.min(bw, bh));

    // Downsample the player's mass: one sample tile per scaled cell.
    const gw = Math.floor(bw / sf) + 1;
    const gh = Math.floor(bh / sf) + 1;
    const grid: boolean[][] = Array.from({ length: gw }, () => new Array<boolean>(gh).fill(false));
    for (let gx = 0; gx < gw; gx += 1) {
      const tx = box.minX + gx * sf;
      for (let gy = 0; gy < gh; gy += 1) {
        const ty = box.minY + gy * sf;
        if (tx < width && ty < height && owner[ty * width + tx] === pid) {
          grid[gx][gy] = true;
        }
      }
    }

    const rectGrid = findLargestInscribedRectangle(grid);
    // Back to tile units.
    const rect: Rectangle = {
      x: rectGrid.x * sf,
      y: rectGrid.y * sf,
      width: rectGrid.width * sf,
      height: rectGrid.height * sf,
    };
    const fontSize = fontSizeFor(rect, player.nameLength);
    const cx = box.minX + rect.x + rect.width / 2;
    const cy = box.minY + rect.y + rect.height / 2 - fontSize / 3;
    anchors.push({ playerId: pid, x: cx, y: cy, size: fontSize });
  }

  return anchors;
};
