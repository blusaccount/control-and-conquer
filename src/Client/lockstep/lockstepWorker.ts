import { RasterGameSession } from "../../Server/RasterGameSession.js";
import { LockstepReplica } from "./replica.js";
import { fetchPrebuiltMap } from "../mapFetch.js";
import type { RasterLockstepStartPayload, RasterTurn } from "../../Core/lockstep.js";
import type { RasterServerMessage } from "../../Core/types.js";

/**
 * Lockstep replica host, running inside a dedicated Web Worker.
 *
 * The main thread owns the WebSocket to the referee and forwards two things
 * here: the one-time `SERVER_RASTER_LOCKSTEP_START` setup and the per-tick
 * `SERVER_RASTER_TURN` stream. This worker fetches the match's prebuilt
 * terrain (same asset the solo worker uses), reconstructs the referee's exact
 * session, and lets a {@link LockstepReplica} advance it turn by turn — so the
 * sim *and* its snapshot serialization run off the render thread, and the
 * main thread receives the identical `RasterServerMessage` stream a
 * snapshot-streaming server would have sent.
 *
 * Turns that arrive while the terrain fetch is still in flight are buffered
 * and drained in order once the replica is up — the same mechanism doubles as
 * catch-up after a stall (the sim fast-forwards through the backlog).
 */

/** Main → worker envelope. */
type Inbound =
  | { type: "SETUP"; payload: RasterLockstepStartPayload }
  | { type: "TURN"; payload: RasterTurn }
  /** A resume backlog: the match's full turn history, applied as fast-forward. */
  | { type: "BACKLOG"; payload: { turns: RasterTurn[] } };

/** Minimal typing for the dedicated-worker global (avoids the WebWorker lib
 * alongside DOM, which would clash on shared globals). */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: Inbound }) => void) | null;
}
const ctx = self as unknown as WorkerScope;

const emit = (message: RasterServerMessage): void => {
  ctx.postMessage({ type: "SERVER", message });
};

/**
 * Report an unrecoverable boot/replay failure to the main thread. A worker's
 * unhandled promise rejection never reaches the parent's `Worker.onerror`,
 * so without this explicit channel a failed map fetch or setup mismatch
 * would leave the player on a silent black screen.
 */
const emitFatal = (error: unknown): void => {
  dead = true;
  ctx.postMessage({ type: "FATAL", message: error instanceof Error ? error.message : String(error) });
};

let replica: LockstepReplica | null = null;
let starting = false;
/** Turns received before the replica finished booting, in arrival order. */
const pendingTurns: RasterTurn[] = [];
/** Stop applying turns after a fatal setup/desync error — never render junk. */
let dead = false;

const applyTurn = (turn: RasterTurn): void => {
  if (!replica || dead) return;
  let desync: ReturnType<LockstepReplica["applyTurn"]>;
  try {
    desync = replica.applyTurn(turn);
  } catch (error) {
    // A turn gap or a replay throw is unrecoverable for this replica —
    // surface it instead of silently freezing.
    emitFatal(error);
    return;
  }
  if (desync) {
    // Surface the divergence; keep simulating so the player can finish the
    // match, exactly like OpenFront's desync notice. (A future resync will
    // fetch a referee snapshot instead.)
    emit({
      type: "SERVER_RASTER_DESYNC",
      payload: { turn: turn.turn, expectedHash: desync.expectedHash, localHash: desync.localHash },
    });
  }
};

const start = async (setup: RasterLockstepStartPayload): Promise<void> => {
  if (starting || replica) return;
  starting = true;

  // The referee's map, prebuilt server-side — identical bytes to what its own
  // session was constructed from, which the terrain hash below proves.
  const { map } = await fetchPrebuiltMap(setup.mapId);

  const session = new RasterGameSession({
    prebuiltMap: map,
    mapName: setup.mapName,
    spawnPhaseTicks: setup.spawnPhaseTicks,
    difficulty: setup.difficulty,
    startingTroops: setup.startingTroops,
  });
  if (session.peekTerrainHash() !== setup.terrainHash) {
    throw new Error(
      `Lockstep map mismatch: referee terrain ${setup.terrainHash}, fetched ${session.peekTerrainHash()}.`,
    );
  }

  replica = new LockstepReplica({
    session,
    seats: setup.seats,
    yourPlayerId: setup.yourPlayerId,
    send: emit,
  });

  // Drain everything that arrived while the map was in flight, in order.
  while (pendingTurns.length > 0 && !dead) {
    applyTurn(pendingTurns.shift() as RasterTurn);
  }
};

ctx.onmessage = (event): void => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SETUP") {
    // Boot failures (map fetch, terrain mismatch, seat mirror) must surface —
    // an unhandled rejection here would be invisible to the main thread.
    start(data.payload).catch(emitFatal);
    return;
  }
  if (data.type === "TURN") {
    if (replica) applyTurn(data.payload);
    else pendingTurns.push(data.payload);
    return;
  }
  if (data.type === "BACKLOG") {
    // Fast-forward history — same path as live turns, just many at once.
    for (const turn of data.payload.turns) {
      if (replica) applyTurn(turn);
      else pendingTurns.push(turn);
    }
  }
};

// Signal readiness (same envelope contract as the solo worker).
ctx.postMessage({ type: "OPEN" });
