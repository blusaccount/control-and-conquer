import { MapState } from "../Core/MapState.js";
import { AttackOrder, ServerMessage, TeamId } from "../Core/types.js";

type MessageHandler = (message: ServerMessage) => void;

interface Subscriber {
  id: string;
  teamId: TeamId;
  send: MessageHandler;
}

interface PendingAttack {
  clientId: string;
  teamId: TeamId;
  order: AttackOrder;
}

const TEAM_ROTATION: TeamId[] = ["blue", "red"];

export class GameSession {
  private readonly mapState: MapState;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly pendingAttacks: PendingAttack[] = [];
  private nextTeamIndex = 0;
  private matchEndedBroadcast = false;

  public constructor(initialState?: ConstructorParameters<typeof MapState>[0]) {
    this.mapState = new MapState(initialState);
  }

  public subscribe(clientId: string, send: MessageHandler): () => void {
    const teamId = TEAM_ROTATION[this.nextTeamIndex % TEAM_ROTATION.length];
    this.nextTeamIndex += 1;

    const subscriber: Subscriber = { id: clientId, teamId, send };
    this.subscribers.set(clientId, subscriber);

    send({
      type: "SERVER_PLAYER_ASSIGNED",
      payload: { teamId },
    });
    send({
      type: "SERVER_STATE_SNAPSHOT",
      payload: this.mapState.getSnapshot(),
    });

    return () => {
      this.subscribers.delete(clientId);
    };
  }

  public queueAttack(clientId: string, order: AttackOrder): void {
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber) {
      return;
    }

    this.pendingAttacks.push({
      clientId,
      teamId: subscriber.teamId,
      order,
    });
  }

  public tick(): void {
    const queuedAttacks = this.pendingAttacks.splice(0, this.pendingAttacks.length);
    const result = this.mapState.processTick(queuedAttacks);

    for (const { clientId, rejection } of result.rejections) {
      const subscriber = this.subscribers.get(clientId);
      subscriber?.send({
        type: "SERVER_ACTION_REJECTED",
        payload: rejection,
      });
    }

    const snapshotMessage: ServerMessage = {
      type: "SERVER_STATE_SNAPSHOT",
      payload: result.snapshot,
    };

    for (const subscriber of this.subscribers.values()) {
      subscriber.send(snapshotMessage);
    }

    // Fire SERVER_MATCH_ENDED exactly once, after the final snapshot, so the
    // client can render the end state before reacting to the end-of-match.
    if (result.matchJustEnded && !this.matchEndedBroadcast && result.snapshot.winnerTeamId !== null) {
      this.matchEndedBroadcast = true;
      const endMessage: ServerMessage = {
        type: "SERVER_MATCH_ENDED",
        payload: { winnerTeamId: result.snapshot.winnerTeamId },
      };
      for (const subscriber of this.subscribers.values()) {
        subscriber.send(endMessage);
      }
    }
  }

  public getPendingAttackCount(): number {
    return this.pendingAttacks.length;
  }

  public getSubscriberCount(): number {
    return this.subscribers.size;
  }
}
