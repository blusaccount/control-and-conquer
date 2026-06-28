import { Buffer } from "node:buffer";
import type { RasterGameSession, RasterMessageHandler } from "./RasterGameSession.js";
import { NEUTRAL_PLAYER, type PlayerId } from "../Core/TerritoryGrid.js";
import type { RasterExpandIntent, RasterServerMessage, RasterSnapshot } from "../Core/types.js";

export interface RasterBotConfig {
  readonly botId: string;
  readonly expandCooldownTicks: number;
  /** Percent of pool committed per expand intent (1..100). */
  readonly percent: number;
  /** Minimum pool size before the bot bothers expanding. */
  readonly minPool: number;
}

export const DEFAULT_RASTER_BOT_CONFIG: RasterBotConfig = {
  botId: "raster-bot-1",
  expandCooldownTicks: 30, // 1.5s @ 20 TPS
  percent: 40,
  minPool: 20,
};

/**
 * Server-side bot for raster (openfront-style) matches. Subscribes to a
 * `RasterGameSession` and queues `RasterExpandIntent`s back into the same
 * session — exactly like a human client would.
 *
 * Strategy: every `expandCooldownTicks`, scan the bot's frontier (neutral and
 * enemy tiles touching its area). Pick the frontier tile with the lowest
 * elevation (cheapest to capture) and target it. Deterministic: no RNG; ties
 * broken by ascending TileRef order.
 */
export class RasterBotController {
  private myPlayerId: PlayerId | null = null;
  private lastExpandTick = Number.NEGATIVE_INFINITY;
  private session: RasterGameSession | null = null;
  private width = 0;
  private height = 0;
  /** Last decoded owner snapshot (Uint16). */
  private owner: Uint16Array | null = null;

  public constructor(private readonly config: RasterBotConfig = DEFAULT_RASTER_BOT_CONFIG) {}

  public attach(session: RasterGameSession): () => void {
    this.session = session;
    const unsubscribe = session.subscribe(this.config.botId, (message) => this.onMessage(message));
    return () => {
      this.session = null;
      this.myPlayerId = null;
      this.owner = null;
      unsubscribe();
    };
  }

  public getPlayerId(): PlayerId | null {
    return this.myPlayerId;
  }

  public getBotId(): string {
    return this.config.botId;
  }

  public getLastExpandTick(): number {
    return this.lastExpandTick;
  }

  private onMessage(message: RasterServerMessage): void {
    if (message.type === "SERVER_RASTER_PLAYER_ASSIGNED") {
      this.myPlayerId = message.payload.playerId;
      return;
    }
    if (message.type === "SERVER_RASTER_SNAPSHOT") {
      this.handleSnapshot(message.payload);
    }
  }

  private handleSnapshot(snapshot: RasterSnapshot): void {
    if (!this.myPlayerId || !this.session) return;
    if (snapshot.winnerPlayerId !== null) return;

    // Decode the owner array. The grid never changes dimensions mid-match so
    // we can lazy-allocate once.
    this.width = snapshot.width;
    this.height = snapshot.height;
    const ownerBuffer = Buffer.from(snapshot.ownerBase64, "base64");
    if (!this.owner || this.owner.length !== this.width * this.height) {
      this.owner = new Uint16Array(this.width * this.height);
    }
    for (let i = 0; i < this.owner.length; i += 1) {
      this.owner[i] = ownerBuffer.readUInt16LE(i * 2);
    }

    if (snapshot.tick - this.lastExpandTick < this.config.expandCooldownTicks) return;

    const myStanding = snapshot.players.find((p) => p.playerId === this.myPlayerId);
    if (!myStanding || myStanding.troops < this.config.minPool) return;

    const target = this.pickFrontierTile();
    if (!target) return;

    const intent: RasterExpandIntent = {
      targetX: target.x,
      targetY: target.y,
      percent: this.config.percent,
    };
    this.lastExpandTick = snapshot.tick;
    this.session.queueExpand(this.config.botId, intent);
  }

  /**
   * Walk every non-owned tile that borders one of the bot's tiles. Among those,
   * pick the one with the most reachable owned neighbours (= least exposed
   * push) and lowest TileRef as tiebreaker. Returns `null` if no frontier.
   */
  private pickFrontierTile(): { x: number; y: number } | null {
    if (!this.owner || !this.myPlayerId) return null;
    const me = this.myPlayerId;
    const w = this.width;
    const h = this.height;
    const owner = this.owner;

    let bestRef = -1;
    let bestNeighbours = -1;

    for (let ref = 0; ref < owner.length; ref += 1) {
      if (owner[ref] === me) continue;
      // Count owned neighbours; if zero, skip.
      const x = ref % w;
      const y = Math.floor(ref / w);
      let neighbours = 0;
      if (x > 0 && owner[ref - 1] === me) neighbours += 1;
      if (x < w - 1 && owner[ref + 1] === me) neighbours += 1;
      if (y > 0 && owner[ref - w] === me) neighbours += 1;
      if (y < h - 1 && owner[ref + w] === me) neighbours += 1;
      if (neighbours === 0) continue;

      if (neighbours > bestNeighbours) {
        bestNeighbours = neighbours;
        bestRef = ref;
      }
    }

    if (bestRef < 0) return null;
    return { x: bestRef % w, y: Math.floor(bestRef / w) };
  }
}
