import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveCatalogSessionMap } from "./sessionMap.js";
import { MatchRegistry, DIFFICULTY_BOT_COUNT, MAX_FIELD } from "./MatchRegistry.js";
import { isRasterDifficulty } from "../Core/messages.js";
import { validateCommand } from "./validateCommand.js";
import { buildCustomGameMap, decodeCustomMapFile } from "../Core/customMap.js";
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
import { handleAiApiRequest } from "./aiApi.js";

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

// Heightmap maps must be downsampled from the source raster before a match can
// start; the finished `GameMap` is then cached per (map, size). Build it once
// up front instead of mid-handshake — otherwise the first player to pick a
// given size pays the whole (event-loop-blocking) build while they wait.
//
// The default is warmed synchronously at boot so a connection accepting it is
// instant. Every other catalogue size is warmed lazily in the background after
// the server is listening (see `warmRemainingMaps`), spread across timer ticks
// so the one-off builds never stall the simulation loop or a live match.
const buildChoice = (choice: MapChoice): boolean => {
  const def = choice.options.realMapId ? getHeightmapMap(choice.options.realMapId) : undefined;
  if (!def) return false;
  const built = buildHeightmapGameMap(def, choice.options.mapSize);
  console.log(
    `Pre-built map "${choice.id}" at ${built.width}x${built.height} (${built.size} tiles).`,
  );
  return true;
};

buildChoice(defaultMapChoice);

/**
 * Warm every remaining heightmap choice one per timer tick, yielding the event
 * loop between builds so a big map (the huge Earth) never blocks an in-progress
 * match. Builds are cached, so the default (already warmed) is skipped cheaply.
 */
const warmRemainingMaps = (): void => {
  const pending = MAP_CHOICES.filter((c) => c.id !== defaultMapChoice.id && c.options.realMapId);
  const warmNext = (): void => {
    const choice = pending.shift();
    if (!choice) return;
    buildChoice(choice);
    setTimeout(warmNext, 50);
  };
  setTimeout(warmNext, 250);
};
// Optional fixed override for the AI count (mainly for testing). When set it
// wins over the per-join difficulty; otherwise the chosen difficulty decides.
const botOverrideRaw = process.env.RASTER_BOTS;
const botOverride = botOverrideRaw !== undefined && Number.isFinite(Number(botOverrideRaw))
  ? Math.max(0, Math.min(Math.floor(Number(botOverrideRaw)), MAX_FIELD))
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
      response.end(JSON.stringify({ ok: true, activeSessions: registry.aiSessions.size }));
      return;
    }

    // AI REST API — headless HTTP interface for AI agents
    if (requestUrl.pathname.startsWith("/api/games")) {
      const handled = await handleAiApiRequest(request, response, registry.aiSessions);
      if (handled) return;
    }

    // Solo map asset: prebuilt terrain for a catalogue map, so a browser Web
    // Worker can host a solo match locally (OpenFront-style client-side sim)
    // without decoding the PNG itself. Body: [width u32 LE][height u32 LE][terrain
    // bytes], gzip-encoded (the fetch API transparently inflates it).
    if (requestUrl.pathname === "/api/solo/map") {
      const choice = resolveMapChoice(requestUrl.searchParams.get("id") ?? undefined);
      const { map, name } = resolveCatalogSessionMap(choice.options, choice.name);
      const header = Buffer.alloc(8);
      header.writeUInt32LE(map.width, 0);
      header.writeUInt32LE(map.height, 4);
      const body = gzipSync(Buffer.concat([header, Buffer.from(map.terrain)]));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "cache-control": "public, max-age=86400",
        "x-map-name": encodeURIComponent(name),
      });
      response.end(body);
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

// Compress messages on the wire. The opening snapshot ships the whole static
// terrain plane plus the full ownership raster — ~6 MB of base64 for the huge
// Earth, almost all of it long runs of identical bytes (ocean, neutral land),
// which deflate crushes ~20× (to a few hundred KB). Per-tick owner deltas
// compress well too. `threshold` skips the tiny control/handshake frames where
// compression would only add overhead; the modest memLevel keeps each client's
// deflate context cheap. Browsers negotiate permessage-deflate automatically.
const wss = new WebSocketServer({
  server,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 6, memLevel: 7 },
    // Drop the deflate sliding window between messages so a long-lived match
    // doesn't pin per-connection compression memory.
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});

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
        if (!unsubscribe && !registry.isClientBusy(clientId)) {
          const choice = resolveMapChoice(message.payload.mapId);
          const difficulty = isRasterDifficulty(message.payload.difficulty)
            ? message.payload.difficulty
            : "medium";
          // A RASTER_BOTS env override wins (testing); otherwise the client's
          // chosen field size (OpenFront's `bots` slider) flows through, and
          // when neither is set the server auto-scales to the map.
          const rawField = message.payload.fieldSize;
          const clientField = typeof rawField === "number" && Number.isFinite(rawField)
            ? Math.max(0, Math.min(Math.floor(rawField), MAX_FIELD))
            : undefined;
          // A player-made map rides in with the join and lives only for this
          // match — decode + build here (never persisted), and let a bad file
          // throw into the shared rejection path below with its reason.
          // (validateCommand already refused customMap+lockstep.)
          const custom = message.payload.customMap
            ? decodeCustomMapFile(message.payload.customMap)
            : undefined;
          unsubscribe = registry.joinRasterSolo(
            clientId,
            send,
            custom
              ? { prebuiltMap: buildCustomGameMap(custom), mapName: custom.name }
              : { ...choice.options },
            difficulty,
            botOverride ?? clientField,
            // Lockstep joins carry the resolved catalogue id so the client's
            // replica fetches the exact map this session was built from.
            message.payload.lockstep ? choice.id : undefined,
          );
        }
      } else if (message.type === "CLIENT_RASTER_SELECT_SPAWN") {
        registry.selectRasterSpawn(clientId, message.payload.x, message.payload.y);
      } else if (message.type === "CLIENT_RASTER_EXPAND") {
        registry.queueRasterExpand(clientId, message.payload);
      } else if (message.type === "CLIENT_RASTER_BUILD") {
        registry.queueRasterBuild(clientId, message.payload);
      } else if (message.type === "CLIENT_RASTER_NUKE") {
        registry.queueRasterNuke(clientId, message.payload);
      } else if (message.type === "CLIENT_RASTER_ALLY_PROPOSE") {
        registry.proposeRasterAlliance(clientId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_ALLY_RESPOND") {
        registry.respondRasterAlliance(clientId, message.payload.targetId, message.payload.accept);
      } else if (message.type === "CLIENT_RASTER_ALLY_BREAK") {
        registry.breakRasterAlliance(clientId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_ALLY_RENEW") {
        registry.renewRasterAlliance(clientId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_RETREAT") {
        registry.retreatRaster(clientId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_DONATE") {
        registry.donateRaster(clientId, message.payload.targetId, message.payload.resource, message.payload.percent);
      } else if (message.type === "CLIENT_RASTER_EMBARGO") {
        registry.setRasterEmbargo(clientId, message.payload.targetId, message.payload.on);
      } else if (message.type === "CLIENT_RASTER_TARGET_REQUEST") {
        registry.requestRasterTarget(clientId, message.payload.allyId, message.payload.targetId);
      } else if (message.type === "CLIENT_RASTER_EMOJI") {
        registry.sendRasterEmoji(clientId, message.payload.targetId, message.payload.emoji);
      } else if (message.type === "CLIENT_RASTER_LOBBY_CREATE") {
        const choice = resolveMapChoice(message.payload.mapId);
        const difficulty = isRasterDifficulty(message.payload.difficulty) ? message.payload.difficulty : "medium";
        const rawField = message.payload.fieldSize;
        const clientField = typeof rawField === "number" && Number.isFinite(rawField)
          ? Math.max(0, Math.min(Math.floor(rawField), MAX_FIELD))
          : undefined;
        registry.createLobby(
          clientId,
          send,
          choice.id,
          choice.name,
          { ...choice.options },
          difficulty,
          botOverride ?? clientField,
          message.payload.name,
        );
      } else if (message.type === "CLIENT_RASTER_LOBBY_JOIN") {
        registry.joinLobby(clientId, send, message.payload.code, message.payload.name);
      } else if (message.type === "CLIENT_RASTER_LOBBY_START") {
        registry.startLobby(clientId);
      } else if (message.type === "CLIENT_RASTER_LOBBY_LEAVE") {
        registry.leaveLobby(clientId);
      } else if (message.type === "CLIENT_RASTER_RESUME") {
        registry.resumeLockstep(clientId, send, message.payload.token);
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
    // The registry winds down every membership this connection held — lobby
    // seat, lockstep seat (kept muted for a resume), and the plain snapshot
    // match (via its registered cleanup).
    registry.handleSocketClose(clientId);
  });
});

server.listen(port, () => {
  console.log(`Control & Conquer listening on http://localhost:${port}`);
  console.log(`Default map: "${defaultMapChoice.id}". Selectable maps: ${MAP_CHOICES.map((m) => m.id).join(", ")}.`);
  console.log(
    botOverride !== undefined
      ? `Seating a fixed ${botOverride} AI opponent(s) per solo match (RASTER_BOTS override).`
      : `AI opponents scale with map size (min per difficulty — easy: ${DIFFICULTY_BOT_COUNT.easy}, medium: ${DIFFICULTY_BOT_COUNT.medium}, hard: ${DIFFICULTY_BOT_COUNT.hard}; up to ${MAX_FIELD} on the largest maps).`,
  );
  console.log(`Simulation loop running at ${SIMULATION_TICK_RATE} TPS.`);
  // Warm the rest of the catalogue in the background so switching maps is instant.
  warmRemainingMaps();
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
