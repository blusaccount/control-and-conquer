import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MatchRegistry, DEFAULT_RASTER_BOT_COUNT, MAX_RASTER_BOTS } from "./MatchRegistry.js";
import { validateCommand } from "./validateCommand.js";
import { DEFAULT_REAL_MAP_ID, getRealMap } from "../Core/realMaps.js";
import { buildHeightmapGameMap, getHeightmapMap, HEIGHTMAP_MAP_IDS } from "./heightmapMaps.js";
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

// The active map is selected via RASTER_MAP, defaulting to the Mediterranean.
// Ids resolve as heightmap maps (e.g. "earth") or hand-authored ASCII maps
// (e.g. "mediterranean"); unknown ids fall back to the default. Heightmap maps
// honour RASTER_MAP_SIZE (target width in tiles).
const requestedMapId = process.env.RASTER_MAP ?? DEFAULT_REAL_MAP_ID;
const isKnownMap = (id: string): boolean => Boolean(getHeightmapMap(id) ?? getRealMap(id));
const activeMapId = isKnownMap(requestedMapId) ? requestedMapId : DEFAULT_REAL_MAP_ID;
const rasterMapSize = Number(process.env.RASTER_MAP_SIZE ?? 0) || 0;
if (activeMapId !== requestedMapId) {
  console.warn(`Unknown map "${requestedMapId}". Falling back to "${DEFAULT_REAL_MAP_ID}".`);
}

// Heightmap maps take a few hundred ms to downsample from the source raster.
// Pre-warm the active one (cached by size) at boot so the first connection
// doesn't pay that cost mid-handshake.
const activeHeightmap = getHeightmapMap(activeMapId);
if (activeHeightmap) {
  const built = buildHeightmapGameMap(activeHeightmap, rasterMapSize || undefined);
  console.log(`Pre-built heightmap map "${activeMapId}" at ${built.width}x${built.height} (${built.size} tiles).`);
}
// Number of AI opponents seated in each solo match. Defaults to a small FFA;
// clamp to the seats a session can fill and fall back on a bad value.
const requestedBots = Number(process.env.RASTER_BOTS ?? DEFAULT_RASTER_BOT_COUNT);
const botCount = Number.isFinite(requestedBots)
  ? Math.max(0, Math.min(Math.floor(requestedBots), MAX_RASTER_BOTS))
  : DEFAULT_RASTER_BOT_COUNT;

const registry = new MatchRegistry();
let clientSequence = 0;

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

wss.on("connection", (socket) => {
  clientSequence += 1;
  const clientId = `client-${clientSequence}`;

  const send = (message: unknown): void => {
    socket.send(JSON.stringify(message));
  };

  const unsubscribe = registry.joinRasterSolo(clientId, send, {
    realMapId: activeMapId,
    mapSize: rasterMapSize,
  }, botCount);

  socket.on("message", (data) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(String(data));
      const message = validateCommand(parsed);
      if (message.type === "CLIENT_RASTER_EXPAND") {
        registry.queueRasterExpand(clientId, message.payload);
      } else if (message.type === "CLIENT_PERK_CHOSEN") {
        registry.choosePerk(clientId, message.payload.perkId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown command error.";
      socket.send(JSON.stringify({
        type: "SERVER_RASTER_ACTION_REJECTED",
        payload: {
          reason: "INVALID_MESSAGE_FORMAT",
          message,
          intent: { targetX: 0, targetY: 0, percent: 50 },
        },
      }));
    }
  });

  socket.on("close", unsubscribe);
});

server.listen(port, () => {
  console.log(`Control & Conquer listening on http://localhost:${port}`);
  const sizeNote = getHeightmapMap(activeMapId) && rasterMapSize ? ` (size ${rasterMapSize})` : "";
  console.log(`Active map: "${activeMapId}"${sizeNote}. Heightmap maps: ${HEIGHTMAP_MAP_IDS.join(", ")}.`);
  console.log(`Seating ${botCount} AI opponent(s) per solo match.`);
  console.log(`Simulation loop running at ${SIMULATION_TICK_RATE} TPS.`);
});

let nextTickAt = performance.now() + TICK_INTERVAL_MS;

const runSimulationLoop = (): void => {
  const loopStart = performance.now();
  const driftMs = loopStart - nextTickAt;

  if (driftMs > DRIFT_WARN_MS) {
    console.warn(
      `Simulation drift detected (${driftMs.toFixed(2)}ms behind schedule). Pending inputs: ${registry.getPendingRasterExpandCount()}.`,
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
