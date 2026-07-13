import type { RasterServerMessage, RasterSnapshot } from "../Core/types.js";

/**
 * Worker→main snapshot rewriting: swap the base64 raster payloads for raw
 * bytes moved with a `postMessage` transfer list.
 *
 * The in-browser sim hosts (the solo worker and the lockstep replica) reuse
 * the server's serialization verbatim, which base64-encodes the terrain and
 * ownership rasters for the JSON WebSocket wire. Inside one browser that
 * round-trip is pure overhead — worse, the *decode* half of it used to run on
 * the render thread (a ~6.6 MB base64 string per full snapshot of the huge
 * Earth). Decoding here and transferring the buffers keeps every byte of
 * raster work off the main thread; the client prefers the binary fields when
 * present (see `RasterSnapshot.terrainBytes` and friends).
 */

/** Native base64 decoder where available (Firefox/Safari, recent Chrome). */
const nativeFromBase64: ((b64: string) => Uint8Array) | undefined =
  typeof (Uint8Array as unknown as { fromBase64?: (b64: string) => Uint8Array }).fromBase64 === "function"
    ? (b64) => (Uint8Array as unknown as { fromBase64: (b64: string) => Uint8Array }).fromBase64(b64)
    : undefined;

const decodeBase64 = (b64: string): Uint8Array => {
  if (nativeFromBase64) return nativeFromBase64(b64);
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * Rewrite a snapshot message for worker→main delivery: every non-empty base64
 * raster field becomes its binary twin, and the backing buffers are collected
 * into a transfer list (zero-copy hand-off). Non-snapshot messages pass
 * through untouched. The empty-string `falloutBase64` sentinel ("clear the
 * set") is left as-is — only real payloads are converted.
 */
export const binarySnapshotTransfer = (
  message: RasterServerMessage,
): { message: RasterServerMessage; transfer: ArrayBuffer[] } => {
  if (message.type !== "SERVER_RASTER_SNAPSHOT") return { message, transfer: [] };
  const src = message.payload;
  if (
    src.terrainBase64 === undefined &&
    src.ownerBase64 === undefined &&
    src.ownerDeltaBase64 === undefined &&
    !src.falloutBase64
  ) {
    return { message, transfer: [] };
  }
  const payload: RasterSnapshot = { ...src };
  const transfer: ArrayBuffer[] = [];
  const swap = (b64: string | undefined): Uint8Array | undefined => {
    if (b64 === undefined) return undefined;
    const bytes = decodeBase64(b64);
    transfer.push(bytes.buffer as ArrayBuffer);
    return bytes;
  };
  const terrain = swap(payload.terrainBase64);
  if (terrain) {
    payload.terrainBytes = terrain;
    delete payload.terrainBase64;
  }
  const owner = swap(payload.ownerBase64);
  if (owner) {
    payload.ownerBytes = owner;
    delete payload.ownerBase64;
  }
  const delta = swap(payload.ownerDeltaBase64);
  if (delta) {
    payload.ownerDeltaBytes = delta;
    delete payload.ownerDeltaBase64;
  }
  if (payload.falloutBase64) {
    payload.falloutBytes = swap(payload.falloutBase64);
    delete payload.falloutBase64;
  }
  return { message: { ...message, payload }, transfer };
};
