import { GameMap } from "../../Core/GameMap.js";
import { RasterGameSession } from "../../Server/RasterGameSession.js";
import { LockstepReplica } from "./replica.js";
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
  | { type: "TURN"; payload: RasterTurn };

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

let replica: LockstepReplica | null = null;
let starting = false;
/** Turns received before the replica finished booting, in arrival order. */
const pendingTurns: RasterTurn[] = [];
/** Stop applying turns after a fatal setup/desync error — never render junk. */
let dead = false;

const applyTurn = (turn: RasterTurn): void => {
  if (!replica || dead) return;
  const desync = replica.applyTurn(turn);
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
  const res = await fetch(`/api/solo/map?id=${encodeURIComponent(setup.mapId)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const map = new GameMap(width, height, bytes.subarray(8));

  const session = new RasterGameSession({
    prebuiltMap: map,
    mapName: setup.mapName,
    spawnPhaseTicks: setup.spawnPhaseTicks,
    difficulty: setup.difficulty,
    startingTroops: setup.startingTroops,
  });
  if (session.peekTerrainHash() !== setup.terrainHash) {
    dead = true;
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
    void start(data.payload);
    return;
  }
  if (data.type === "TURN") {
    if (replica) applyTurn(data.payload);
    else pendingTurns.push(data.payload);
  }
};

// Signal readiness (same envelope contract as the solo worker).
ctx.postMessage({ type: "OPEN" });
