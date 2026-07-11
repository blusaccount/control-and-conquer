import {
  CUSTOM_MAP_MAX_NAME,
  CUSTOM_MAP_MIN_LAND_TILES,
  decodeCustomMapFile,
  encodeCustomMapFile,
  type CustomMapData,
} from "../Core/customMap.js";
import { IMPASSABLE_MAGNITUDE } from "../Core/terrainCodec.js";

/**
 * In-browser map editor: OpenFront lets mapmakers paint terrain into an image
 * and run it through an offline generator — this is the same workflow without
 * leaving the menu. The player paints water, land, highlands, rock and rivers
 * with classic paint tools, downloads the result as a `.ccmap` file (the file
 * IS the persistence — nothing is stored server-side), and can re-import that
 * file any time to keep editing or to play it again.
 *
 * The editor state is the custom-map cell grid itself (one byte per tile, see
 * `Core/customMap.ts`), rendered 1:1 into a canvas that CSS scales up with
 * `image-rendering: pixelated`. Painting mutates cells and repaints on the
 * next animation frame.
 */

interface EditorTool {
  id: string;
  label: string;
  title: string;
  /** Cell value this tool paints (see customMap cell semantics). */
  cell: number;
  /** Lock the brush to a fixed radius (the river tool paints thin channels). */
  fixedRadius?: number;
}

const TOOLS: readonly EditorTool[] = [
  { id: "ocean", label: "🌊 Water", title: "Paint open water", cell: 0 },
  { id: "river", label: "〰 River", title: "Thin 1-tile water channel, whatever the brush size", cell: 0, fixedRadius: 0 },
  { id: "plains", label: "🌿 Plains", title: "Low, fast-to-cross land", cell: 5 },
  { id: "highland", label: "⛰ Highland", title: "Elevated land (slower to cross)", cell: 18 },
  { id: "rock", label: "🗻 Rock", title: "Impassable peaks — nobody can hold these", cell: IMPASSABLE_MAGNITUDE },
];

/** Selectable grid presets — small enough to paint by hand, big enough to play. */
const SIZE_PRESETS: readonly { label: string; width: number; height: number }[] = [
  { label: "Small — 192×120", width: 192, height: 120 },
  { label: "Medium — 288×180", width: 288, height: 180 },
  { label: "Large — 384×240", width: 384, height: 240 },
  { label: "Huge — 512×320", width: 512, height: 320 },
];

/** Flat preview colours per cell, echoing the in-game palette. */
const COLOR_WATER: readonly [number, number, number] = [71, 133, 181];
const COLOR_PLAINS: readonly [number, number, number] = [190, 220, 138];
const COLOR_HIGHLAND: readonly [number, number, number] = [200, 183, 138];
const COLOR_ROCK: readonly [number, number, number] = [60, 60, 60];

const cellColor = (cell: number): readonly [number, number, number] => {
  if (cell === 0) return COLOR_WATER;
  if (cell === IMPASSABLE_MAGNITUDE) return COLOR_ROCK;
  return cell < 10 ? COLOR_PLAINS : COLOR_HIGHLAND;
};

export interface MapEditorOptions {
  /** Called with the serialized `.ccmap` file when the player hits Play. */
  onPlay(file: string): void;
}

/** Wire the map-editor panel in the main menu. Safe no-op if the markup is absent. */
export const initMapEditor = (options: MapEditorOptions): void => {
  const els = {
    toggle: document.querySelector<HTMLButtonElement>("#editorToggleButton"),
    panel: document.querySelector<HTMLDivElement>("#editorPanel"),
    name: document.querySelector<HTMLInputElement>("#editorNameInput"),
    size: document.querySelector<HTMLSelectElement>("#editorSizeSelect"),
    tools: document.querySelector<HTMLDivElement>("#editorTools"),
    brush: document.querySelector<HTMLInputElement>("#editorBrushInput"),
    brushOut: document.querySelector<HTMLOutputElement>("#editorBrushOutput"),
    canvas: document.querySelector<HTMLCanvasElement>("#editorCanvas"),
    fillLand: document.querySelector<HTMLButtonElement>("#editorFillLandButton"),
    fillOcean: document.querySelector<HTMLButtonElement>("#editorFillOceanButton"),
    play: document.querySelector<HTMLButtonElement>("#editorPlayButton"),
    exportBtn: document.querySelector<HTMLButtonElement>("#editorExportButton"),
    importBtn: document.querySelector<HTMLButtonElement>("#editorImportButton"),
    importFile: document.querySelector<HTMLInputElement>("#editorImportFile"),
    status: document.querySelector<HTMLParagraphElement>("#editorStatus"),
  };
  if (!els.panel || !els.canvas || !els.tools) return;
  const canvas = els.canvas;
  const context = canvas.getContext("2d");
  if (!context) return;

  // --- state ---------------------------------------------------------------
  let width = SIZE_PRESETS[1].width;
  let height = SIZE_PRESETS[1].height;
  let cells: Uint8Array = new Uint8Array(width * height); // all water
  let activeTool: EditorTool = TOOLS.find((t) => t.id === "plains") ?? TOOLS[0];
  let painting = false;
  let lastCell: { x: number; y: number } | null = null;
  let frame = 0;
  let anyPaintSinceReset = false;

  const setStatus = (text: string): void => {
    if (els.status) els.status.textContent = text;
  };

  const landCount = (): number => {
    let n = 0;
    for (let i = 0; i < cells.length; i += 1) {
      if (cells[i] > 0 && cells[i] < IMPASSABLE_MAGNITUDE) n += 1;
    }
    return n;
  };

  // --- rendering -----------------------------------------------------------
  let image = context.createImageData(width, height);

  const paintFrame = (): void => {
    frame = 0;
    const data = image.data;
    for (let i = 0; i < cells.length; i += 1) {
      const [r, g, b] = cellColor(cells[i]);
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  };

  const requestRender = (): void => {
    if (frame === 0) frame = requestAnimationFrame(paintFrame);
  };

  const resetGrid = (w: number, h: number, next?: Uint8Array): void => {
    width = w;
    height = h;
    cells = next ?? new Uint8Array(w * h);
    canvas.width = w;
    canvas.height = h;
    image = context.createImageData(w, h);
    anyPaintSinceReset = false;
    lastCell = null;
    requestRender();
  };

  // --- painting ------------------------------------------------------------
  const brushRadius = (): number => {
    if (activeTool.fixedRadius !== undefined) return activeTool.fixedRadius;
    return Math.max(0, Number(els.brush?.value ?? 4) - 1);
  };

  const stamp = (cx: number, cy: number): void => {
    const r = brushRadius();
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        cells[y * width + x] = activeTool.cell;
      }
    }
    anyPaintSinceReset = true;
  };

  /** Stamp along the whole segment so fast strokes leave no gaps. */
  const paintLine = (from: { x: number; y: number } | null, to: { x: number; y: number }): void => {
    if (!from) {
      stamp(to.x, to.y);
    } else {
      const dist = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
      const steps = Math.max(1, dist);
      for (let k = 0; k <= steps; k += 1) {
        stamp(
          Math.round(from.x + ((to.x - from.x) * k) / steps),
          Math.round(from.y + ((to.y - from.y) * k) / steps),
        );
      }
    }
    requestRender();
  };

  const eventCell = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.floor(((event.clientX - rect.left) / rect.width) * width),
      y: Math.floor(((event.clientY - rect.top) / rect.height) * height),
    };
  };

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    painting = true;
    const cell = eventCell(event);
    paintLine(null, cell);
    lastCell = cell;
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!painting) return;
    const cell = eventCell(event);
    paintLine(lastCell, cell);
    lastCell = cell;
  });
  const endStroke = (): void => {
    painting = false;
    lastCell = null;
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  // --- toolbar -------------------------------------------------------------
  els.tools.innerHTML = TOOLS.map(
    (tool) =>
      `<button class="editor-tool${tool === activeTool ? " selected" : ""}" type="button" ` +
      `data-tool="${tool.id}" title="${tool.title}" aria-pressed="${tool === activeTool}">${tool.label}</button>`,
  ).join("");
  for (const button of els.tools.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.addEventListener("click", () => {
      const tool = TOOLS.find((t) => t.id === button.getAttribute("data-tool"));
      if (!tool) return;
      activeTool = tool;
      for (const other of els.tools!.querySelectorAll<HTMLButtonElement>(".editor-tool")) {
        const selected = other === button;
        other.classList.toggle("selected", selected);
        other.setAttribute("aria-pressed", String(selected));
      }
    });
  }

  const renderBrushOutput = (): void => {
    if (els.brushOut && els.brush) els.brushOut.textContent = els.brush.value;
  };
  els.brush?.addEventListener("input", renderBrushOutput);
  renderBrushOutput();

  // --- size presets ----------------------------------------------------------
  if (els.size) {
    els.size.innerHTML = SIZE_PRESETS.map(
      (preset, index) =>
        `<option value="${index}"${preset.width === width ? " selected" : ""}>${preset.label}</option>`,
    ).join("");
    els.size.addEventListener("change", () => {
      const preset = SIZE_PRESETS[Number(els.size!.value)];
      if (!preset) return;
      if (anyPaintSinceReset && !confirm("Changing the size clears the canvas. Continue?")) {
        // Restore the selection matching the current grid (or leave as-is for
        // imported non-preset sizes).
        const current = SIZE_PRESETS.findIndex((p) => p.width === width && p.height === height);
        if (current >= 0) els.size!.value = String(current);
        return;
      }
      resetGrid(preset.width, preset.height);
      setStatus("");
    });
  }

  els.fillLand?.addEventListener("click", () => {
    cells.fill(5);
    anyPaintSinceReset = true;
    requestRender();
  });
  els.fillOcean?.addEventListener("click", () => {
    if (anyPaintSinceReset && !confirm("Clear the whole canvas to water?")) return;
    cells.fill(0);
    anyPaintSinceReset = false;
    requestRender();
  });

  // --- name / serialize ------------------------------------------------------
  const mapName = (): string => {
    const raw = (els.name?.value ?? "").trim().slice(0, CUSTOM_MAP_MAX_NAME);
    return raw.length > 0 ? raw : "My World";
  };

  const currentData = (): CustomMapData => ({ name: mapName(), width, height, cells });

  /**
   * Serialize and re-validate through the shared decoder, so Play and Export
   * enforce exactly the rules the server/worker will (e.g. the minimum-land
   * floor) and errors read the same everywhere.
   */
  const serializeValidated = (): string => {
    const file = encodeCustomMapFile(currentData());
    decodeCustomMapFile(file);
    return file;
  };

  // --- actions ---------------------------------------------------------------
  els.toggle?.addEventListener("click", () => {
    const hidden = els.panel!.classList.toggle("hidden");
    els.toggle!.textContent = hidden ? "Open map editor" : "Close map editor";
    if (!hidden) requestRender();
  });

  els.exportBtn?.addEventListener("click", () => {
    try {
      const file = serializeValidated();
      const blob = new Blob([file], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${mapName().replace(/[^\p{L}\p{N}_-]+/gu, "-").toLowerCase() || "custom-map"}.ccmap`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Downloaded "${mapName()}" — import the file later to edit or play it again.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed.");
    }
  });

  els.importBtn?.addEventListener("click", () => els.importFile?.click());
  els.importFile?.addEventListener("change", async () => {
    const file = els.importFile?.files?.[0];
    if (!file) return;
    try {
      const data = decodeCustomMapFile(await file.text());
      resetGrid(data.width, data.height, data.cells);
      anyPaintSinceReset = true; // imported work deserves the same overwrite guards
      if (els.name) els.name.value = data.name;
      if (els.size) {
        const preset = SIZE_PRESETS.findIndex((p) => p.width === data.width && p.height === data.height);
        if (preset >= 0) els.size.value = String(preset);
      }
      setStatus(`Imported "${data.name}" (${data.width}×${data.height}).`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      if (els.importFile) els.importFile.value = "";
    }
  });

  els.play?.addEventListener("click", () => {
    try {
      options.onPlay(serializeValidated());
    } catch (error) {
      const land = landCount();
      const message = error instanceof Error ? error.message : "This map can't be played yet.";
      setStatus(
        land < CUSTOM_MAP_MIN_LAND_TILES
          ? `${message} Paint more land first.`
          : message,
      );
    }
  });

  // First paint of the empty ocean grid.
  resetGrid(width, height);
};
