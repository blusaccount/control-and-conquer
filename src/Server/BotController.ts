import type { GameSession } from "./GameSession.js";
import type { AttackOrder, GameStateSnapshot, ServerMessage, TeamId } from "../Core/types.js";

/**
 * Tuning knobs for the built-in bot opponent.
 *
 * The bot operates purely off the public snapshot stream that the
 * GameSession broadcasts every tick. It enqueues attacks back into the same
 * session via `queueAttack`, exactly as a remote human client would. That
 * keeps the bot fully inside the trusted-base model — it is *not* a side
 * channel that bypasses validation.
 */
export interface BotConfig {
  /** Synthetic client id used when subscribing/queueing attacks. */
  readonly botId: string;
  /** Minimum ticks the bot waits between consecutive attack orders. */
  readonly attackCooldownTicks: number;
  /** Percentage of available source troops to commit per attack (0..1). */
  readonly attackPercent: number;
  /** Bot will not attack from a territory with fewer than this many troops. */
  readonly minSourceTroops: number;
  /**
   * Required attacker:defender troop ratio to actually launch an attack.
   * Higher = more cautious bot. 1.2 means attacker troops must be at least
   * 1.2x the defender's garrison to commit.
   */
  readonly minAttackRatio: number;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  botId: "bot-1",
  attackCooldownTicks: 30, // 1.5s @ 20 TPS — keeps the bot visibly active
  attackPercent: 0.9,
  minSourceTroops: 6,
  minAttackRatio: 0.6,
};

interface AttackCandidate {
  readonly sourceId: string;
  readonly targetId: string;
  readonly troops: number;
  readonly score: number;
}

/**
 * Server-side bot that observes a GameSession and queues attacks on the
 * session's behalf.
 *
 * Deterministic: the bot's only inputs are the snapshot it just received
 * and its own internal cooldown. It does not consult `Math.random` or wall
 * clock time. That keeps replays reproducible and respects the project's
 * "deterministic server" goal.
 */
export class BotController {
  private myTeamId: TeamId | null = null;
  private lastAttackTick = Number.NEGATIVE_INFINITY;
  private session: GameSession | null = null;

  public constructor(private readonly config: BotConfig = DEFAULT_BOT_CONFIG) {}

  /**
   * Subscribe the bot to a session. Returns an unsubscribe handle which
   * also detaches the session reference so the bot stops queueing attacks.
   */
  public attach(session: GameSession): () => void {
    this.session = session;
    const unsubscribe = session.subscribe(this.config.botId, (message) => {
      this.handleMessage(message);
    });
    return () => {
      this.session = null;
      this.myTeamId = null;
      unsubscribe();
    };
  }

  /** Exposed for tests so they can verify the assigned team. */
  public getTeamId(): TeamId | null {
    return this.myTeamId;
  }

  /** Exposed for tests so they can probe the cooldown bookkeeping. */
  public getLastAttackTick(): number {
    return this.lastAttackTick;
  }

  /** Exposed for tests; identifies the bot in queued attacks. */
  public getBotId(): string {
    return this.config.botId;
  }

  private handleMessage(message: ServerMessage): void {
    if (message.type === "SERVER_PLAYER_ASSIGNED") {
      this.myTeamId = message.payload.teamId;
      return;
    }
    if (message.type === "SERVER_STATE_SNAPSHOT") {
      this.tryAttack(message.payload);
    }
  }

  private tryAttack(snapshot: GameStateSnapshot): void {
    const session = this.session;
    const teamId = this.myTeamId;
    if (!session || !teamId) return;
    if (snapshot.winnerTeamId !== null) return;
    if (snapshot.tick - this.lastAttackTick < this.config.attackCooldownTicks) return;

    const candidate = this.pickBestAttack(snapshot, teamId);
    if (!candidate) return;

    const order: AttackOrder = {
      sourceTerritoryId: candidate.sourceId,
      targetTerritoryId: candidate.targetId,
      troops: candidate.troops,
    };
    this.lastAttackTick = snapshot.tick;
    session.queueAttack(this.config.botId, order);
  }

  /**
   * Deterministic scan of the snapshot to find the most favourable attack.
   * Iteration order follows `territoryOrder`, which is canonical, so two
   * runs of the same snapshot always produce the same chosen attack.
   *
   * Score = (attacker troops - defender troops). Higher is better. Ties are
   * broken by territoryOrder iteration order (first one wins).
   */
  private pickBestAttack(snapshot: GameStateSnapshot, teamId: TeamId): AttackCandidate | null {
    const contestedTargets = new Set<string>();
    for (const conflict of snapshot.activeConflicts) {
      if (conflict.attackerTeamId !== teamId) {
        // Cannot launch a second attack on a target someone else is fighting.
        contestedTargets.add(conflict.targetTerritoryId);
      }
    }

    let best: AttackCandidate | null = null;

    for (const sourceId of snapshot.territoryOrder) {
      const source = snapshot.territories[sourceId];
      if (!source || source.ownerId !== teamId) continue;
      if (source.troops < this.config.minSourceTroops) continue;

      const troopsAvailable = source.troops - 1;
      const troopsToSend = Math.floor(troopsAvailable * this.config.attackPercent);
      if (troopsToSend < 1) continue;

      for (const targetId of source.neighbors) {
        const target = snapshot.territories[targetId];
        if (!target || target.ownerId === teamId) continue;
        if (contestedTargets.has(targetId)) continue;

        // Don't punch into a wall: require attacker advantage.
        if (troopsToSend < target.troops * this.config.minAttackRatio) continue;

        const score = troopsToSend - target.troops;
        if (!best || score > best.score) {
          best = { sourceId, targetId, troops: troopsToSend, score };
        }
      }
    }

    return best;
  }
}
