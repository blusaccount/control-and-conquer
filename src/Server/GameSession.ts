import { ClientCommand, GameState } from "../Core/types.js";
import { MapState } from "../Core/MapState.js";

type Subscriber = (snapshot: GameState) => void;

export class GameSession {
  private readonly mapState = new MapState();

  private readonly subscribers = new Set<Subscriber>();

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
    this.mapState.tick();
    this.broadcast();
  }

  public handleCommand(command: ClientCommand): void {
    this.mapState.applyCommand(command);
    this.broadcast();
  }

  private broadcast(): void {
    const snapshot = this.mapState.getSnapshot();

    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }
}
