import { RasterGameSession, type RasterMessageHandler } from "../../Server/RasterGameSession.js";
import { applySessionCommand } from "../../Core/applySessionCommand.js";
import type { LockstepSeat, RasterTurn } from "../../Core/lockstep.js";
import type { RasterClientMessage } from "../../Core/types.js";

/**
 * Client-side replica of a lockstep match (see `Core/lockstep.ts`).
 *
 * Owns a {@link RasterGameSession} — the *same* deterministic sim the referee
 * runs — seats it exactly as the referee did, then advances it one tick per
 * relayed {@link RasterTurn}: apply the turn's commands in recorded order,
 * compare the referee's embedded state hash (when present), simulate the tick.
 * The server's cadence paces the replica; there is no local timer.
 *
 * The local player's seat subscribes with the caller's `send`, so the replica
 * emits the identical `RasterServerMessage` stream the authoritative server
 * would have sent — assignment, snapshots, rejections, match end — and the
 * rendering client upstream needs no changes at all. Every other seat (the
 * referee's bots, other humans) subscribes headless: their *commands* arrive
 * through the turns, so no AI runs here.
 *
 * Import-graph-clean of Node built-ins (covered by `soloWorkerImports.test`),
 * so it loads in the browser Web Worker unchanged.
 */
export class LockstepReplica {
  private readonly session: RasterGameSession;
  /** Local client-id per seated player, for re-applying relayed commands. */
  private readonly clientIds = new Map<number, string>();
  /** The next relay-turn sequence number this replica expects. */
  private nextTurn = 0;

  public constructor(options: {
    /** A freshly constructed session on the referee's exact map + options. */
    session: RasterGameSession;
    /** The referee's seat list, from `SERVER_RASTER_LOCKSTEP_START`. */
    seats: LockstepSeat[];
    /** Which seat is this client's own player. */
    yourPlayerId: number;
    /** Receives the local player's server-message stream (snapshots etc.). */
    send: RasterMessageHandler;
  }) {
    this.session = options.session;
    // Seat every player in ascending id order — the exact order the referee
    // subscribed them — so ids, names, colors and the auto-spawn mutations of
    // the AI seats replay identically before the first turn arrives.
    const seats = [...options.seats].sort((a, b) => a.playerId - b.playerId);
    for (const seat of seats) {
      const isLocal = seat.playerId === options.yourPlayerId;
      const clientId = isLocal ? "local" : `seat-${seat.playerId}`;
      const unsubscribe = this.session.subscribe(
        clientId,
        isLocal ? options.send : () => {},
        /* autoSpawn */ seat.kind !== "human",
        /* wantsRaster */ isLocal,
        seat.name,
        seat.kind,
      );
      if (!unsubscribe || this.session.playerIdOf(clientId) !== seat.playerId) {
        throw new Error(`Lockstep replica could not mirror seat ${seat.playerId} (${seat.name}).`);
      }
      this.clientIds.set(seat.playerId, clientId);
    }
  }

  /** The replica's state hash — must match the referee's at every hash turn. */
  public stateHash(): number {
    return this.session.stateHash();
  }

  /**
   * Apply one relayed turn and advance the sim a tick. Returns the hash
   * comparison when the turn carried the referee's hash: `null` means in sync
   * (or no hash this turn); a value reports the divergence for the UI.
   * Throws on a sequence gap — a lost turn can never be papered over, the
   * replica would silently diverge.
   */
  public applyTurn(turn: RasterTurn): { expectedHash: number; localHash: number } | null {
    if (turn.turn !== this.nextTurn) {
      throw new Error(`Lockstep turn gap: expected ${this.nextTurn}, got ${turn.turn}.`);
    }
    this.nextTurn += 1;

    for (const { playerId, command } of turn.commands) {
      this.applyCommand(playerId, command);
    }

    let desync: { expectedHash: number; localHash: number } | null = null;
    if (turn.hash !== undefined) {
      const localHash = this.session.stateHash();
      if (localHash !== turn.hash) desync = { expectedHash: turn.hash, localHash };
    }

    this.session.tick();
    return desync;
  }

  /**
   * Re-apply a relayed command through the same session entry point the
   * referee used, as the same player — validation and rejections replay
   * identically, so only accepted effects touch the sim. Dispatch itself is
   * the shared {@link applySessionCommand}, so referee-side and replica-side
   * command routing can never drift apart.
   */
  private applyCommand(playerId: number, command: RasterClientMessage): void {
    const clientId = this.clientIds.get(playerId);
    if (clientId === undefined) return; // unknown seat — nothing it could have touched
    applySessionCommand(this.session, clientId, command);
  }
}
