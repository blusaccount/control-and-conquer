import type { RasterClientMessage, RasterServerMessage } from "../Core/types.js";

/**
 * The client talks to its match through a transport, not a raw socket, so the
 * exact same render/UI code drives either:
 *  - a real WebSocket to the authoritative server (multiplayer / future PvP), or
 *  - a {@link createWorkerTransport} that hosts the whole solo match in a browser
 *    Web Worker — the OpenFront-style client-side simulation, with no per-tick
 *    network round-trip and the sim+serialization off the render thread.
 *
 * Both speak the same typed message union, so swapping them changes nothing
 * upstream.
 */
export interface RasterTransport {
  /** Begin connecting/booting. `onOpen` fires once it is ready to accept sends. */
  start(): void;
  /** Send a client command (join, spawn pick, expand, build, diplomacy). */
  send(message: RasterClientMessage): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (message: RasterServerMessage) => void): void;
  onClose(cb: () => void): void;
}

/** Transport backed by a WebSocket to the authoritative server. */
export const createWebSocketTransport = (): RasterTransport => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let onOpenCb: () => void = () => {};
  let onMessageCb: (m: RasterServerMessage) => void = () => {};
  let onCloseCb: () => void = () => {};
  return {
    start() {
      socket = new WebSocket(`${protocol}://${window.location.host}/`);
      socket.addEventListener("open", () => onOpenCb());
      socket.addEventListener("message", (event) =>
        onMessageCb(JSON.parse(String(event.data)) as RasterServerMessage),
      );
      socket.addEventListener("close", () => onCloseCb());
    },
    send(message) {
      socket?.send(JSON.stringify(message));
    },
    onOpen(cb) { onOpenCb = cb; },
    onMessage(cb) { onMessageCb = cb; },
    onClose(cb) { onCloseCb = cb; },
  };
};

/** Worker → main message envelope. */
type WorkerOutbound =
  | { type: "OPEN" }
  | { type: "SERVER"; message: RasterServerMessage };

/**
 * Transport backed by a dedicated Web Worker that runs the solo match locally
 * (see `solo/soloWorker.ts`). The worker emits the identical
 * {@link RasterServerMessage} stream the server would, so the client decodes it
 * through the same path — only there is no socket and no network.
 */
export const createWorkerTransport = (): RasterTransport => {
  let worker: Worker | null = null;
  let onOpenCb: () => void = () => {};
  let onMessageCb: (m: RasterServerMessage) => void = () => {};
  let onCloseCb: () => void = () => {};
  return {
    start() {
      worker = new Worker(new URL("./solo/soloWorker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
        const data = event.data;
        if (data.type === "OPEN") onOpenCb();
        else if (data.type === "SERVER") onMessageCb(data.message);
      };
      worker.onerror = () => onCloseCb();
    },
    send(message) {
      worker?.postMessage({ type: "CLIENT", message });
    },
    onOpen(cb) { onOpenCb = cb; },
    onMessage(cb) { onMessageCb = cb; },
    onClose(cb) { onCloseCb = cb; },
  };
};
