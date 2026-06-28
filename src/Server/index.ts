import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MatchRegistry } from "./MatchRegistry.js";
import { loadMapById } from "./mapRepository.js";
import { createInitialState } from "../Core/MapState.js";
import { DEFAULT_MAP_ID } from "../Core/maps/index.js";
import { validateCommand } from "./validateCommand.js";
import {
  DRIFT_WARN_MS,
  MAX_CATCH_UP_TICKS,
  SIMULATION_TICK_RATE,
  TICK_DURATION_WARN_MS,
  TICK_INTERVAL_MS,
} from "./simulationConfig.js";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const publicDir = join(rootDir, "public");
const assetDir = join(rootDir, "dist");
const port = Number(process.env.PORT ?? 3000);

// The larger grid map ships as data in maps/; the built-in basin is the
// guaranteed fallback if the file is missing or fails validation.
const requestedMapId = process.env.MAP_ID ?? "frontline-grid";
let activeMapId = requestedMapId;
let initialState;
try {
  initialState = createInitialState(loadMapById(requestedMapId));
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  console.warn(`Could not load map "${requestedMapId}" (${reason}). Falling back to "${DEFAULT_MAP_ID}".`);
  activeMapId = DEFAULT_MAP_ID;
  initialState = createInitialState(loadMapById(DEFAULT_MAP_ID));
}

const registry = new MatchRegistry(initialState);
let clientSequence = 0;
const fallbackOrder = (raw: unknown) => {
  const message = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const payload = typeof message.payload === "object" && message.payload !== null
    ? (message.payload as Record<string, unknown>)
    : {};

  return {
    sourceTerritoryId: typeof payload.sourceTerritoryId === "string" ? payload.sourceTerritoryId : "",
    targetTerritoryId: typeof payload.targetTerritoryId === "string" ? payload.targetTerritoryId : "",
    troops: typeof payload.troops === "number" && Number.isInteger(payload.troops) ? payload.troops : 1,
  };
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const safeJoin = (baseDir: string, requestPath: string): string => {
  const sanitized = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(baseDir, sanitized);
};

const serveFile = async (filePath: string): Promise<{ body: Buffer; contentType: string }> => {
  const body = await readFile(filePath);
  return {
    body,
    contentType: mimeTypes[extname(filePath)] ?? "application/octet-stream",
  };
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (requestUrl.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (requestUrl.pathname.startsWith("/assets/")) {
      const filePath = safeJoin(assetDir, requestUrl.pathname.replace("/assets/", ""));
      await stat(filePath);
      const file = await serveFile(filePath);
      response.writeHead(200, { "content-type": file.contentType });
      response.end(file.body);
      return;
    }

    const filePath = requestUrl.pathname === "/" ? join(publicDir, "index.html") : safeJoin(publicDir, requestUrl.pathname);
    await stat(filePath);
    const file = await serveFile(filePath);
    response.writeHead(200, { "content-type": file.contentType });
    response.end(file.body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, request) => {
  clientSequence += 1;
  const clientId = `client-${clientSequence}`;

  // Mode is selected by the client via the WebSocket URL query string:
  //   ws://host/?mode=solo  -> immediate match vs server-side bot
  //   ws://host/?mode=multi -> 1v1 lobby pairing (default)
  const requestUrl = new URL(request.url ?? "/", `ws://${request.headers.host ?? "localhost"}`);
  const requestedMode = requestUrl.searchParams.get("mode");
  const mode: "solo" | "multi" = requestedMode === "solo" ? "solo" : "multi";

  const send = (message: unknown): void => {
    socket.send(JSON.stringify(message));
  };

  const unsubscribe = mode === "solo"
    ? registry.joinSolo(clientId, (m) => send(m))
    : registry.join(clientId, (m) => send(m));

  socket.on("message", (data) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(String(data));
      const message = validateCommand(parsed);

      if (message.type === "CLIENT_ATTACK_REQUEST") {
        registry.queueAttack(clientId, message.payload);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown command error.";
      socket.send(
        JSON.stringify({
          type: "SERVER_ACTION_REJECTED",
          payload: {
            reason: "INVALID_MESSAGE_FORMAT",
            message,
            order: fallbackOrder(parsed),
          },
        }),
      );
    }
  });

  socket.on("close", unsubscribe);
});

server.listen(port, () => {
  console.log(`Control & Conquer listening on http://localhost:${port}`);
  console.log(`Active map: "${initialState.mapName}" (${activeMapId}).`);
  console.log(`Simulation loop running at ${SIMULATION_TICK_RATE} TPS.`);
});

let nextTickAt = performance.now() + TICK_INTERVAL_MS;

const runSimulationLoop = (): void => {
  const loopStart = performance.now();
  const driftMs = loopStart - nextTickAt;

  if (driftMs > DRIFT_WARN_MS) {
    console.warn(
      `Simulation drift detected (${driftMs.toFixed(2)}ms behind schedule). Pending inputs: ${registry.getPendingAttackCount()}.`,
    );
  }

  let processedTicks = 0;
  let now = loopStart;

  while (now >= nextTickAt && processedTicks < MAX_CATCH_UP_TICKS) {
    const tickStart = performance.now();
    registry.tickAll();
    const tickDuration = performance.now() - tickStart;

    if (tickDuration > TICK_DURATION_WARN_MS) {
      console.warn(`Slow simulation tick (${tickDuration.toFixed(2)}ms) over budget ${TICK_INTERVAL_MS.toFixed(2)}ms.`);
    }

    processedTicks += 1;
    nextTickAt += TICK_INTERVAL_MS;
    now = performance.now();
  }

  if (processedTicks === MAX_CATCH_UP_TICKS && now >= nextTickAt) {
    const remainingDrift = now - nextTickAt;
    console.warn(
      `Simulation overloaded after ${processedTicks} catch-up ticks (${remainingDrift.toFixed(2)}ms remaining drift). Resyncing schedule.`,
    );
    nextTickAt = now + TICK_INTERVAL_MS;
  }

  const delay = Math.max(0, nextTickAt - performance.now());
  setTimeout(runSimulationLoop, delay);
};

setTimeout(runSimulationLoop, TICK_INTERVAL_MS);
