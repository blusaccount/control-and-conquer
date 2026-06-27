import { ClientCommand, GameState } from "../Core/types.js";
import { MapState } from "../Core/MapState.js";

type Subscriber = (snapshot: GameState) => void;

export class GameSession {
  private readonly mapState = new MapState();

  private readonly subscribers = new Set<Subscriber>();
  private readonly pendingCommands: ClientCommand[] = [];

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
    this.pendingCommands.push(command);
  }

  public getPendingCommandCount(): number {
    return this.pendingCommands.length;
  }

  private processQueuedCommands(): void {
    const queuedCommands = this.pendingCommands.splice(0, this.pendingCommands.length);

    for (const queuedCommand of queuedCommands) {
      try {
        this.mapState.applyCommand(queuedCommand);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown command error.";
        console.warn(`Dropping invalid command from queue: ${message}`);
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
