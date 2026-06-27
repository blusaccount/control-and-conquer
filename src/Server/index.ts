import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ClientCommand } from "../Core/types.js";
import { GameSession } from "./GameSession.js";
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
const game = new GameSession();

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
  const unsubscribe = game.subscribe((snapshot) => {
    socket.send(JSON.stringify({ type: "snapshot", payload: snapshot }));
  });

  socket.on("message", (data) => {
    try {
      const command = JSON.parse(String(data)) as ClientCommand;
      game.queueCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown command error.";
      socket.send(JSON.stringify({ type: "error", payload: { message } }));
    }
  });

  socket.on("close", unsubscribe);
});

server.listen(port, () => {
  console.log(`Control & Conquer listening on http://localhost:${port}`);
  console.log(`Simulation loop running at ${SIMULATION_TICK_RATE} TPS.`);
});

let nextTickAt = performance.now() + TICK_INTERVAL_MS;

const runSimulationLoop = (): void => {
  const loopStart = performance.now();

  if (loopStart - nextTickAt > DRIFT_WARN_MS) {
    console.warn(
      `Simulation drift detected (${(loopStart - nextTickAt).toFixed(2)}ms behind schedule). Pending inputs: ${game.getPendingCommandCount()}.`,
    );
  }

  let processedTicks = 0;
  let now = loopStart;

  while (now >= nextTickAt && processedTicks < MAX_CATCH_UP_TICKS) {
    const tickStart = performance.now();
    game.tick();
    const tickDuration = performance.now() - tickStart;

    if (tickDuration > TICK_DURATION_WARN_MS) {
      console.warn(
        `Slow simulation tick (${tickDuration.toFixed(2)}ms) over budget ${TICK_INTERVAL_MS.toFixed(2)}ms.`,
      );
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
