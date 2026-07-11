// ---------------------------------------------------------------------------
// Server-refereed lockstep: wire types + state hashing.
//
// The scalable multiplayer path (OpenFront-style turn relay, but with the
// authoritative server still simulating as referee):
//
//  - Clients send the same intents as ever; the server applies them to its own
//    sim (the referee) **and** records them, stamped with the acting player.
//  - Once per tick the server broadcasts a `RasterTurn` — the recorded
//    commands since the previous tick — to every lockstep subscriber. That is
//    the *only* per-tick traffic a lockstep client receives: no snapshots, no
//    owner rasters, just intents (a few hundred bytes instead of the delta
//    stream, which is what makes 100-player lobbies affordable).
//  - Each client runs the identical deterministic sim locally (the same
//    `RasterGameSession` the solo Web Worker already hosts) and advances it
//    one tick per received turn, so the server's cadence paces every replica.
//  - Every `HASH_INTERVAL_TICKS` turns the server embeds its own state hash;
//    a replica whose hash differs knows it has desynced from the referee.
//
// Everything in this module is pure data + portable integer math (no Node
// built-ins, no `Math.random`, no wall clock) so it loads unchanged in the
// browser Web Worker that hosts the replica.
// ---------------------------------------------------------------------------

import type { RasterClientMessage, RasterPlayerKind } from "./types.js";
import type { RasterDifficulty } from "./messages.js";

/**
 * How many turns lie between two embedded referee hashes. At 10 TPS this is a
 * check every ~5 seconds — frequent enough to catch a drift near its cause,
 * rare enough that the full-raster hash scan never shows up in a profile.
 */
export const HASH_INTERVAL_TICKS = 50;

/**
 * One recorded command: which player acted, and the exact wire message they
 * sent. The replica re-applies it through the very same session entry points
 * the server used, so validation/rejection replays identically and only
 * *accepted* effects touch the sim.
 */
export interface RasterTurnCommand {
  playerId: number;
  command: RasterClientMessage;
}

/**
 * One relay turn: every command the referee recorded since the previous turn,
 * in exact application order. `turn` is a dense sequence number (0, 1, 2 …) —
 * one per server tick, including spawn-phase ticks — so a replica can detect
 * gaps. `hash` carries the referee's state hash on hash-interval turns; the
 * replica compares its own hash *after applying this turn's commands and
 * before simulating the tick* (the one instant both sides are guaranteed to
 * agree on, since eager server-side application and deferred replica
 * application converge exactly there).
 */
export interface RasterTurn {
  turn: number;
  commands: RasterTurnCommand[];
  hash?: number;
}

/** One seat of the match, as the referee seated it (replica must mirror this). */
export interface LockstepSeat {
  playerId: number;
  kind: RasterPlayerKind;
  name: string;
  color: string;
}

/**
 * Sent once to a lockstep client after the referee has seated the whole match.
 * Carries everything a replica needs to reconstruct the identical session:
 * the map (fetched by id, integrity-checked via `terrainHash`), the session
 * options that shape the sim, and the full seat list in seating order.
 */
export interface RasterLockstepStartPayload {
  /** Catalogue id of the match's map — the replica fetches the same prebuilt terrain. */
  mapId: string;
  /**
   * Transient token for a player-made (editor) map: when present the replica
   * fetches the terrain via `/api/solo/map?token=...` instead of by `mapId`.
   * Valid only while this match runs; the map is never persisted.
   */
  mapToken?: string;
  mapName: string;
  /** Fingerprint of the terrain bytes; the replica refuses a map that differs. */
  terrainHash: string;
  difficulty: RasterDifficulty;
  spawnPhaseTicks: number;
  startingTroops: number;
  tickRate: number;
  /** The receiving client's own seat. */
  yourPlayerId: number;
  /** Every seat in ascending playerId order, exactly as the referee subscribed them. */
  seats: LockstepSeat[];
  /**
   * Secret per-seat token for `CLIENT_RASTER_RESUME`: after a dropped socket,
   * presenting it re-binds this seat to the new connection and replays the
   * turn backlog. Never shared with other players.
   */
  resumeToken: string;
}

/** Referee → lockstep client: the match is seated; build your replica. */
export type RasterLockstepStartServerMessage = {
  type: "SERVER_RASTER_LOCKSTEP_START";
  payload: RasterLockstepStartPayload;
};

/** Referee → lockstep client: one relay turn (the per-tick heartbeat). */
export type RasterTurnServerMessage = {
  type: "SERVER_RASTER_TURN";
  payload: RasterTurn;
};

/**
 * Referee → resuming client: the full turn history of the match so far, in
 * one message (one deflate frame instead of thousands of tiny sends). A fresh
 * replica applies it turn by turn — deterministic fast-forward to the live
 * state — then the normal per-tick turn stream continues.
 */
export type RasterTurnBacklogServerMessage = {
  type: "SERVER_RASTER_TURN_BACKLOG";
  payload: { turns: RasterTurn[] };
};

/**
 * Surfaced when a replica's state hash disagrees with the referee's embedded
 * hash. Synthesised *client-side* by the replica worker (the referee's hash
 * rode in on the turn), so the union carries it like any server message and
 * the UI can warn without a extra round-trip.
 */
export interface RasterDesyncPayload {
  turn: number;
  expectedHash: number;
  localHash: number;
}

export type RasterDesyncServerMessage = {
  type: "SERVER_RASTER_DESYNC";
  payload: RasterDesyncPayload;
};

// ---------------------------------------------------------------------------
// State hashing (FNV-1a over 32-bit words).
//
// Both sides fold the same integer stream in the same order, using only
// `Math.imul`/`>>>` so the result is identical across V8, browser workers and
// any IEEE-754-faithful engine.
// ---------------------------------------------------------------------------

/** FNV-1a offset basis. */
export const fnv1aInit = (): number => 0x811c9dc5;

/** Fold one 32-bit word into an FNV-1a hash, byte by byte. */
export const fnv1aMix = (hash: number, word: number): number => {
  let h = hash;
  h = Math.imul(h ^ (word & 0xff), 0x01000193);
  h = Math.imul(h ^ ((word >>> 8) & 0xff), 0x01000193);
  h = Math.imul(h ^ ((word >>> 16) & 0xff), 0x01000193);
  h = Math.imul(h ^ ((word >>> 24) & 0xff), 0x01000193);
  return h >>> 0;
};
