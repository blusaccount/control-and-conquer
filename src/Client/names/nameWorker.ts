import { computeNameAnchors, type NameLayoutPlayer } from "../nameLayout.js";

/**
 * Nation-name anchor host, running in a dedicated Web Worker.
 *
 * `computeNameAnchors` is a full O(map) scan of the ownership raster (plus
 * per-player grids) — ~10ms on the large Earth. Run on the render thread
 * twice a second it was a guaranteed dropped frame; here the main thread
 * ships a transferred copy of the owner raster and keeps drawing its previous
 * anchors until the fresh ones arrive. Requests carry an `id` the reply
 * echoes, so the client can keep exactly one computation in flight.
 */

interface Inbound {
  id: number;
  width: number;
  height: number;
  owner: Uint16Array;
  players: NameLayoutPlayer[];
}

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: Inbound }) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event): void => {
  const { id, width, height, owner, players } = event.data;
  ctx.postMessage({ id, anchors: computeNameAnchors(width, height, owner, players) });
};
