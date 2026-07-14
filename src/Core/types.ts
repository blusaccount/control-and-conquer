// ---------------------------------------------------------------------------
// Raster (openfront-style) protocol.
//
// The game is a pixel-raster territorial RTS. The server holds the master
// terrain + ownership state and ships:
//   - terrain bytes (one-time, base64-encoded — terrain never changes mid-match)
//   - owner array (every tick, base64-encoded Uint16 little-endian)
//   - per-player standings (troops pool, tile count)
//   - amphibious crossings resolved that tick (for client-side boat animation)
//
// The terrain hash lets the client cache the static raster and detect when a
// new match is started on the same socket. Client expand intents address tiles
// directly: "expand my border toward (x, y) with N percent of my pool".
// ---------------------------------------------------------------------------

import type {
  RasterAllyBreakClientMessage,
  RasterAllyRenewClientMessage,
  RasterAllyProposeClientMessage,
  RasterAllyRespondClientMessage,
  RasterDonateClientMessage,
  RasterEmbargoClientMessage,
  RasterEmojiClientMessage,
  RasterJoinClientMessage,
  RasterLobbyCreateClientMessage,
  RasterLobbyErrorServerMessage,
  RasterLobbyJoinClientMessage,
  RasterLobbyLeaveClientMessage,
  RasterLobbyStartClientMessage,
  RasterLobbyStateServerMessage,
  RasterResumeClientMessage,
  RasterRetreatClientMessage,
  RasterDeleteClientMessage,
  RasterSpawnClientMessage,
  RasterTargetRequestClientMessage,
} from "./messages.js";
import type { BuildingType } from "./buildings.js";
import type { NukeKind } from "./nukes.js";
import type {
  RasterDesyncServerMessage,
  RasterLockstepStartServerMessage,
  RasterTurnBacklogServerMessage,
  RasterTurnServerMessage,
} from "./lockstep.js";

/**
 * An active alliance in the snapshot: the canonical low/high player-id pair,
 * how many ticks remain before the pact lapses (OpenFront's 5-minute alliance
 * lifetime), and who has already voted to renew it — so a client can render a
 * countdown next to the 🤝 marker and a renewal prompt near expiry.
 */
/** A bare alliance as a canonical `[lowId, highId]` pair (external AI API wire shape). */
export type RasterAlliancePair = [number, number];

export interface RasterAllianceInfo {
  /** Lower player id of the pair. */
  a: number;
  /** Higher player id of the pair. */
  b: number;
  /** Ticks until the pact expires unless both sides renew. */
  ticksLeft: number;
  /** Player ids (of `a`/`b`) that have already voted to renew. */
  renewVotes: number[];
}

/** A pending, directed alliance proposal awaiting the recipient's response. */
export interface RasterAllianceRequest {
  from: number;
  to: number;
}

/** Per-player snapshot row for raster mode. */
/**
 * Which class a seat plays as — OpenFront's public `PlayerType` (Human, Nation
 * or Bot/"Tribe"). Public information in OpenFront too (its player-info
 * overlay names the type), and it drives both the client's labelling and the
 * nations' tribe-farming attack sizing.
 */
export type RasterPlayerKind = "human" | "bot" | "nation";

export interface RasterPlayerInfo {
  /** Engine-side numeric id (1+). 0 reserved for NEUTRAL. */
  playerId: number;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Hex color string, e.g. "#3b82f6". */
  color: string;
  /** Player class: human, full-strategy nation, or passive tribe filler. */
  kind: RasterPlayerKind;
  /** Current troop pool. */
  troops: number;
  /** Current gold pool — the economy resource spent on buildings. */
  gold: number;
  /**
   * Gold generated per second at the current territory + city count — what the
   * HUD renders as "(+N/s)" for gold. Server-computed so every client agrees.
   */
  goldPerSecond: number;
  /** Cities this player owns (economy/troop engine). */
  cities: number;
  /** Ports this player owns (sea-crossing reach). */
  ports: number;
  /** Forts this player owns (border fortification). */
  forts: number;
  /** Factories this player owns (railroad + train economy). */
  factories: number;
  /** Missile Silos this player owns (nuke launch platforms). */
  silos: number;
  /** Warships this player owns (coastal transport interdiction). */
  warships: number;
  /** SAM Launchers this player owns (warhead interception). */
  sams: number;
  /** Number of capturable tiles currently owned. */
  tiles: number;
  /**
   * Player id who most recently launched a land or sea attack against this
   * player (0 if nobody has yet). Public — combat is visible on the map
   * anyway — and drives the client's Shift+R "retaliate" hotkey.
   */
  lastAttackedBy: number;
  /**
   * Troops generated per second at the current territory size — what the
   * leaderboard renders as "(+N/s)". Server-computed from tile count so every
   * client shows the same figure.
   */
  troopsPerSecond: number;
  /**
   * Maximum troop pool at the current territory + city count (OpenFront's
   * territory-scaled population ceiling). Server-computed so the HUD and
   * leaderboard show `pool/max` without the client re-deriving the formula.
   */
  maxTroops: number;
  /**
   * True once this player has been wiped off the map — their last tile captured.
   * A nation is beaten only when its *entire* territory has been taken (there is
   * no capital shortcut); eliminated players hold no tiles and are dropped from
   * the active leaderboard.
   */
  eliminated: boolean;
  /**
   * How many alliances this player has *betrayed* (explicitly broken) over the
   * match — public reputation, mirroring OpenFront's permanent betrayal count.
   * Natural pact expiry doesn't count. Bots weigh this when answering offers.
   */
  betrayals: number;
}

/**
 * A transport-ship landing resolved on a tick: troops disembarked from the water
 * tile (`fromX`,`fromY`) onto (`toX`,`toY`). The client uses these to flash the
 * moment a ship reaches shore and captures its beachhead.
 */
export interface RasterCrossing {
  playerId: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/**
 * A transport ship in flight this snapshot: a vessel carrying `troops` of
 * `playerId` currently at tile (`x`,`y`) along its water route. Sent every
 * snapshot while the ship sails so the client can draw it gliding the shortest
 * path toward its target; it vanishes from the list once it lands.
 */
export interface RasterShip {
  shipId: number;
  playerId: number;
  x: number;
  y: number;
  troops: number;
  /**
   * The rest of the ship's water route as downsampled waypoints (ending on
   * the landing tile), so the client can draw the course it will sail.
   * Optional for wire-compat with older snapshots.
   */
  route?: Array<{ x: number; y: number }>;
}

/**
 * A mobile warship this snapshot: belonging to `playerId`, at fractional tile
 * position (`x`,`y`), with its current/max HP for the client's health bar
 * (drawn only while `hp < maxHp`) and whether it's currently retreating home
 * to heal instead of pressing an attack.
 */
export interface RasterWarship {
  warshipId: number;
  playerId: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  retreating: boolean;
  /** Centre of the unit's assigned patrol sector (always water). */
  patrolX?: number;
  patrolY?: number;
  /** Where the unit is currently steering (chase/retreat objective or patrol waypoint). */
  destX?: number;
  destY?: number;
}

/**
 * A warhead in flight this snapshot: launched by `playerId`, currently at
 * (`x`,`y`) en route to (`toX`,`toY`). Sent every snapshot while airborne so
 * the client can draw it travelling toward its target. A MIRV launch appears
 * as several independent entries (one per scattered warhead), each with its
 * own `nukeId`.
 */
export interface RasterNuke {
  nukeId: number;
  playerId: number;
  x: number;
  y: number;
  toX: number;
  toY: number;
  kind: NukeKind;
}

/**
 * A warhead detonation resolved this tick, at (`x`,`y`) — the client flashes
 * an explosion there, same idea as {@link RasterCrossing}'s landing flash.
 */
export interface RasterNukeDetonation {
  playerId: number;
  x: number;
  y: number;
  kind: NukeKind;
}

/**
 * A warhead shot down by a SAM Launcher this tick, at (`x`,`y`) — the client
 * plays a distinct interception flash/sound instead of a full blast.
 */
export interface RasterNukeInterception {
  playerId: number;
  /** Owner of the SAM Launcher that intercepted the warhead. */
  defenderId: number;
  x: number;
  y: number;
}

/**
 * An active land attack this snapshot: `troops` of `playerId` are pushing the
 * front against `targetId` (0 = neutral land), centred on tile (`x`,`y`). The
 * client draws the troop count at this point so it is visible at which border
 * how many troops are fighting — OpenFront's on-map attack readout.
 */
export interface RasterAttackFront {
  playerId: number;
  targetId: number;
  troops: number;
  x: number;
  y: number;
}

/**
 * A structure on the map this snapshot: building `type` belonging to `playerId`
 * standing on tile (`x`,`y`). Sent as a sparse list (only placed buildings) so
 * the client can draw a marker per structure, like capitals and ships.
 */
export interface RasterBuilding {
  playerId: number;
  x: number;
  y: number;
  type: BuildingType;
  /** True while the structure is still being built (its effects aren't active yet). */
  underConstruction: boolean;
  /** Construction progress in [0,1]; 1 once finished. Drives the build-progress bar. */
  buildProgress: number;
  /** Structure level (1 = fresh; upgrades raise it). The client renders digits >1. */
  level: number;
}

/**
 * An auto-routed railroad link this snapshot: a cardinal L-path belonging to
 * `playerId`, given as ordered tile corner points (`[x, y]`). The client strokes
 * straight track between consecutive points. Rails appear once a player builds a
 * factory near a city/port and vanish when the stations are lost.
 */
export interface RasterRail {
  playerId: number;
  points: Array<[number, number]>;
}

/**
 * A train riding the rail network this snapshot: belonging to `playerId` at
 * fractional tile position (`x`,`y`). Trains earn their owner gold at each city
 * or port they reach; the client draws them as small moving dots.
 */
export interface RasterTrain {
  playerId: number;
  x: number;
  y: number;
}

/**
 * A trade ship sailing between two ports this snapshot, belonging to `playerId`
 * at fractional tile position (`x`,`y`). On arrival it pays both ports gold; the
 * client draws it as a small moving dot, like a train but at sea.
 */
export interface RasterTrade {
  playerId: number;
  x: number;
  y: number;
}

/**
 * The phase a raster match is in.
 *  - `spawn`: the opening start phase — every player picks where their nation is
 *    founded and nobody can take territory yet. A countdown runs.
 *  - `playing`: the live game — territory can be captured and combat resolves.
 */
export type RasterMatchPhase = "spawn" | "playing";

/** Snapshot of a raster-mode match. */
export interface RasterSnapshot {
  tick: number;
  mapName: string;
  /**
   * Current match phase. During `spawn` the client shows the start-phase
   * countdown and only allows picking a start position; expansion/build clicks
   * are gated until `playing`.
   */
  phase: RasterMatchPhase;
  /**
   * Whole seconds left in the spawn (start) phase, for the client countdown.
   * Always 0 once {@link phase} is `playing`.
   */
  spawnRemainingSeconds: number;
  /** Grid width in tiles. */
  width: number;
  /** Grid height in tiles. */
  height: number;
  /** Stable hash of the terrain. Same hash = same terrain. */
  terrainHash: string;
  /**
   * Base64-encoded `Uint8Array` of length width*height. Only ever sent on the
   * first snapshot and when terrainHash changes; otherwise omitted to save
   * bandwidth.
   */
  terrainBase64?: string;
  /**
   * Full ownership raster: base64-encoded little-endian `Uint16Array` of length
   * width*height holding the player id owning each tile (0 = NEUTRAL). Sent on
   * the first snapshot (to seed the client) and whenever a delta would be
   * larger than a full resend; otherwise omitted in favour of `ownerDeltaBase64`.
   */
  ownerBase64?: string;
  /**
   * Incremental ownership update relative to the last snapshot this client
   * received. Base64-encoded packed records of 6 bytes each: a little-endian
   * `Uint32` tile index followed by a little-endian `Uint16` new owner. Keeps
   * per-tick bandwidth proportional to the churn at the front rather than to the
   * whole map, which is what makes million-tile maps playable. Exactly one of
   * `ownerBase64` / `ownerDeltaBase64` is present on any snapshot.
   */
  ownerDeltaBase64?: string;
  /**
   * Binary alternatives to `terrainBase64` / `ownerBase64` /
   * `ownerDeltaBase64` / `falloutBase64`, byte-for-byte the same payloads
   * before base64. Never sent on the WebSocket wire (JSON) — they exist for
   * the in-browser worker transports (solo host, lockstep replica), where
   * `postMessage` moves raw buffers with a transfer list for free instead of
   * round-tripping multi-MB rasters through base64 strings on the render
   * thread. When a binary field is present it wins over its base64 twin.
   */
  terrainBytes?: Uint8Array;
  ownerBytes?: Uint8Array;
  ownerDeltaBytes?: Uint8Array;
  falloutBytes?: Uint8Array;
  /** Player standings in deterministic ascending playerId order. */
  players: RasterPlayerInfo[];
  /** Total capturable (passable land) tiles — convenience for victory bars. */
  capturableCount: number;
  /** Winning playerId once the match has ended, else null. */
  winnerPlayerId: number | null;
  /** Most recent gameplay events, newest first. */
  recentEvents: string[];
  /** Transport-ship landings resolved this tick (empty on most ticks). */
  crossings: RasterCrossing[];
  /** Transport ships currently in flight (empty when none are at sea). */
  ships: RasterShip[];
  /** Live mobile warships (empty until one finishes construction). */
  warships: RasterWarship[];
  /** Warheads currently in flight (empty when none are airborne). */
  nukes: RasterNuke[];
  /** Warhead detonations resolved this tick (empty on most ticks). */
  nukeDetonations: RasterNukeDetonation[];
  /** Warheads shot down by a SAM Launcher this tick (empty on most ticks). */
  nukeInterceptions: RasterNukeInterception[];
  /**
   * Base64-packed little-endian `Uint32Array` of tile indices currently under
   * radioactive fallout (nuked ground that recolours and can't be captured
   * until it decays). Omitted when nothing is irradiated; an empty string
   * clears the client's last set. Sent whole each snapshot while any exist —
   * a blast is a few thousand tiles that decay within seconds, so it's bounded.
   */
  falloutBase64?: string;
  /** Structures placed on the map (empty when none have been built). */
  buildings: RasterBuilding[];
  /** Auto-routed railroads (empty until a factory wires up a city/port). */
  rails: RasterRail[];
  /** Trains riding the rail network this snapshot (empty when none are running). */
  trains: RasterTrain[];
  /** Trade ships sailing between ports this snapshot (empty when none are at sea). */
  tradeShips: RasterTrade[];
  /**
   * Active land-attack fronts this tick (empty when nobody is pushing a border).
   * Drives the on-map troop-count labels so contested borders read at a glance.
   */
  fronts: RasterAttackFront[];
  /**
   * Active alliances with their remaining lifetime and renewal votes. Allied
   * nations can't attack each other; the client marks them, shows the pact's
   * countdown and offers break/renew actions.
   */
  alliances: RasterAllianceInfo[];
  /**
   * Pending alliance proposals (directed `from` → `to`). The client filters this
   * for offers addressed to it (to accept/decline) and its own outgoing offers.
   */
  allianceRequests: RasterAllianceRequest[];
  /**
   * Active trade embargoes as directed `[from, to]` pairs — `from` refuses to
   * trade with `to`. The client marks its own embargoes and offers a lift/set
   * toggle. Empty when nobody is embargoing anyone.
   */
  embargoes: RasterEmbargoPair[];
  /**
   * Standing target requests (directed: `from` asks ally `to` to attack
   * `target`). The client surfaces requests addressed to it. Empty when none.
   */
  targetRequests: RasterTargetRequestInfo[];
  /**
   * Transient emoji reactions floating this snapshot — a sender, the tile they
   * float over (the reacted-to player's territory), the emoji, and how long
   * they've been alive. Purely visual; drained a couple of seconds after they
   * are sent. Empty on the vast majority of ticks.
   */
  emojis: RasterEmojiReaction[];
}

/** A directed trade embargo in the snapshot: `from` refuses to trade with `to`. */
export type RasterEmbargoPair = [number, number];

/** A standing target request in the snapshot (directed `from` → ally `to`, against `target`). */
export interface RasterTargetRequestInfo {
  from: number;
  to: number;
  target: number;
}

/** A floating emoji reaction in the snapshot. */
export interface RasterEmojiReaction {
  /** Player who sent the reaction. */
  from: number;
  /** Tile the emoji floats over (world coords). */
  x: number;
  y: number;
  /** Index into the shared emoji set (`RASTER_EMOJIS`). */
  emoji: number;
  /** Ticks the reaction has been alive, for the client's rise-and-fade. */
  age: number;
}

/** Reasons the server can reject a raster expand or build intent. */
export type RasterRejectReason =
  | "INVALID_MESSAGE_FORMAT"
  | "INVALID_TILE"
  | "INVALID_PERCENT"
  | "NO_FRONTIER"
  | "INSUFFICIENT_TROOPS"
  | "TOO_MANY_SHIPS"
  | "MATCH_ENDED"
  /** The clicked tile isn't owned by the builder. */
  | "NOT_BUILDABLE"
  /** A building already stands on the clicked tile. */
  | "TILE_OCCUPIED"
  /** The player can't afford the structure. */
  | "INSUFFICIENT_GOLD"
  /** The requested building type is unknown. */
  | "INVALID_BUILDING"
  /** The targeted tile belongs to a current ally — allies can't be attacked. */
  | "ALLIED"
  /** No owned Missile Silo is off cooldown to launch from. */
  | "NO_SILO_READY";

/**
 * How an expand order routes to its target, mirroring OpenFront's B(oat)/G(round)
 * hotkeys: `"auto"` (default) picks a land push across a shared border or a
 * transport ship otherwise, exactly as before; `"land"` requires a land route
 * and rejects if none exists (even if a sea crossing would reach it); `"sea"`
 * always launches a transport ship, even where a land border also exists —
 * letting a player flank behind a defended frontier instead of grinding
 * through it.
 */
export type RasterExpandMode = "auto" | "land" | "sea";

/** Sent by the client to expand its border toward a clicked tile. */
export interface RasterExpandIntent {
  /** Tile column (0..width-1) the player clicked. */
  targetX: number;
  /** Tile row (0..height-1) the player clicked. */
  targetY: number;
  /** Percentage of the player's pool to commit (1..100). */
  percent: number;
  /** Forces a land or sea route instead of the default automatic choice. */
  mode?: RasterExpandMode;
}

/** Sent by the client to build a structure on a tile it owns. */
export interface RasterBuildIntent {
  /** Tile column (0..width-1) to build on. */
  targetX: number;
  /** Tile row (0..height-1) to build on. */
  targetY: number;
  /** Which structure to build. */
  building: BuildingType;
}

/** Sent by the client to launch a warhead from a ready Missile Silo. */
export interface RasterNukeIntent {
  /** Tile column (0..width-1) of the target. */
  targetX: number;
  /** Tile row (0..height-1) of the target. */
  targetY: number;
  /** Which warhead to launch. Defaults to `"atom"` when omitted. */
  kind?: NukeKind;
}

export interface RasterActionRejectedEvent {
  reason: RasterRejectReason;
  message: string;
  /** The intent that was rejected — an expand/sea click, build, or nuke request. */
  intent: RasterExpandIntent | RasterBuildIntent | RasterNukeIntent;
}

/** Assignment payload for raster mode. */
export interface RasterPlayerAssignedPayload {
  playerId: number;
  name: string;
  color: string;
}

/** Why a match ended. */
export type RasterMatchEndReason =
  /** A single player came to own every capturable tile. */
  | "conquest"
  /** The match clock ran out; the territory leader is declared the winner. */
  | "timeLimit";

/**
 * End-of-run statistics for a single player, shown on the post-match screen.
 * Built per-recipient so each client sees its own run.
 */
export interface RasterRunStats {
  playerId: number;
  /** Most tiles this player ever held during the match. */
  peakTiles: number;
  /** Tiles held at the final tick. */
  finalTiles: number;
  /** Opponents this player eliminated by capturing all their territory. */
  kills: number;
  /** Ticks the player survived (until eliminated, else the full match). */
  survivedTicks: number;
  /** True if this player was wiped off the map before the match ended. */
  eliminated: boolean;
  /** True if this player is the declared winner. */
  won: boolean;
}

/** Payload broadcast when a raster match ends. */
export interface RasterMatchEndedPayload {
  /** Declared winner, or null if no player held any territory. */
  winnerPlayerId: number | null;
  reason: RasterMatchEndReason;
  /** Total ticks the match ran. */
  durationTicks: number;
  /** Simulation tick rate, so the client can convert ticks to seconds. */
  tickRate: number;
  /** The receiving player's own run statistics. */
  stats: RasterRunStats;
}

/** Messages the client can send to the server. */
export type RasterClientMessage =
  | { type: "CLIENT_RASTER_EXPAND"; payload: RasterExpandIntent }
  | { type: "CLIENT_RASTER_BUILD"; payload: RasterBuildIntent }
  | { type: "CLIENT_RASTER_NUKE"; payload: RasterNukeIntent }
  | RasterJoinClientMessage
  | RasterSpawnClientMessage
  | RasterAllyProposeClientMessage
  | RasterAllyRespondClientMessage
  | RasterAllyBreakClientMessage
  | RasterAllyRenewClientMessage
  | RasterRetreatClientMessage
  | RasterDeleteClientMessage
  | RasterDonateClientMessage
  | RasterEmbargoClientMessage
  | RasterTargetRequestClientMessage
  | RasterEmojiClientMessage
  | RasterLobbyCreateClientMessage
  | RasterLobbyJoinClientMessage
  | RasterLobbyStartClientMessage
  | RasterLobbyLeaveClientMessage
  | RasterResumeClientMessage;

/** Messages the server can send to the client. */
export type RasterServerMessage =
  | { type: "SERVER_RASTER_LOBBY_WAITING" }
  | { type: "SERVER_RASTER_PLAYER_ASSIGNED"; payload: RasterPlayerAssignedPayload }
  | { type: "SERVER_RASTER_SNAPSHOT"; payload: RasterSnapshot }
  | { type: "SERVER_RASTER_ACTION_REJECTED"; payload: RasterActionRejectedEvent }
  | { type: "SERVER_RASTER_MATCH_ENDED"; payload: RasterMatchEndedPayload }
  | RasterLockstepStartServerMessage
  | RasterTurnServerMessage
  | RasterTurnBacklogServerMessage
  | RasterDesyncServerMessage
  | RasterLobbyStateServerMessage
  | RasterLobbyErrorServerMessage;
