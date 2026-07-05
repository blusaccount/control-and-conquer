import { RasterGameSession } from "../../Server/RasterGameSession.js";
import { RasterBotController } from "../../Server/RasterBotController.js";
import { buildFieldConfigs, resolveFieldSize } from "../../Server/botField.js";
import { SIMULATION_TICK_RATE, SPAWN_PHASE_SECONDS } from "../../Server/simulationConfig.js";
import { isRasterDifficulty, type RasterDifficulty } from "../../Core/messages.js";
import { applySessionCommand } from "../../Core/applySessionCommand.js";
import { fetchPrebuiltMap } from "../mapFetch.js";
import type { RasterClientMessage, RasterServerMessage } from "../../Core/types.js";

/**
 * Solo match host, running inside a dedicated Web Worker.
 *
 * This is the OpenFront-style client-side simulation: the worker owns a real
 * {@link RasterGameSession} plus its field of {@link RasterBotController} bots and
 * ticks the authoritative sim locally at {@link SIMULATION_TICK_RATE}. The main
 * thread only sends intents and renders the snapshots the worker emits, so there
 * is no per-tick network round-trip and both the simulation and its
 * (base64) serialization run off the render thread.
 *
 * The session class is import-graph-clean of Node built-ins (verified by
 * `tests/soloWorkerImports.test.ts`), so it loads unchanged in the browser. The
 * only thing the worker can't build itself is the terrain (the source PNG decode
 * needs `node:zlib`), so it fetches a prebuilt terrain plane from `/api/solo/map`.
 */

/** Main → worker envelope. */
type Inbound = { type: "CLIENT"; message: RasterClientMessage };

/** Minimal typing for the dedicated-worker global (avoids needing the WebWorker
 * lib alongside DOM, which would clash on shared globals). */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: Inbound }) => void) | null;
}
const ctx = self as unknown as WorkerScope;

const LOCAL_CLIENT_ID = "local";

let session: RasterGameSession | null = null;
let timer: number | null = null;
let starting = false;
const botUnsubs: Array<() => void> = [];

const emit = (message: RasterServerMessage): void => {
  ctx.postMessage({ type: "SERVER", message });
};

/** Fetch the prebuilt terrain plane and seat the match (human + bot field). */
const start = async (mapId: string | undefined, rawDifficulty: unknown, rawFieldSize: unknown): Promise<void> => {
  if (starting || session) return;
  starting = true;
  const difficulty: RasterDifficulty = isRasterDifficulty(rawDifficulty) ? rawDifficulty : "medium";
  const fieldSize = typeof rawFieldSize === "number" && Number.isFinite(rawFieldSize) ? rawFieldSize : undefined;

  // No id → let the server pick its default map (matches the WebSocket path).
  const { map, name: mapName } = await fetchPrebuiltMap(mapId);

  const live = new RasterGameSession({
    prebuiltMap: map,
    mapName,
    spawnPhaseTicks: SPAWN_PHASE_SECONDS * SIMULATION_TICK_RATE,
    // Without this the session fell back to its "medium" default and every
    // nation was seated with medium handicaps whatever the menu said (the
    // personalities were scaled, the start/cap/growth numbers weren't).
    difficulty,
  });
  session = live;

  // Seat the human first (player 1, unspawned until they pick a start tile), then
  // the bot field — identical seating order to the server's MatchRegistry.
  live.subscribe(LOCAL_CLIENT_ID, emit, /*autoSpawn*/ false, /*wantsRaster*/ true);

  // The AI field: the lobby's requested size (OpenFront's `bots` slider) or the
  // map-scaled default. buildFieldConfigs is the exact same seating logic the
  // authoritative server uses (bot-heavy mix, per-seat cadence/phase/handicaps),
  // so solo-worker and websocket matches can never drift.
  const total = resolveFieldSize(live.peekGrid().capturableCount, difficulty, fieldSize);
  for (const cfg of buildFieldConfigs(total, difficulty, LOCAL_CLIENT_ID)) {
    botUnsubs.push(new RasterBotController(cfg).attach(live));
  }

  timer = setInterval(() => live.tick(), Math.round(1000 / SIMULATION_TICK_RATE)) as unknown as number;
};

ctx.onmessage = (event): void => {
  const data = event.data;
  if (!data || data.type !== "CLIENT") return;
  const message = data.message;

  if (message.type === "CLIENT_RASTER_JOIN") {
    void start(message.payload.mapId, message.payload.difficulty, message.payload.fieldSize);
    return;
  }
  if (!session) return;

  // Every in-match command routes through the shared dispatcher — the same
  // one the lockstep replica uses — so the two sim hosts can't drift on
  // which message types they understand.
  applySessionCommand(session, LOCAL_CLIENT_ID, message);
};

// Signal readiness so the client sends its JOIN (which carries the map choice).
ctx.postMessage({ type: "OPEN" });

// Keep the timer reference reachable for tooling; cleanup happens on worker
// termination (the client discards the worker when the match ends / reloads).
void timer;
void botUnsubs;
