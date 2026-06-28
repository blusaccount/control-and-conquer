import { GameSession } from "./GameSession.js";
import { AttackOrder, GameStateSnapshot, ServerMessage } from "../Core/types.js";

type MessageHandler = (message: ServerMessage) => void;

/** Mutable reference so the cleanup function can be updated after p2 joins. */
interface CleanupRef {
  fn: () => void;
}

interface PendingLobbyEntry {
  readonly matchId: string;
  readonly clientId: string;
  readonly send: MessageHandler;
  readonly cleanup: CleanupRef;
}

/**
 * Manages isolated 1v1 matches.  Each pair of connecting clients is placed in
 * its own GameSession so that multiple player pairs can play simultaneously
 * without sharing state.
 *
 * Flow:
 *  1. First client to connect is placed in a "lobby slot" and receives
 *     SERVER_LOBBY_WAITING while waiting for an opponent.
 *  2. The next client to connect is paired with the waiting client.  Both
 *     receive SERVER_PLAYER_ASSIGNED + SERVER_STATE_SNAPSHOT and the match
 *     begins.
 *  3. Subsequent pairs repeat the same process in parallel matches.
 */
export class MatchRegistry {
  private readonly activeMatches = new Map<string, GameSession>();
  private readonly clientToSession = new Map<string, GameSession>();
  private pendingEntry: PendingLobbyEntry | null = null;
  private matchSequence = 0;

  /**
   * Optional starting snapshot every new match is seeded from (the selected
   * map). GameSession deep-clones it, so a single template is safe to share
   * across all sessions. Defaults to the built-in map when omitted.
   */
  public constructor(private readonly initialState?: GameStateSnapshot) {}

  /**
   * Register a new client connection.  Returns an unsubscribe function that
   * must be called when the client disconnects.
   */
  public join(clientId: string, send: MessageHandler): () => void {
    const cleanup: CleanupRef = { fn: () => {} };

    if (this.pendingEntry === null) {
      // No lobby slot open — create one and wait for a second player.
      this.matchSequence += 1;
      const matchId = `match-${this.matchSequence}`;

      cleanup.fn = () => {
        if (this.pendingEntry?.clientId === clientId) {
          this.pendingEntry = null;
        }
      };

      this.pendingEntry = { matchId, clientId, send, cleanup };
      send({ type: "SERVER_LOBBY_WAITING" });
    } else {
      // Lobby slot is open — pair with the waiting player and start the match.
      const p1 = this.pendingEntry;
      this.pendingEntry = null;

      const session = new GameSession(this.initialState);
      this.activeMatches.set(p1.matchId, session);

      const unsub1 = session.subscribe(p1.clientId, p1.send);
      const unsub2 = session.subscribe(clientId, send);

      this.clientToSession.set(p1.clientId, session);
      this.clientToSession.set(clientId, session);

      // Update p1's cleanup to unsubscribe from the live session.
      p1.cleanup.fn = () => {
        unsub1();
        this.clientToSession.delete(p1.clientId);
        this.removeMatchIfEmpty(p1.matchId, session);
      };

      cleanup.fn = () => {
        unsub2();
        this.clientToSession.delete(clientId);
        this.removeMatchIfEmpty(p1.matchId, session);
      };
    }

    return () => cleanup.fn();
  }

  public queueAttack(clientId: string, order: AttackOrder): void {
    this.clientToSession.get(clientId)?.queueAttack(clientId, order);
  }

  public tickAll(): void {
    for (const session of this.activeMatches.values()) {
      session.tick();
    }
  }

  public getPendingAttackCount(): number {
    let total = 0;
    for (const session of this.activeMatches.values()) {
      total += session.getPendingAttackCount();
    }
    return total;
  }

  private removeMatchIfEmpty(matchId: string, session: GameSession): void {
    if (session.getSubscriberCount() === 0) {
      this.activeMatches.delete(matchId);
    }
  }
}
