import { ClientCommand, GameState } from "../Core/types.js";
import { MapState } from "../Core/MapState.js";

type Subscriber = (snapshot: GameState) => void;
type QueuedCommand = { sequence: number; command: ClientCommand };

export class GameSession {
  private readonly mapState = new MapState();

  private readonly subscribers = new Set<Subscriber>();
  private readonly pendingCommands: QueuedCommand[] = [];
  private nextCommandSequence = 0;

  public subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.mapState.getSnapshot());

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  public getSnapshot(): GameState {
    return this.mapState.getSnapshot();
  }

  public tick(): void {
    this.processQueuedCommands();
    this.mapState.tick();
    this.broadcast();
  }

  public queueCommand(command: ClientCommand): void {
    this.pendingCommands.push({ sequence: this.nextCommandSequence, command });
    this.nextCommandSequence += 1;
  }

  public handleCommand(command: ClientCommand): void {
    this.queueCommand(command);
  }

  public getPendingCommandCount(): number {
    return this.pendingCommands.length;
  }

  private processQueuedCommands(): void {
    const queuedCommands = this.pendingCommands
      .slice()
      .sort((left, right) => left.sequence - right.sequence);
    this.pendingCommands.length = 0;

    for (const queuedCommand of queuedCommands) {
      try {
        this.mapState.applyCommand(queuedCommand.command);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown command error.";
        console.warn(`Dropping invalid command at sequence ${queuedCommand.sequence}: ${message}`);
      }
    }
  }

  private broadcast(): void {
    const snapshot = this.mapState.getSnapshot();

    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }
}
