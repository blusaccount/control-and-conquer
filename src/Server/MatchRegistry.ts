import { BotController } from "./BotController.js";
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
 * Manages isolated matches. Two flavours:
 *
 *  - 1v1 PvP (via `join`): first connection is queued, second connection is
 *    paired and the match begins.
 *  - Solo vs bot (via `joinSolo`): a fresh session is created immediately
 *    with the human as one player and a server-side BotController as the
 *    other. The human plays alone against the bot.
 *
 * Each match owns its own GameSession so multiple matches can run in
 * parallel without sharing state.
 */
export class MatchRegistry {
  private readonly activeMatches = new Map<string, GameSession>();
  private readonly clientToSession = new Map<string, GameSession>();
  private pendingEntry: PendingLobbyEntry | null = null;
  private matchSequence = 0;

  public constructor(private readonly initialState?: GameStateSnapshot) {}

  /**
   * Join the PvP lobby. First client waits, second client triggers pairing.
   */
  public join(clientId: string, send: MessageHandler): () => void {
    const cleanup: CleanupRef = { fn: () => {} };

    if (this.pendingEntry === null) {
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
      const p1 = this.pendingEntry;
      this.pendingEntry = null;

      const session = new GameSession(this.initialState);
      this.activeMatches.set(p1.matchId, session);

      const unsub1 = session.subscribe(p1.clientId, p1.send);
      const unsub2 = session.subscribe(clientId, send);

      this.clientToSession.set(p1.clientId, session);
      this.clientToSession.set(clientId, session);

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

  /**
   * Start a solo match: the human is seated first (becomes Blue under the
   * default rotation) and a BotController is attached as the second player
   * (becomes Red). The match starts immediately — no lobby wait.
   */
  public joinSolo(clientId: string, send: MessageHandler): () => void {
    this.matchSequence += 1;
    const matchId = `match-${this.matchSequence}-solo`;

    const session = new GameSession(this.initialState);
    this.activeMatches.set(matchId, session);

    const unsubHuman = session.subscribe(clientId, send);
    this.clientToSession.set(clientId, session);

    const bot = new BotController();
    const unsubBot = bot.attach(session);

    return () => {
      unsubHuman();
      unsubBot();
      this.clientToSession.delete(clientId);
      this.removeMatchIfEmpty(matchId, session);
    };
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

  public getActiveMatchCount(): number {
    return this.activeMatches.size;
  }

  private removeMatchIfEmpty(matchId: string, session: GameSession): void {
    if (session.getSubscriberCount() === 0) {
      this.activeMatches.delete(matchId);
    }
  }
}
