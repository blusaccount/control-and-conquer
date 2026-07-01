/**
 * Custom vector icons for buildings and ships, replacing Unicode emoji
 * glyphs (which render inconsistently across OS/browser font stacks).
 *
 * Each icon is defined ONCE as a small set of path segments in a -1..1 unit
 * square, then rendered two ways from that single source:
 *  - {@link drawIcon}: painted straight onto the map canvas, using whatever
 *    `ctx.fillStyle` the caller has already set — recolouring per player is
 *    just picking a fill colour before the call, no image/pixel processing.
 *  - {@link iconSvgMarkup}: an inline `<svg>` with `fill="currentColor"` for
 *    HTML UI (build menu, HUD counters) — recolouring there is plain CSS
 *    `color`.
 */

export type IconKey = "city" | "port" | "factory" | "fort" | "warship" | "ship";

type Seg =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "Q"; cx: number; cy: number; x: number; y: number }
  | { op: "Z" }
  | { op: "CIRCLE"; cx: number; cy: number; r: number };

/** A set of segments filled together under one fill rule (lets a shape carve holes out of itself, e.g. a ring or a window, without positive sub-shapes cancelling each other out). */
interface Group {
  rule: CanvasFillRule;
  segs: Seg[];
}

const rectSegs = (x0: number, y0: number, x1: number, y1: number): Seg[] => [
  { op: "M", x: x0, y: y0 },
  { op: "L", x: x1, y: y0 },
  { op: "L", x: x1, y: y1 },
  { op: "L", x: x0, y: y1 },
  { op: "Z" },
];

/** House silhouette with a cut-out door — the door reveals the owner-coloured badge behind it. */
const cityDef = (): Group[] => [
  {
    rule: "evenodd",
    segs: [
      { op: "M", x: 0, y: -0.95 },
      { op: "L", x: 0.85, y: -0.15 },
      { op: "L", x: 0.6, y: -0.15 },
      { op: "L", x: 0.6, y: 0.85 },
      { op: "L", x: -0.6, y: 0.85 },
      { op: "L", x: -0.6, y: -0.15 },
      { op: "L", x: -0.85, y: -0.15 },
      { op: "Z" },
      ...rectSegs(-0.18, 0.32, 0.18, 0.85),
    ],
  },
];

/** Anchor: a ring, shaft, crossbar and a curved bowl (a smooth band, not two
 * straight diverging legs, so it doesn't read as a stick figure at small sizes). */
const portDef = (): Group[] => {
  // Bowl centre sits at the shaft's bottom, so 0deg/180deg (its horizontal
  // ends) line up with the shaft and 90deg (screen-down, since y grows
  // downward) is the deepest point of the curve — a connected U, not two
  // separate diagonal legs.
  const bowlCy = 0.32;
  const outerR = 0.45;
  const innerR = 0.26;
  const startDeg = 180;
  const endDeg = 0;
  const steps = 10;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const bowl: Seg[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = toRad(startDeg + ((endDeg - startDeg) * i) / steps);
    bowl.push({ op: i === 0 ? "M" : "L", x: Math.cos(a) * outerR, y: bowlCy + Math.sin(a) * outerR });
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = toRad(startDeg + ((endDeg - startDeg) * i) / steps);
    bowl.push({ op: "L", x: Math.cos(a) * innerR, y: bowlCy + Math.sin(a) * innerR });
  }
  bowl.push({ op: "Z" });
  return [
    { rule: "evenodd", segs: [{ op: "CIRCLE", cx: 0, cy: -0.65, r: 0.24 }, { op: "CIRCLE", cx: 0, cy: -0.65, r: 0.12 }] },
    {
      rule: "nonzero",
      // Shaft reaches down into the bowl's curve so the two merge with no gap.
      segs: [...rectSegs(-0.07, -0.4, 0.07, 0.55), ...rectSegs(-0.32, -0.3, 0.32, -0.18), ...bowl],
    },
  ];
};

/** Cog: 8 teeth around a ringed body. */
const factoryDef = (): Group[] => {
  const teeth = 8;
  const innerR = 0.7;
  const outerR = 0.88;
  const halfAngle = ((Math.PI / teeth) * 0.6) / 2;
  const bodyR = 0.68;
  const holeR = 0.3;
  const teethSegs: Seg[] = [];
  for (let i = 0; i < teeth; i += 1) {
    const a = (i / teeth) * Math.PI * 2;
    const a0 = a - halfAngle;
    const a1 = a + halfAngle;
    teethSegs.push(
      { op: "M", x: Math.cos(a0) * innerR, y: Math.sin(a0) * innerR },
      { op: "L", x: Math.cos(a0) * outerR, y: Math.sin(a0) * outerR },
      { op: "L", x: Math.cos(a1) * outerR, y: Math.sin(a1) * outerR },
      { op: "L", x: Math.cos(a1) * innerR, y: Math.sin(a1) * innerR },
      { op: "Z" },
    );
  }
  return [
    { rule: "nonzero", segs: [...teethSegs, { op: "CIRCLE", cx: 0, cy: 0, r: bodyR }] },
    { rule: "evenodd", segs: [{ op: "CIRCLE", cx: 0, cy: 0, r: bodyR }, { op: "CIRCLE", cx: 0, cy: 0, r: holeR }] },
  ];
};

/** Shield: flat top, curved sides tapering to a point. */
const fortDef = (): Group[] => [
  {
    rule: "nonzero",
    segs: [
      { op: "M", x: -0.7, y: -0.7 },
      { op: "L", x: 0.7, y: -0.7 },
      { op: "L", x: 0.7, y: 0.05 },
      { op: "Q", cx: 0.7, cy: 0.55, x: 0, y: 0.9 },
      { op: "Q", cx: -0.7, cy: 0.55, x: -0.7, y: 0.05 },
      { op: "Z" },
    ],
  },
];

/** Hull + bridge + forward cannon barrel — a coastal warship in side view. */
const warshipDef = (): Group[] => [
  {
    rule: "nonzero",
    segs: [
      { op: "M", x: -0.9, y: 0.35 },
      { op: "L", x: 0.9, y: 0.35 },
      { op: "L", x: 0.65, y: 0.7 },
      { op: "L", x: -0.65, y: 0.7 },
      { op: "Z" },
      ...rectSegs(-0.25, -0.2, 0.25, 0.35),
      ...rectSegs(0.2, -0.06, 0.8, 0.06),
    ],
  },
];

/** Hull + mast + sail — the plain transport/trade ship. */
const shipDef = (): Group[] => [
  {
    rule: "nonzero",
    segs: [
      { op: "M", x: -0.9, y: 0.35 },
      { op: "L", x: 0.9, y: 0.35 },
      { op: "L", x: 0.65, y: 0.7 },
      { op: "L", x: -0.65, y: 0.7 },
      { op: "Z" },
      ...rectSegs(-0.06, -0.85, 0.06, 0.35),
      { op: "M", x: 0.06, y: -0.8 },
      { op: "L", x: 0.6, y: 0.1 },
      { op: "L", x: 0.06, y: 0.1 },
      { op: "Z" },
    ],
  },
];

const ICONS: Record<IconKey, () => Group[]> = {
  city: cityDef,
  port: portDef,
  factory: factoryDef,
  fort: fortDef,
  warship: warshipDef,
  ship: shipDef,
};

const cache = new Map<IconKey, Group[]>();
const iconGroups = (key: IconKey): Group[] => {
  let groups = cache.get(key);
  if (!groups) {
    groups = ICONS[key]();
    cache.set(key, groups);
  }
  return groups;
};

const applyToCtx = (ctx: CanvasRenderingContext2D, segs: Seg[]): void => {
  for (const s of segs) {
    switch (s.op) {
      case "M":
        ctx.moveTo(s.x, s.y);
        break;
      case "L":
        ctx.lineTo(s.x, s.y);
        break;
      case "Q":
        ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y);
        break;
      case "Z":
        ctx.closePath();
        break;
      case "CIRCLE":
        ctx.moveTo(s.cx + s.r, s.cy);
        ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
        break;
    }
  }
};

/**
 * Paint icon `key` centred at `(cx, cy)` with half-size `size` (device px),
 * using the caller's current `ctx.fillStyle`. Call with white for the
 * OpenFront-style badge-marker look, or a player colour directly (e.g. for
 * ships, which have no coloured badge behind them).
 */
export function drawIcon(ctx: CanvasRenderingContext2D, key: IconKey, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  for (const g of iconGroups(key)) {
    ctx.beginPath();
    applyToCtx(ctx, g.segs);
    ctx.fill(g.rule);
  }
  ctx.restore();
}

const segToSvg = (s: Seg): string => {
  switch (s.op) {
    case "M":
      return `M${s.x} ${s.y}`;
    case "L":
      return `L${s.x} ${s.y}`;
    case "Q":
      return `Q${s.cx} ${s.cy} ${s.x} ${s.y}`;
    case "Z":
      return "Z";
    case "CIRCLE":
      return `M${s.cx + s.r} ${s.cy} A${s.r} ${s.r} 0 1 0 ${s.cx - s.r} ${s.cy} A${s.r} ${s.r} 0 1 0 ${s.cx + s.r} ${s.cy} Z`;
  }
};

/**
 * Inline `<svg>` markup for icon `key`, sized to `px` CSS pixels, filled with
 * `currentColor` — drop it in a span/button and set CSS `color` to recolour.
 */
export function iconSvgMarkup(key: IconKey, px: number): string {
  const paths = iconGroups(key)
    .map((g) => `<path fill-rule="${g.rule}" d="${g.segs.map(segToSvg).join(" ")}"/>`)
    .join("");
  return `<svg viewBox="-1 -1 2 2" width="${px}" height="${px}" fill="currentColor" aria-hidden="true">${paths}</svg>`;
}
