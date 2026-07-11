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
  | { type: "SERVER"; message: RasterServerMessage }
  /** Unrecoverable replica failure (map fetch, setup mismatch, turn gap). */
  | { type: "FATAL"; message: string };

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
 * A lockstep transport can start from a socket that already lives — a lobby
 * flow keeps one WebSocket through create → wait → start, and hands it over
 * (plus the already-received setup) when the match begins.
 */
export interface LockstepAttachOptions {
  socket: WebSocket;
  setup: import("../Core/lockstep.js").RasterLockstepStartPayload;
}

/**
 * Transport for a server-refereed lockstep match: intents go up the WebSocket
 * (the JOIN is stamped `lockstep: true` so the server relays turns instead of
 * streaming snapshots), and the down-stream is routed by kind —
 * `SERVER_RASTER_LOCKSTEP_START` boots a replica Web Worker,
 * `SERVER_RASTER_TURN`s feed it, and the worker's locally simulated
 * `RasterServerMessage` stream (snapshots, rejections, match end, desync
 * warnings) is what the client actually renders. Everything else the server
 * sends (e.g. a parse-error rejection) passes straight through.
 *
 * Reconnect: `SERVER_RASTER_LOCKSTEP_START` carries a private resume token.
 * When the socket drops mid-match, the transport dials back (with backoff),
 * presents the token, and rebuilds the replica from the server's turn
 * backlog — the fast-forward is deterministic, so play resumes seamlessly.
 * Only after the retries are exhausted does `onClose` fire.
 */
export const createLockstepTransport = (attach?: LockstepAttachOptions): RasterTransport => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let worker: Worker | null = null;
  let onOpenCb: () => void = () => {};
  let onMessageCb: (m: RasterServerMessage) => void = () => {};
  let onCloseCb: () => void = () => {};
  let resumeToken: string | null = null;
  let matchOver = false;
  let reconnectAttempt = 0;
  /**
   * Intents that arrived while no socket was OPEN (reconnect backoff, or the
   * brief CONNECTING window after a redial). Sending on a CONNECTING socket
   * throws per spec and on a CLOSED one is silently discarded — both wrong
   * for a player's click — so they queue here and flush on the next open.
   * Bounded: stale intents past a reconnect are mostly harmless (the server
   * re-validates), but an unbounded queue would replay minutes of clicks.
   */
  const outbox: string[] = [];
  const OUTBOX_LIMIT = 32;
  /** Pending reconnect timer, so a shutdown can cancel a scheduled redial. */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shutdownDone = false;

  /**
   * Give up for good: stop reconnecting, drop the replica, close the socket,
   * tell the client. Idempotent — the socket close this triggers re-enters
   * here via the close listener, and a second `onCloseCb` would overwrite
   * whatever fatal error the first pass surfaced. Closing the socket matters
   * server-side too: a deaf-but-open connection keeps its seat in
   * `match.connected`, so the referee streams turns to it forever and the
   * abandoned-match reaper never fires.
   */
  const shutdown = (): void => {
    if (shutdownDone) return;
    shutdownDone = true;
    matchOver = true;
    resumeToken = null;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    worker?.terminate();
    worker = null;
    socket?.close();
    socket = null;
    onCloseCb();
  };

  const bootWorker = (): Worker => {
    const w = new Worker(new URL("./lockstep/lockstepWorker.js", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;
      if (data.type === "FATAL") {
        // The replica cannot continue (map fetch failed, setup mismatch, turn
        // gap). Surface the reason, then wind down — never a silent freeze.
        onMessageCb({ type: "SERVER_RASTER_LOBBY_ERROR", payload: { message: data.message, fatal: true } });
        shutdown();
        return;
      }
      if (data.type !== "SERVER") return;
      // A decided match must not trigger reconnects after the socket winds down.
      if (data.message.type === "SERVER_RASTER_MATCH_ENDED" && data.message.payload.winnerPlayerId !== null) {
        matchOver = true;
      }
      onMessageCb(data.message);
    };
    w.onerror = () => shutdown();
    return w;
  };

  const handleServerMessage = (message: RasterServerMessage): void => {
    if (message.type === "SERVER_RASTER_LOCKSTEP_START") {
      resumeToken = message.payload.resumeToken;
      // A resume always starts a fresh replica — the old one is stale history.
      if (worker) worker.terminate();
      worker = bootWorker();
      worker.postMessage({ type: "SETUP", payload: message.payload });
    } else if (message.type === "SERVER_RASTER_TURN") {
      reconnectAttempt = 0; // live turns flowing — the link is healthy
      worker?.postMessage({ type: "TURN", payload: message.payload });
    } else if (message.type === "SERVER_RASTER_TURN_BACKLOG") {
      worker?.postMessage({ type: "BACKLOG", payload: message.payload });
    } else if (message.type === "SERVER_RASTER_LOBBY_ERROR") {
      // In a lockstep transport this only means a refused resume (match
      // reaped, seat taken). The socket stays open server-side, so without
      // an explicit shutdown the client would sit frozen forever.
      onMessageCb(message);
      shutdown();
    } else {
      onMessageCb(message);
    }
  };

  const flushOutbox = (ws: WebSocket): void => {
    for (const wire of outbox.splice(0)) ws.send(wire);
  };

  const wireSocket = (ws: WebSocket): void => {
    ws.addEventListener("message", (event) => {
      handleServerMessage(JSON.parse(String(event.data)) as RasterServerMessage);
    });
    ws.addEventListener("close", () => {
      if (matchOver || resumeToken === null || reconnectAttempt >= 3) {
        shutdown();
        return;
      }
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(dialResume, 1000 * 2 ** (reconnectAttempt - 1));
    });
  };

  const dialResume = (): void => {
    reconnectTimer = null;
    // A fatal shutdown may have landed while this redial was waiting (e.g.
    // the replica died during the backoff). Dialing anyway would present a
    // null token the server rejects and leave a zombie connection behind.
    if (matchOver || resumeToken === null) return;
    const ws = new WebSocket(`${protocol}://${window.location.host}/`);
    socket = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "CLIENT_RASTER_RESUME", payload: { token: resumeToken } }));
      flushOutbox(ws);
    });
    wireSocket(ws);
  };

  return {
    start() {
      if (attach) {
        // Lobby handover: socket already open, setup already received.
        socket = attach.socket;
        wireSocket(socket);
        handleServerMessage({ type: "SERVER_RASTER_LOCKSTEP_START", payload: attach.setup });
        onOpenCb();
        return;
      }
      socket = new WebSocket(`${protocol}://${window.location.host}/`);
      socket.addEventListener("open", () => {
        flushOutbox(socket as WebSocket);
        onOpenCb();
      });
      wireSocket(socket);
    },
    send(message) {
      // A lobby handover already seated us — swallow the client's routine JOIN.
      if (attach && message.type === "CLIENT_RASTER_JOIN") return;
      // Stamp the JOIN so the server seats us as a lockstep subscriber; every
      // other intent goes up verbatim — the server records it and it comes
      // back to our replica inside a relay turn (input latency = RTT + ≤1 tick).
      const wire = JSON.stringify(
        message.type === "CLIENT_RASTER_JOIN"
          ? { ...message, payload: { ...message.payload, lockstep: true } }
          : message,
      );
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(wire);
      } else if (!matchOver) {
        if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
        outbox.push(wire);
      }
    },
    onOpen(cb) { onOpenCb = cb; },
    onMessage(cb) { onMessageCb = cb; },
    onClose(cb) { onCloseCb = cb; },
  };
};
