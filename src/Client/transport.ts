import type { RasterClientMessage, RasterServerMessage } from "../Core/types.js";

/**
 * The client talks to its match through a transport, not a raw socket, so the
 * exact same render/UI code drives any of:
 *  - a real WebSocket to the authoritative server, streamed snapshots/deltas
 *    ({@link createWebSocketTransport} — the thin-client mode),
 *  - a {@link createWorkerTransport} that hosts the whole solo match in a browser
 *    Web Worker — the OpenFront-style client-side simulation, with no per-tick
 *    network round-trip and the sim+serialization off the render thread, or
 *  - a {@link createLockstepTransport}: a WebSocket that carries only intents
 *    up and relay turns down, driving a local replica sim in a Web Worker —
 *    the scalable multiplayer path (see `Core/lockstep.ts`).
 *
 * All speak the same typed message union, so swapping them changes nothing
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

/**
 * Transport for a server-refereed lockstep match: intents go up the WebSocket
 * (the JOIN is stamped `lockstep: true` so the server relays turns instead of
 * streaming snapshots), and the down-stream is routed by kind —
 * `SERVER_RASTER_LOCKSTEP_START` boots a replica Web Worker,
 * `SERVER_RASTER_TURN`s feed it, and the worker's locally simulated
 * `RasterServerMessage` stream (snapshots, rejections, match end, desync
 * warnings) is what the client actually renders. Everything else the server
 * sends (e.g. a parse-error rejection) passes straight through.
 */
export const createLockstepTransport = (): RasterTransport => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let worker: Worker | null = null;
  let onOpenCb: () => void = () => {};
  let onMessageCb: (m: RasterServerMessage) => void = () => {};
  let onCloseCb: () => void = () => {};

  const bootWorker = (): Worker => {
    const w = new Worker(new URL("./lockstep/lockstepWorker.js", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;
      if (data.type === "SERVER") onMessageCb(data.message);
    };
    w.onerror = () => onCloseCb();
    return w;
  };

  return {
    start() {
      socket = new WebSocket(`${protocol}://${window.location.host}/`);
      socket.addEventListener("open", () => onOpenCb());
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as RasterServerMessage;
        if (message.type === "SERVER_RASTER_LOCKSTEP_START") {
          worker ??= bootWorker();
          worker.postMessage({ type: "SETUP", payload: message.payload });
        } else if (message.type === "SERVER_RASTER_TURN") {
          worker?.postMessage({ type: "TURN", payload: message.payload });
        } else {
          onMessageCb(message);
        }
      });
      socket.addEventListener("close", () => {
        worker?.terminate();
        worker = null;
        onCloseCb();
      });
    },
    send(message) {
      // Stamp the JOIN so the server seats us as a lockstep subscriber; every
      // other intent goes up verbatim — the server records it and it comes
      // back to our replica inside a relay turn (input latency = RTT + ≤1 tick).
      const wire = message.type === "CLIENT_RASTER_JOIN"
        ? { ...message, payload: { ...message.payload, lockstep: true } }
        : message;
      socket?.send(JSON.stringify(wire));
    },
    onOpen(cb) { onOpenCb = cb; },
    onMessage(cb) { onMessageCb = cb; },
    onClose(cb) { onCloseCb = cb; },
  };
};
