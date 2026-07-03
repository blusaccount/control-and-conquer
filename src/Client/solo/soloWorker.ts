import { GameMap } from "../../Core/GameMap.js";
import { RasterGameSession } from "../../Server/RasterGameSession.js";
import { FILLER_PERSONALITY, RasterBotController, RASTER_BOT_PERSONALITIES } from "../../Server/RasterBotController.js";
import { kindForSeat, MAX_RASTER_BOTS, NATION_CONFUSION_CHANCE, scaleBotCount, scalePersonality } from "../../Server/botField.js";
import { SIMULATION_TICK_RATE, SPAWN_PHASE_SECONDS } from "../../Server/simulationConfig.js";
import { isRasterDifficulty, type RasterDifficulty } from "../../Core/messages.js";
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
const start = async (mapId: string | undefined, rawDifficulty: unknown): Promise<void> => {
  if (starting || session) return;
  starting = true;
  const difficulty: RasterDifficulty = isRasterDifficulty(rawDifficulty) ? rawDifficulty : "medium";

  // No id → let the server pick its default map (matches the WebSocket path).
  const res = await fetch(mapId ? `/api/solo/map?id=${encodeURIComponent(mapId)}` : "/api/solo/map");
  const mapName = decodeURIComponent(res.headers.get("x-map-name") ?? "");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const map = new GameMap(width, height, bytes.subarray(8));

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

  const seats = Math.max(0, Math.min(scaleBotCount(live.peekGrid().capturableCount, difficulty), MAX_RASTER_BOTS));
  // Identical seat mix to the server's MatchRegistry: every third seat is a
  // passive Bot/Tribe filler, the rest full Nations with difficulty-scaled
  // personalities and the per-difficulty confusion chance. (This path used to
  // seat plain nations only — a drift from the websocket path, now fixed.)
  for (let i = 0; i < seats; i += 1) {
    const kind = kindForSeat(i);
    const personality =
      kind === "bot" ? FILLER_PERSONALITY : scalePersonality(RASTER_BOT_PERSONALITIES[i % RASTER_BOT_PERSONALITIES.length], difficulty);
    const bot = new RasterBotController({
      botId: `${LOCAL_CLIENT_ID}-bot-${i + 1}`,
      personality,
      kind,
      confusionChance: kind === "nation" ? NATION_CONFUSION_CHANCE[difficulty] : 0,
    });
    botUnsubs.push(bot.attach(live));
  }

  timer = setInterval(() => live.tick(), Math.round(1000 / SIMULATION_TICK_RATE)) as unknown as number;
};

ctx.onmessage = (event): void => {
  const data = event.data;
  if (!data || data.type !== "CLIENT") return;
  const message = data.message;

  if (message.type === "CLIENT_RASTER_JOIN") {
    void start(message.payload.mapId, message.payload.difficulty);
    return;
  }
  if (!session) return;

  switch (message.type) {
    case "CLIENT_RASTER_SELECT_SPAWN":
      session.selectSpawn(LOCAL_CLIENT_ID, message.payload.x, message.payload.y);
      break;
    case "CLIENT_RASTER_EXPAND":
      session.queueExpand(LOCAL_CLIENT_ID, message.payload);
      break;
    case "CLIENT_RASTER_BUILD":
      session.queueBuild(LOCAL_CLIENT_ID, message.payload);
      break;
    case "CLIENT_RASTER_NUKE":
      session.queueNuke(LOCAL_CLIENT_ID, message.payload);
      break;
    case "CLIENT_RASTER_ALLY_PROPOSE":
      session.proposeAlliance(LOCAL_CLIENT_ID, message.payload.targetId);
      break;
    case "CLIENT_RASTER_ALLY_RESPOND":
      session.respondAlliance(LOCAL_CLIENT_ID, message.payload.targetId, message.payload.accept);
      break;
    case "CLIENT_RASTER_ALLY_BREAK":
      session.breakAlliance(LOCAL_CLIENT_ID, message.payload.targetId);
      break;
    case "CLIENT_RASTER_ALLY_RENEW":
      session.renewAlliance(LOCAL_CLIENT_ID, message.payload.targetId);
      break;
    case "CLIENT_RASTER_DONATE":
      session.donate(LOCAL_CLIENT_ID, message.payload.targetId, message.payload.resource, message.payload.percent);
      break;
    case "CLIENT_RASTER_EMBARGO":
      session.setEmbargo(LOCAL_CLIENT_ID, message.payload.targetId, message.payload.on);
      break;
    case "CLIENT_RASTER_TARGET_REQUEST":
      session.requestTarget(LOCAL_CLIENT_ID, message.payload.allyId, message.payload.targetId);
      break;
    case "CLIENT_RASTER_EMOJI":
      session.sendEmoji(LOCAL_CLIENT_ID, message.payload.targetId, message.payload.emoji);
      break;
  }
};

// Signal readiness so the client sends its JOIN (which carries the map choice).
ctx.postMessage({ type: "OPEN" });

// Keep the timer reference reachable for tooling; cleanup happens on worker
// termination (the client discards the worker when the match ends / reloads).
void timer;
void botUnsubs;
