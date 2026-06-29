import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MatchRegistry, DIFFICULTY_BOT_COUNT, MAX_RASTER_BOTS } from "./MatchRegistry.js";
import { isRasterDifficulty } from "../Core/messages.js";
import { validateCommand } from "./validateCommand.js";
import { buildHeightmapGameMap, getHeightmapMap } from "./heightmapMaps.js";
import {
  DEFAULT_MAP_CHOICE_ID,
  getMapChoice,
  MAP_CHOICES,
  type MapChoice,
} from "../Core/mapCatalog.js";
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

// Players pick their map per-run from the shared catalogue (see `mapCatalog`),
// sent in the join payload. RASTER_MAP optionally overrides the *default* choice
// used when a client sends none — it must name a catalogue id (e.g. "earth-huge").
const requestedDefaultMap = process.env.RASTER_MAP ?? DEFAULT_MAP_CHOICE_ID;
const defaultMapChoice: MapChoice =
  getMapChoice(requestedDefaultMap) ?? getMapChoice(DEFAULT_MAP_CHOICE_ID)!;
if (defaultMapChoice.id !== requestedDefaultMap) {
  console.warn(`Unknown map "${requestedDefaultMap}". Falling back to "${DEFAULT_MAP_CHOICE_ID}".`);
}

/** Resolve a (possibly absent/unknown) client map id to a catalogue choice. */
const resolveMapChoice = (mapId: string | undefined): MapChoice =>
  (mapId ? getMapChoice(mapId) : undefined) ?? defaultMapChoice;

// Heightmap maps take a few hundred ms to downsample from the source raster.
// Pre-warm the default one (cached by size) at boot so a first connection that
// accepts the default doesn't pay that cost mid-handshake.
const defaultHeightmap = defaultMapChoice.options.realMapId
  ? getHeightmapMap(defaultMapChoice.options.realMapId)
  : undefined;
if (defaultHeightmap) {
  const built = buildHeightmapGameMap(defaultHeightmap, defaultMapChoice.options.mapSize);
  console.log(
    `Pre-built default map "${defaultMapChoice.id}" at ${built.width}x${built.height} (${built.size} tiles).`,
  );
}
// Optional fixed override for the AI count (mainly for testing). When set it
// wins over the per-join difficulty; otherwise the chosen difficulty decides.
const botOverrideRaw = process.env.RASTER_BOTS;
const botOverride = botOverrideRaw !== undefined && Number.isFinite(Number(botOverrideRaw))
  ? Math.max(0, Math.min(Math.floor(Number(botOverrideRaw)), MAX_RASTER_BOTS))
  : undefined;

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

  // The player is seated only once they send CLIENT_RASTER_JOIN.
  let unsubscribe: (() => void) | null = null;

  socket.on("message", (data) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(String(data));
      const message = validateCommand(parsed);
      if (message.type === "CLIENT_RASTER_JOIN") {
        if (!unsubscribe) {
          const choice = resolveMapChoice(message.payload.mapId);
          const difficulty = isRasterDifficulty(message.payload.difficulty)
            ? message.payload.difficulty
            : "medium";
          unsubscribe = registry.joinRasterSolo(
            clientId,
            send,
            { ...choice.options },
            difficulty,
            botOverride,
          );
        }
      } else if (message.type === "CLIENT_RASTER_SELECT_SPAWN") {
        registry.selectRasterSpawn(clientId, message.payload.x, message.payload.y);
      } else if (message.type === "CLIENT_RASTER_EXPAND") {
        registry.queueRasterExpand(clientId, message.payload);
      } else if (message.type === "CLIENT_RASTER_BUILD") {
        registry.queueRasterBuild(clientId, message.payload);
      } else if (message.type === "CLIENT_RASTER_ALLY_PROPOSE") {
        registry.proposeRasterAlliance(clientId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_ALLY_RESPOND") {
        registry.respondRasterAlliance(clientId, message.payload.targetId, message.payload.accept);
      } else if (message.type === "CLIENT_RASTER_ALLY_BREAK") {
        registry.breakRasterAlliance(clientId, message.payload.targetId);
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

  socket.on("close", () => {
    unsubscribe?.();
  });
});

server.listen(port, () => {
  console.log(`Control & Conquer listening on http://localhost:${port}`);
  console.log(`Default map: "${defaultMapChoice.id}". Selectable maps: ${MAP_CHOICES.map((m) => m.id).join(", ")}.`);
  console.log(
    botOverride !== undefined
      ? `Seating a fixed ${botOverride} AI opponent(s) per solo match (RASTER_BOTS override).`
      : `AI opponents scale with map size (min per difficulty — easy: ${DIFFICULTY_BOT_COUNT.easy}, medium: ${DIFFICULTY_BOT_COUNT.medium}, hard: ${DIFFICULTY_BOT_COUNT.hard}; up to ${MAX_RASTER_BOTS} on the largest maps).`,
  );
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
