import type { GameMap } from "../Core/GameMap.js";
import type { PlayerId } from "../Core/TerritoryGrid.js";
import { paintRaster } from "./rasterPaint.js";
import type { Rgba } from "./rasterPalette.js";

/**
 * Canvas-backed raster map renderer: the Phase 3 replacement for polygon fills.
 *
 * Terrain + ownership are painted into an `ImageData` at one pixel per tile on
 * a small offscreen canvas, then blitted scaled (with smoothing disabled, so
 * tiles stay crisp) onto the visible canvas. Drawing the map as a bitmap keeps
 * a redraw O(tiles) regardless of how organic the borders get — polygon
 * tessellation could never keep up with pixel-level fronts.
 *
 * This is the only DOM-touching piece; the colour and buffer logic it relies on
 * (`rasterPalette` / `rasterPaint`) is pure and unit-tested.
 */
export class RasterRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offscreenContext: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("RasterRenderer requires a 2D canvas context.");
    }
    this.canvas = canvas;
    this.context = context;
    this.offscreen = document.createElement("canvas");
    const offscreenContext = this.offscreen.getContext("2d");
    if (!offscreenContext) {
      throw new Error("RasterRenderer could not create an offscreen 2D context.");
    }
    this.offscreenContext = offscreenContext;
  }

  /** Ensure the offscreen buffer matches the current map dimensions. */
  private ensureBuffer(map: GameMap): ImageData {
    if (
      !this.imageData ||
      this.offscreen.width !== map.width ||
      this.offscreen.height !== map.height
    ) {
      this.offscreen.width = map.width;
      this.offscreen.height = map.height;
      this.imageData = this.offscreenContext.createImageData(map.width, map.height);
    }
    return this.imageData;
  }

  /** Paint terrain + ownership and scale it onto the visible canvas. */
  render(map: GameMap, owner: ArrayLike<PlayerId>, palette?: readonly Rgba[]): void {
    const imageData = this.ensureBuffer(map);
    paintRaster(map, owner, imageData.data, palette);
    this.offscreenContext.putImageData(imageData, 0, 0);

    this.context.imageSmoothingEnabled = false;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(
      this.offscreen,
      0,
      0,
      map.width,
      map.height,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
  }
}
