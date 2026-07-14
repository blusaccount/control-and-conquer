import type { TileRef } from "./GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import { NO_ALLIANCES, type AllianceView } from "./alliances.js";
import {
  FORT_SHELL_DAMAGE,
  FORT_SHELL_RANGE,
  FORT_SHELL_RATE_TICKS,
  FORT_SPEED_BONUS,
  GOLD_BASE_PER_TICK,
  WARSHIP_CAPTURE_CONTACT_RANGE,
  WARSHIP_ENGAGE_RANGE,
  WARSHIP_MAX_HP,
  WARSHIP_PATROL_WANDER_RADIUS,
  WARSHIP_TRADE_CHASE_SPEED,
  WARSHIP_PASSIVE_HEAL_PER_TICK,
  WARSHIP_RETREAT_HP,
  WARSHIP_RETREAT_RECOVER_HP,
  WARSHIP_SHELL_DAMAGE,
  WARSHIP_SHELL_RATE_TICKS,
  WARSHIP_TARGET_RANGE,
  WARSHIP_TILES_PER_TICK,
} from "./buildings.js";
import {
  MIRV_MAX_WARHEADS,
  MIRV_MIN_SPACING,
  NUKE_TILES_PER_TICK,
  nukeBlast,
  SAM_INTERCEPT_CHANCE,
  SAM_RANGE,
  SAM_RELOAD_TICKS,
  type NukeKind,
} from "./nukes.js";
import { Prng } from "./prng.js";
import { RailSystem, type RailView, type TrainView } from "./railSystem.js";
import { TradeSystem, type TradeShipTarget, type TradeView } from "./tradeSystem.js";
import {
  ATTACK_RNG_SEED,
  attackerLossPerTile,
  attackTilesPerTick,
  BORDER_JITTER_STEPS,
  CLICK_SNAP_RADIUS,
  DEAD_DEFENDER_MAX_TILES,
  defenderLossPerTile,
  defenderStrengthFactor,
  enemySpeedCost,
  falloutCombatModifier,
  FRONTIER_JITTER_BASE,
  FRONTIER_JITTER_STEPS,
  FRONTIER_SURROUND_WEIGHT,
  neutralSpeedCost,
  terrainPriorityWeight,
  largeAttackerLossFactor,
  largeAttackerSpeedFactor,
  largeDefenderLossFactor,
  maxTroops,
  troopGrowth,
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  neutralLossPerTile,
  RETREAT_MALUS_FRACTION,
  SHIP_TILES_PER_TICK,
  terrainCombat,
  TRAITOR_DEFENSE_DEBUFF,
  TRAITOR_DURATION_TICKS,
  TRAITOR_SPEED_DEBUFF,
  WIN_TILE_FRACTION,
} from "./rasterCombatConfig.js";

/**
 * A request to expand from `attacker`'s territory into `target`'s tiles.
 * Like OpenFront, an attack is undirected: it presses the *whole* shared
 * frontier with the target, ordered purely by the capture-priority key — the
 * click only picks whose land is attacked, never which flank advances first.
 */
export interface AttackIntent {
  attacker: PlayerId;
  /** Player whose tiles are targeted, or {@link NEUTRAL_PLAYER} for free land. */
  target: PlayerId;
  /** Troops to commit from the attacker's pool. Positive integer. */
  troops: number;
}

/**
 * A request to send a transport ship across water to land on (and capture) a
 * specific tile. Unlike an {@link AttackIntent} this targets one destination
 * rather than a whole player's frontier — the ship sails the shortest water
 * route to `dest` and disembarks there.
 */
export interface SeaAttackIntent {
  attacker: PlayerId;
  /** The capturable tile the ship sails to and lands on. */
  dest: TileRef;
  /** Troops loaded onto the ship from the attacker's pool. Positive integer. */
  troops: number;
}

export type AttackRejectReason =
  | "UNKNOWN_PLAYER"
  | "INVALID_TARGET"
  | "INVALID_TROOP_COUNT"
  | "INSUFFICIENT_TROOPS"
  | "NO_FRONTIER"
  | "TOO_MANY_SHIPS"
  /** The target is a current ally — allied players can't attack each other. */
  | "ALLIED"
  /** The target is under post-spawn immunity and can't be attacked yet. */
  | "IMMUNE";

/**
 * A single amphibious landing resolved this tick: a player captured tile `to`
 * by crossing water from its coastal tile `from`. Surfaced so the client can
 * flash the moment a transport ship disembarks.
 */
export interface SeaCrossing {
  attacker: PlayerId;
  from: TileRef;
  to: TileRef;
}

/** Public view of one transport ship in flight, for snapshotting/animation. */
export interface TransportShipState {
  id: number;
  attacker: PlayerId;
  /** The tile the ship currently occupies along its route. */
  tile: TileRef;
  /** Troops aboard. */
  troops: number;
  /**
   * The rest of the ship's water route (exclusive of `tile`, ending on the
   * landing tile), downsampled to a handful of waypoints so the client can
   * draw the course line without shipping every tile of a long crossing.
   */
  route: TileRef[];
}

/** Cap on the waypoint count of a serialized ship route — keeps snapshots small on long crossings. */
const SHIP_ROUTE_MAX_WAYPOINTS = 32;

/**
 * Thin the remaining route — from `path[progress]` (exclusive) to the landing
 * tile — to at most {@link SHIP_ROUTE_MAX_WAYPOINTS} evenly strided waypoints,
 * always ending on the landing tile. The client only needs enough points to
 * trace a readable course line, not every tile of the crossing.
 */
const downsampleRoute = (path: readonly TileRef[], progress: number): TileRef[] => {
  const last = path.length - 1;
  const remaining = last - progress;
  if (remaining <= 0) return [];
  const stride = Math.max(1, Math.ceil(remaining / SHIP_ROUTE_MAX_WAYPOINTS));
  const route: TileRef[] = [];
  for (let i = progress + stride; i < last; i += stride) route.push(path[i]);
  route.push(path[last]);
  return route;
};

/** Public view of one nuke in flight, for snapshotting/animation. */
export interface NukeState {
  id: number;
  attacker: PlayerId;
  /** Current interpolated tile-space position along the flight. */
  x: number;
  y: number;
  toX: number;
  toY: number;
  kind: NukeKind;
}

/**
 * One nuke's detonation, resolved this tick — surfaced so the session can react
 * (event log line, and severing any alliance with a hit victim, breaking the
 * attacker's own non-aggression pact via a nuke rather than the diplomacy menu).
 */
export interface NukeDetonation {
  attacker: PlayerId;
  targetX: number;
  targetY: number;
  kind: NukeKind;
  /** Every player who lost territory in the blast (excluding neutral land). */
  victims: PlayerId[];
}

/**
 * A warhead shot down by a SAM Launcher before it could detonate — surfaced so
 * the session can react (event log line, distinct client sound/flash from a
 * real detonation).
 */
export interface NukeInterception {
  attacker: PlayerId;
  /** Owner of the SAM Launcher that shot the warhead down. */
  defender: PlayerId;
  /** Tile-space position the interception happened at. */
  x: number;
  y: number;
}

/** What kind of vessel a warship is currently engaging. */
export type WarshipTargetKind = "transport" | "warship" | "trade";

/**
 * Public view of one mobile warship, for snapshotting/animation. `retreating`
 * drives the client's "fleeing home" visual cue; a health bar only makes
 * sense to draw once `hp < maxHp`.
 */
export interface WarshipState {
  id: number;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  retreating: boolean;
  /** Centre of the assigned patrol sector (always water). */
  patrolX: number;
  patrolY: number;
  /**
   * Where the ship is currently steering: its chase/retreat objective while
   * engaged or fleeing, else the patrol wander waypoint. Lets the client
   * draw the unit's course instead of an unexplained drift.
   */
  destX: number;
  destY: number;
}

/**
 * Public view of one active land attack as a *front*: who is pushing whom, how
 * many troops are still committed to the fight, and a representative frontier
 * tile to anchor an on-map readout. Surfaced so the client can label each
 * contested border with the attacking troop count — OpenFront's "you can see at
 * which border how many troops are fighting" feel.
 */
export interface AttackFrontState {
  attacker: PlayerId;
  /** Player being pushed back, or {@link NEUTRAL_PLAYER} for a neutral grab. */
  target: PlayerId;
  /** Troops still committed to (fighting on) this front. */
  troops: number;
  /** A frontier tile near the centre of the contested border, for the label. */
  tile: TileRef;
}

export interface RasterTickResult {
  tick: number;
  /** Set once a player holds {@link WIN_TILE_FRACTION} of the capturable land, else null. */
  winner: PlayerId | null;
  rejections: Array<{ intent: AttackIntent; reason: AttackRejectReason }>;
  /** Number of attacks still in progress after this tick. */
  activeAttacks: number;
  /** Transport-ship landings that happened this tick (empty on most ticks). */
  crossings: SeaCrossing[];
  /** Nukes that detonated this tick (empty on most ticks). */
  nukeDetonations: NukeDetonation[];
  /** Warheads shot down by a SAM Launcher this tick (empty on most ticks). */
  nukeInterceptions: NukeInterception[];
  /**
   * Ships lost to enemy action this tick: a trade ship captured by a rival
   * warship or a transport shelled out of the water. Feeds the nation AI's
   * naval retaliation (OpenFront's `trackShipsAndRetaliate`), which is why
   * the *culprit* is attributed.
   */
  shipLosses: ShipLoss[];
}

/** One ship lost to enemy action: whose, to whom, what kind, and where. */
export interface ShipLoss {
  victim: PlayerId;
  by: PlayerId;
  kind: "trade" | "transport";
  x: number;
  y: number;
}

/**
 * One tile's enqueue record on an attack's frontier: the tick it first joined
 * (OpenFront's `+ tick` priority term) and the jitter rolled for it at that
 * moment (OpenFront's `nextInt(0, 7)` — one roll per enqueue, never re-rolled).
 */
interface FrontierEntry {
  tick: number;
  jitter: number;
}

/** An in-flight expansion. `committed` troops are drained as tiles are taken. */
interface RasterAttack {
  attacker: PlayerId;
  target: PlayerId;
  committed: number;
  /**
   * A representative tile on this attack's current land frontier, refreshed each
   * tick in {@link RasterConflict.advanceAttacks}. Anchors the on-map troop
   * label. `-1` until the attack has been advanced at least once.
   */
  anchor: TileRef;
  /**
   * This attack's own random stream, exactly OpenFront's model: every
   * `AttackExecution` owns a `PseudoRandom` seeded with the same fixed
   * constant ({@link ATTACK_RNG_SEED}), drawn sequentially for the frontier
   * tile jitter and the per-tick border jitter. Seeded deterministically, so
   * replays stay identical.
   */
  rng: Prng;
  /**
   * Per-tile enqueue records ({@link FrontierEntry}) for ground this front has
   * touched. Grows with the frontier and dies with the attack.
   */
  seen: Map<TileRef, FrontierEntry>;
}

/** A transport ship en route to its landing tile. */
interface TransportShip {
  id: number;
  attacker: PlayerId;
  /** Troops aboard, disembarked on arrival. */
  troops: number;
  /** Land→water…→land route: [embarkation coast, …open water…, dest]. */
  path: TileRef[];
  /** Index into `path` of the ship's current position. */
  progress: number;
}

/**
 * A live warship unit — bought via the build menu against a **water** target
 * (its patrol sector), spawned at the owner's nearest port, sunk when its HP
 * runs out. It exists independently of any structure (OpenFront's model).
 * `x`/`y` are fractional tile-space, so movement eases smoothly.
 */
interface Warship {
  id: number;
  owner: PlayerId;
  /** Centre of the assigned patrol sector — the water the build order targeted. */
  patrolX: number;
  patrolY: number;
  /** Current wander waypoint inside the patrol sector. */
  wanderX: number;
  wanderY: number;
  x: number;
  y: number;
  /** Where the unit is currently steering (chase/retreat objective or wander waypoint), for the client's course line. */
  destX: number;
  destY: number;
  hp: number;
  target: { kind: WarshipTargetKind; id: number } | null;
  /** True once hp has dropped below the retreat threshold, until it heals back past the recovery one. */
  retreating: boolean;
  /** Tick (exclusive) this warship's guns are next ready to fire. */
  shellReadyAt: number;
  /** The unit's own random stream, driving its patrol wander deterministically. */
  rng: Prng;
}

/** Why a warship purchase was refused. */
export type WarshipRejectReason =
  /** The buyer runs no active port — the wiki requires one to launch from. */
  | "NO_PORT"
  /** No water near the click to patrol. */
  | "INVALID_TARGET";

/** A nuke in flight: a straight-line, constant-speed trip from silo to target. */
interface Nuke {
  id: number;
  attacker: PlayerId;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  ticksTotal: number;
  ticksElapsed: number;
  kind: NukeKind;
}

/**
 * Autonomous border-expansion conflict engine over a {@link TerritoryGrid}.
 *
 * Each tick: players earn income proportional to territory size, then every
 * active attack spends a slice of its committed troops to capture tiles along
 * the attacker's border — processed one BFS "ring" per tick so fronts grow
 * organically rather than teleporting. Higher ground and enemy-held tiles cost
 * more troops to take. A player who comes to own every capturable tile wins.
 *
 * Combat is autonomous: callers only express *intent* (commit N troops toward a
 * target); the engine resolves the actual frontier advance deterministically.
 */
export class RasterConflict {
  private readonly grid: TerritoryGrid;
  /** Shared 4-slot scratch for allocation-free neighbour walks in hot loops. */
  private readonly scratchNeighbors = new Int32Array(4);
  /**
   * Diplomacy lookup consulted before any attack lands: allied players can't
   * take each other's tiles. Defaults to {@link NO_ALLIANCES} (nobody allied),
   * so callers and tests that don't care about diplomacy are unaffected.
   */
  private readonly allies: AllianceView;
  private readonly attacks: RasterAttack[] = [];
  /** Transport ships currently at sea, in launch order. */
  private readonly ships: TransportShip[] = [];
  /** Monotonic id source so each ship has a stable handle for the client. */
  private nextShipId = 1;
  /** Nukes currently in flight, in launch order. */
  private readonly nukes: Nuke[] = [];
  /** Monotonic id source so each nuke has a stable handle for the client. */
  private nextNukeId = 1;
  /** Detonations resolved during the current tick. */
  private nukeDetonations: NukeDetonation[] = [];
  /** Interceptions resolved during the current tick. */
  private nukeInterceptions: NukeInterception[] = [];
  /** Tick (exclusive) each SAM Launcher, keyed by tile, is ready to fire again. */
  private readonly samCooldownUntil = new Map<TileRef, number>();
  /** Tick (exclusive) each fort's gun, keyed by tile, is ready to fire again. */
  private readonly fortShellReadyAt = new Map<TileRef, number>();
  /**
   * Each SAM Launcher's own random stream for its intercept rolls, seeded with
   * its tile — OpenFront's SAMLauncherExecution seeds a per-launcher
   * `PseudoRandom(sam.id())` the same way. Lazily created on first shot.
   */
  private readonly samRng = new Map<TileRef, Prng>();
  /**
   * Most recent attacker of each player (land or sea), for the client's
   * "retaliate" hotkey. Public information — combat is already visible on the
   * map via {@link activeFronts}/{@link SeaCrossing} — so no access control.
   */
  private readonly lastAttackedBy = new Map<PlayerId, PlayerId>();
  private readonly incomeAccumulator = new Map<PlayerId, number>();
  /**
   * Tick (exclusive) until which a freshly-seated player is immune from attack.
   * Set by {@link grantImmunity} when the session seats a player; checked before
   * any land or sea assault lands on them. Absent = never immune.
   */
  private readonly immuneUntil = new Map<PlayerId, number>();
  /**
   * Tick (exclusive) until which a player is a **traitor** for betraying an
   * alliance. Set by {@link markTraitor} when the session records a betrayal;
   * while active the player is debuffed in combat (see {@link isTraitor}).
   */
  private readonly traitorUntil = new Map<PlayerId, number>();
  /** Auto-routed railroads + the trains that ride them, paying out gold. */
  private readonly rails: RailSystem;
  /** Port-to-port trade ships, paying both ends gold per completed trip. */
  private readonly trade: TradeSystem;
  /** Live mobile warship units (bought via {@link launchWarship}). */
  private readonly warships: Warship[] = [];
  /** Monotonic id source so each warship has a stable handle for the client. */
  private nextWarshipId = 1;
  /** Transport-ship landings resolved during the current tick. */
  private crossings: SeaCrossing[] = [];
  /** Ships lost to enemy action this tick (see {@link ShipLoss}); reset each tick. */
  private shipLosses: ShipLoss[] = [];
  private tickCount = 0;
  private winnerId: PlayerId | null = null;

  constructor(grid: TerritoryGrid, allies: AllianceView = NO_ALLIANCES) {
    this.grid = grid;
    this.allies = allies;
    // The rail economy consults diplomacy for the payout tiers (ally 35k vs
    // other 25k) and to mute payouts at an embargoed player's stations.
    this.rails = new RailSystem(
      grid,
      (a, b) => this.allies.areAllied(a, b),
      (a, b) => this.allies.isEmbargoed?.(a, b) ?? false,
    );
    // The trade system consults the (deferred) diplomacy view so an embargoed
    // pair never dispatches trade ships to each other.
    this.trade = new TradeSystem(grid, (a, b) => this.allies.isEmbargoed?.(a, b) ?? false);
    // Razed SAMs/forts take their timers and RNG streams with them: without
    // this, the per-tile maps grow for the whole match and a *rebuilt*
    // launcher on the same tile starts life mid-cooldown on the dead one's
    // random stream.
    grid.setBuildingDestroyedListener((ref) => {
      this.samCooldownUntil.delete(ref);
      this.fortShellReadyAt.delete(ref);
      this.samRng.delete(ref);
    });
  }

  /** Live trade ships, for the snapshot (empty until two ports share a sea). */
  tradeShips(): TradeView[] {
    return this.trade.tradeViews();
  }

  /** Current railroad links, for the snapshot (empty until a factory wires up). */
  railLinks(): RailView[] {
    return this.rails.railViews();
  }

  /** Trains currently riding the network, for the snapshot. */
  activeTrains(): TrainView[] {
    return this.rails.trainViews();
  }

  /** Live mobile warships, for the snapshot (empty until someone buys one). */
  activeWarships(): WarshipState[] {
    return this.warships.map((w) => ({
      id: w.id,
      owner: w.owner,
      x: w.x,
      y: w.y,
      hp: Math.max(0, Math.round(w.hp)),
      maxHp: WARSHIP_MAX_HP,
      retreating: w.retreating,
      patrolX: w.patrolX,
      patrolY: w.patrolY,
      destX: w.destX,
      destY: w.destY,
    }));
  }

  get tick(): number {
    return this.tickCount;
  }

  get winner(): PlayerId | null {
    return this.winnerId;
  }

  get activeAttackCount(): number {
    return this.attacks.length;
  }

  /** Transport ships `attacker` currently has at sea. */
  shipCountOf(attacker: PlayerId): number {
    let count = 0;
    for (const ship of this.ships) if (ship.attacker === attacker) count += 1;
    return count;
  }

  /** Snapshot of every transport ship in flight, for serialization/animation. */
  activeShips(): TransportShipState[] {
    return this.ships.map((s) => ({
      id: s.id,
      attacker: s.attacker,
      tile: s.path[s.progress],
      troops: s.troops,
      route: downsampleRoute(s.path, s.progress),
    }));
  }

  /**
   * Transports in flight as (id, owner, position, destination) — the nation
   * AI's incoming-landing scan (OpenFront's `trackIncomingTransports`), which
   * needs the *destination* tile the snapshot route does not carry in full.
   */
  transportTargets(): Array<{ id: number; attacker: PlayerId; tile: TileRef; dest: TileRef }> {
    return this.ships.map((s) => ({
      id: s.id,
      attacker: s.attacker,
      tile: s.path[s.progress],
      dest: s.path[s.path.length - 1],
    }));
  }

  /** Live nukes in flight, interpolated to their current position, for the snapshot. */
  activeNukes(): NukeState[] {
    return this.nukes.map((n) => {
      const t = n.ticksElapsed / n.ticksTotal;
      return {
        id: n.id,
        attacker: n.attacker,
        x: n.fromX + (n.toX - n.fromX) * t,
        y: n.fromY + (n.toY - n.fromY) * t,
        toX: n.toX,
        toY: n.toY,
        kind: n.kind,
      };
    });
  }

  /**
   * Snapshot of every active land attack as a front, for the client's on-map
   * troop-count labels. Each carries the attacker, the player being pushed back
   * (or neutral), the troops still committed, and a representative frontier tile
   * (refreshed each tick in {@link advanceAttacks}). Attacks not yet advanced —
   * with no anchor — are skipped; there is nothing meaningful to place yet.
   */
  activeFronts(): AttackFrontState[] {
    const fronts: AttackFrontState[] = [];
    for (const attack of this.attacks) {
      if (attack.anchor < 0) continue;
      fronts.push({
        attacker: attack.attacker,
        target: attack.target,
        troops: Math.floor(attack.committed),
        tile: attack.anchor,
      });
    }
    return fronts;
  }

  /**
   * Validate and register an attack intent. On success the committed troops
   * leave the attacker's pool immediately (preventing double-spend) and either
   * start a new attack or reinforce an existing attacker→target one. Returns a
   * reject reason without mutating state on failure.
   */
  /**
   * Protect `player` from attack until `ticks` ticks from now — the post-spawn
   * immunity window. Called by the session when it seats a player. A later grant
   * (e.g. a relocated spawn) extends the window.
   */
  grantImmunity(player: PlayerId, ticks: number): void {
    if (ticks <= 0) return;
    this.immuneUntil.set(player, this.tickCount + ticks);
  }

  /** Whether `player` is currently under post-spawn immunity. Neutral never is. */
  isImmune(player: PlayerId): boolean {
    if (player === NEUTRAL_PLAYER) return false;
    return (this.immuneUntil.get(player) ?? 0) > this.tickCount;
  }

  /**
   * Mark `player` a **traitor** for betraying an alliance — the session calls this
   * when a player breaks a pact. Starts (or refreshes) the {@link TRAITOR_DURATION_TICKS}
   * window during which the traitor is punished in combat.
   */
  markTraitor(player: PlayerId): void {
    if (player === NEUTRAL_PLAYER) return;
    this.traitorUntil.set(player, this.tickCount + TRAITOR_DURATION_TICKS);
  }

  /** Whether `player` is currently a marked traitor. Neutral never is. */
  isTraitor(player: PlayerId): boolean {
    if (player === NEUTRAL_PLAYER) return false;
    return (this.traitorUntil.get(player) ?? 0) > this.tickCount;
  }

  /**
   * Active land attacks currently pressing `defender`: each front's attacker
   * and its remaining committed troops. Drives the AI's retaliation pick
   * (largest incoming attack), the "victim" pile-on check and the reactive
   * defense-post trigger — the same reads OpenFront's `incomingAttacks()` serves.
   */
  incomingAttacksOf(defender: PlayerId): Array<{ attacker: PlayerId; troops: number }> {
    const out: Array<{ attacker: PlayerId; troops: number }> = [];
    for (const a of this.attacks) {
      if (a.target === defender) out.push({ attacker: a.attacker, troops: a.committed });
    }
    return out;
  }

  /** Troops `attacker` currently has committed across all outgoing land fronts. */
  outgoingAttackTroopsOf(attacker: PlayerId): number {
    let sum = 0;
    for (const a of this.attacks) if (a.attacker === attacker) sum += a.committed;
    return sum;
  }

  launchAttack(intent: AttackIntent): AttackRejectReason | null {
    const { attacker, target, troops } = intent;

    if (!this.grid.hasPlayer(attacker)) return "UNKNOWN_PLAYER";
    if (target === attacker) return "INVALID_TARGET";
    if (target !== NEUTRAL_PLAYER && !this.grid.hasPlayer(target)) return "INVALID_TARGET";
    // A freshly-seated nation can't be attacked while its spawn immunity holds.
    if (this.isImmune(target)) return "IMMUNE";
    // A standing alliance is a non-aggression pact: you can't push a front into
    // an ally's land. Breaking the alliance first reopens the option.
    if (target !== NEUTRAL_PLAYER && this.allies.areAllied(attacker, target)) return "ALLIED";
    if (!Number.isInteger(troops) || troops <= 0) return "INVALID_TROOP_COUNT";
    if (troops > this.grid.troopsOf(attacker)) return "INSUFFICIENT_TROOPS";
    // A land attack pushes a contiguous front; it never crosses water (that is
    // the transport ship's job), so it requires a shared land border.
    if (!this.grid.hasLandBorderWith(attacker, target)) return "NO_FRONTIER";

    this.grid.addTroops(attacker, -troops);
    let committed = troops;

    // Opposing attacks annihilate at launch, mirroring OpenFront's init: if the
    // target is already pushing a front INTO us, the two committed forces are
    // netted against each other man for man. The larger force survives with the
    // difference; the smaller one is wiped out entirely (both sides' troops were
    // already paid out of their pools, so the netted losses are real).
    if (target !== NEUTRAL_PLAYER) {
      const idx = this.attacks.findIndex((a) => a.attacker === target && a.target === attacker);
      if (idx !== -1) {
        const incoming = this.attacks[idx];
        if (incoming.committed > committed) {
          incoming.committed -= committed;
          this.lastAttackedBy.set(target, attacker);
          return null;
        }
        committed -= incoming.committed;
        this.attacks.splice(idx, 1);
        if (committed < 1) {
          this.lastAttackedBy.set(target, attacker);
          return null;
        }
      }
    }

    const existing = this.attacks.find((a) => a.attacker === attacker && a.target === target);
    if (existing) {
      existing.committed += committed;
    } else {
      this.attacks.push({
        attacker,
        target,
        committed,
        anchor: -1,
        rng: new Prng(ATTACK_RNG_SEED),
        seen: new Map(),
      });
    }
    if (target !== NEUTRAL_PLAYER) this.lastAttackedBy.set(target, attacker);
    return null;
  }

  /**
   * Manually pull an active attack back — OpenFront's ordered retreat (the
   * white-flag button on an outgoing attack). The front is dissolved and its
   * committed troops return home, taxed {@link RETREAT_MALUS_FRACTION} when
   * pulling off a *player* (OpenFront's `malusForRetreat`); retreating from
   * neutral land is free. Returns the troops refunded, or `null` if `attacker`
   * has no active attack against `target`.
   */
  orderRetreat(attacker: PlayerId, target: PlayerId): number | null {
    const idx = this.attacks.findIndex((a) => a.attacker === attacker && a.target === target);
    if (idx === -1) return null;
    const [attack] = this.attacks.splice(idx, 1);
    const kept = target === NEUTRAL_PLAYER
      ? attack.committed
      : attack.committed * (1 - RETREAT_MALUS_FRACTION);
    this.grid.addTroops(attacker, kept);
    return kept;
  }

  /**
   * Validate and dispatch one transport ship toward `dest`. On success the
   * loaded troops leave the attacker's pool immediately and the ship begins
   * sailing the shortest water route next tick. A player may have at most
   * {@link MAX_TRANSPORT_SHIPS_PER_PLAYER} ships at sea; further launches are
   * rejected. Returns a reject reason without mutating state on failure.
   */
  launchShip(intent: SeaAttackIntent): AttackRejectReason | null {
    const { attacker, dest, troops } = intent;

    if (!this.grid.hasPlayer(attacker)) return "UNKNOWN_PLAYER";
    if (!this.grid.isCapturable(dest) || this.grid.ownerOf(dest) === attacker) return "INVALID_TARGET";
    // You can't storm a shore held by a nation still under spawn immunity.
    if (this.isImmune(this.grid.ownerOf(dest))) return "IMMUNE";
    // You can't make an amphibious assault on an ally's shore either.
    const destOwner = this.grid.ownerOf(dest);
    if (destOwner !== NEUTRAL_PLAYER && this.allies.areAllied(attacker, destOwner)) return "ALLIED";
    if (!Number.isInteger(troops) || troops <= 0) return "INVALID_TROOP_COUNT";
    if (troops > this.grid.troopsOf(attacker)) return "INSUFFICIENT_TROOPS";
    if (this.shipCountOf(attacker) >= this.grid.maxShipsOf(attacker)) return "TOO_MANY_SHIPS";

    const path = this.grid.findSeaPath(attacker, dest);
    if (!path) return "NO_FRONTIER";

    this.grid.addTroops(attacker, -troops);
    this.ships.push({ id: this.nextShipId++, attacker, troops, path, progress: 0 });
    if (destOwner !== NEUTRAL_PLAYER) this.lastAttackedBy.set(destOwner, attacker);
    return null;
  }

  /** Player id who most recently attacked `player` (land or sea), or `null` if nobody has. */
  lastAttackerOf(player: PlayerId): PlayerId | null {
    return this.lastAttackedBy.get(player) ?? null;
  }

  /**
   * Launch a warhead of `kind` from `(fromX, fromY)` — a silo tile the caller
   * has already confirmed `attacker` owns and is off cooldown — toward
   * `(targetX, targetY)`. Gold and silo-selection are the session's concern
   * (mirroring building purchases); this only enqueues the flight(s).
   *
   * A **MIRV** is a saturation strike on a *player*, not a point: the aim
   * tile's owner is the victim, and up to {@link MIRV_MAX_WARHEADS} warheads
   * blanket that player's territory, landing points at least
   * {@link MIRV_MIN_SPACING} Manhattan tiles apart (the public wiki's
   * documented behaviour). Each warhead flies its own straight-line course and
   * is SAM-interceptable separately. An aim tile with no player owner degrades
   * to a single warhead at the point. Every other kind is a single flight.
   * Combat effects (troop loss, territory clearing) land on impact in
   * {@link detonateNuke}.
   */
  launchNuke(
    attacker: PlayerId,
    fromX: number,
    fromY: number,
    targetX: number,
    targetY: number,
    kind: NukeKind = "atom",
  ): void {
    if (kind === "mirv") {
      const map = this.grid.map;
      const tx = Math.max(0, Math.min(map.width - 1, Math.round(targetX)));
      const ty = Math.max(0, Math.min(map.height - 1, Math.round(targetY)));
      const aimRef = map.ref(tx, ty);
      const victim = this.grid.isCapturable(aimRef) ? this.grid.ownerOf(aimRef) : NEUTRAL_PLAYER;
      if (victim !== NEUTRAL_PLAYER) {
        for (const ref of this.mirvLandingPoints(victim)) {
          this.enqueueNuke(this.nextNukeId++, attacker, fromX, fromY, map.x(ref), map.y(ref), "mirv");
        }
        return;
      }
      // No player under the aim point: a lone warhead lands where clicked.
      this.enqueueNuke(this.nextNukeId++, attacker, fromX, fromY, targetX, targetY, "mirv");
      return;
    }
    this.enqueueNuke(this.nextNukeId++, attacker, fromX, fromY, targetX, targetY, kind);
  }

  /**
   * The landing points of a MIRV strike on `victim`: a spatially-thinned
   * sample of the victim's territory — greedy over the player's tiles in
   * insertion order (deterministic), accepting each tile at least
   * {@link MIRV_MIN_SPACING} Manhattan tiles from every already-accepted one,
   * up to {@link MIRV_MAX_WARHEADS}. A coarse bucket grid (cell =
   * {@link MIRV_MIN_SPACING}) keeps the spacing check O(1) per tile: any
   * accepted point closer than the spacing lies within one cell in each axis.
   */
  private mirvLandingPoints(victim: PlayerId): TileRef[] {
    const map = this.grid.map;
    const cell = MIRV_MIN_SPACING;
    const cols = Math.ceil(map.width / cell) + 2;
    const buckets = new Map<number, TileRef[]>();
    const accepted: TileRef[] = [];
    for (const ref of this.grid.tilesOf(victim)) {
      if (accepted.length >= MIRV_MAX_WARHEADS) break;
      const x = map.x(ref);
      const y = map.y(ref);
      const bx = Math.floor(x / cell);
      const by = Math.floor(y / cell);
      let clear = true;
      for (let dy = -1; dy <= 1 && clear; dy += 1) {
        for (let dx = -1; dx <= 1 && clear; dx += 1) {
          const near = buckets.get((by + dy) * cols + (bx + dx));
          if (!near) continue;
          for (const a of near) {
            if (Math.abs(map.x(a) - x) + Math.abs(map.y(a) - y) < MIRV_MIN_SPACING) {
              clear = false;
              break;
            }
          }
        }
      }
      if (!clear) continue;
      accepted.push(ref);
      const key = by * cols + bx;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(ref);
      else buckets.set(key, [ref]);
    }
    return accepted;
  }

  /** Enqueue a single warhead flight (shared by {@link launchNuke}'s single- and multi-warhead paths). */
  private enqueueNuke(
    id: number,
    attacker: PlayerId,
    fromX: number,
    fromY: number,
    targetX: number,
    targetY: number,
    kind: NukeKind,
  ): void {
    const dx = targetX - fromX;
    const dy = targetY - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ticksTotal = Math.max(1, Math.round(dist / NUKE_TILES_PER_TICK));
    this.nukes.push({ id, attacker, fromX, fromY, toX: targetX, toY: targetY, ticksTotal, ticksElapsed: 0, kind });
  }

  /**
   * Resolve one warhead's impact: clear tiles in its blast (fully inside the
   * kind's inner radius, a per-tile deterministic chance out to its outer
   * radius, see {@link nukeBlast}) back to neutral — razing any building — and
   * bleed each affected owner's troop pool by the fraction of *their* territory
   * just destroyed, mirroring OpenFront's "troops lost proportional to land
   * taken". A blast can span more than one nation; each is debited independently.
   */
  private detonateNuke(nuke: Nuke): void {
    const map = this.grid.map;
    const cx = Math.round(nuke.toX);
    const cy = Math.round(nuke.toY);
    const tilesBefore = new Map<PlayerId, number>();
    const tilesCleared = new Map<PlayerId, number>();

    // The outer-ring destruction rolls come from a PRNG seeded with the
    // detonation tick — OpenFront's NukeExecution does exactly this
    // (`new PseudoRandom(mg.ticks())` + `chance(2)` per outer tile).
    const rand = new Prng(this.tickCount);
    const { inner, outer, outerChance } = nukeBlast(nuke.kind);
    const minX = Math.max(0, cx - outer);
    const maxX = Math.min(map.width - 1, cx + outer);
    const minY = Math.max(0, cy - outer);
    const maxY = Math.min(map.height - 1, cy + outer);
    const outerSq = outer * outer;
    const innerSq = inner * inner;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq > outerSq) continue;
        const ref = map.ref(x, y);
        if (!this.grid.isCapturable(ref)) continue;

        const destroy = distSq <= innerSq || rand.roll(outerChance);
        if (!destroy) continue;

        const owner = this.grid.ownerOf(ref);
        if (owner !== NEUTRAL_PLAYER) {
          if (!tilesBefore.has(owner)) tilesBefore.set(owner, this.grid.tileCountOf(owner));
          tilesCleared.set(owner, (tilesCleared.get(owner) ?? 0) + 1);
        }
        // Clear to neutral, then leave the ground permanently radioactive:
        // still capturable, but at the fallout combat penalty, and scrubbed
        // clean only when conquered — OpenFront's default (non-waterNukes) rule.
        this.grid.claim(ref, NEUTRAL_PLAYER);
        this.grid.setFallout(ref);
      }
    }

    const victims: PlayerId[] = [];
    for (const [owner, cleared] of tilesCleared) {
      victims.push(owner);
      const before = tilesBefore.get(owner)!;
      if (before <= 0) continue;
      const fraction = Math.min(1, cleared / before);
      this.grid.addTroops(owner, -this.grid.troopsOf(owner) * fraction);
    }

    this.nukeDetonations.push({ attacker: nuke.attacker, targetX: nuke.toX, targetY: nuke.toY, kind: nuke.kind, victims });
  }

  /**
   * Sweep every in-flight warhead against active, non-allied SAM Launchers:
   * a SAM within {@link SAM_RANGE} of a warhead's current position fires an
   * interceptor if it's off cooldown, consuming the cooldown whether or not
   * the deterministic roll ({@link SAM_INTERCEPT_CHANCE}) hits. A SAM engages
   * at most one warhead per tick; an intercepted warhead is removed before it
   * can detonate. Run before {@link advanceNukes} so a shoot-down happens
   * mid-flight rather than on the same tick as an already-resolved impact.
   */
  private interceptNukes(): void {
    if (this.nukes.length === 0) return;
    const sams: TileRef[] = [];
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type === "sam") sams.push(ref);
    }
    if (sams.length === 0) return;

    const map = this.grid.map;
    const engagedThisTick = new Set<TileRef>();
    const survivors: Nuke[] = [];
    for (const nuke of this.nukes) {
      const t = nuke.ticksTotal > 0 ? nuke.ticksElapsed / nuke.ticksTotal : 1;
      const cx = nuke.fromX + (nuke.toX - nuke.fromX) * t;
      const cy = nuke.fromY + (nuke.toY - nuke.fromY) * t;
      let intercepted = false;
      for (const sam of sams) {
        if (engagedThisTick.has(sam)) continue;
        const owner = this.grid.ownerOf(sam);
        if (owner === nuke.attacker) continue;
        if (owner !== NEUTRAL_PLAYER && this.allies.areAllied(nuke.attacker, owner)) continue;
        if ((this.samCooldownUntil.get(sam) ?? 0) > this.tickCount) continue;
        if (Math.max(Math.abs(map.x(sam) - cx), Math.abs(map.y(sam) - cy)) > SAM_RANGE) continue;

        engagedThisTick.add(sam);
        this.samCooldownUntil.set(sam, this.tickCount + SAM_RELOAD_TICKS);
        let rng = this.samRng.get(sam);
        if (!rng) {
          rng = new Prng(sam);
          this.samRng.set(sam, rng);
        }
        if (rng.roll(SAM_INTERCEPT_CHANCE)) {
          intercepted = true;
          this.nukeInterceptions.push({ attacker: nuke.attacker, defender: owner, x: cx, y: cy });
        }
        break;
      }
      if (!intercepted) survivors.push(nuke);
    }
    this.nukes.length = 0;
    this.nukes.push(...survivors);
  }

  /** Advance every nuke in flight one tick; detonate any that just arrived. */
  private advanceNukes(): void {
    const survivors: Nuke[] = [];
    for (const nuke of this.nukes) {
      nuke.ticksElapsed += 1;
      if (nuke.ticksElapsed < nuke.ticksTotal) {
        survivors.push(nuke);
        continue;
      }
      this.detonateNuke(nuke);
    }
    this.nukes.length = 0;
    this.nukes.push(...survivors);
  }

  /** Advance the simulation by one tick. */
  processTick(intents: AttackIntent[] = []): RasterTickResult {
    const rejections: RasterTickResult["rejections"] = [];

    if (this.winnerId !== null) {
      this.tickCount += 1;
      return {
        tick: this.tickCount,
        winner: this.winnerId,
        rejections,
        activeAttacks: 0,
        crossings: [],
        nukeDetonations: [],
        nukeInterceptions: [],
        shipLosses: [],
      };
    }

    for (const intent of intents) {
      const reason = this.launchAttack(intent);
      if (reason) rejections.push({ intent, reason });
    }

    this.crossings = [];
    this.nukeDetonations = [];
    this.nukeInterceptions = [];
    this.shipLosses = [];
    // Switch on any structures whose construction window has elapsed, so their
    // effects (city cap, stations, fort aura) count from this tick on.
    this.grid.activateDue(this.tickCount);
    this.applyIncome();
    this.applyGoldIncome();
    // Trains ride the auto-routed rail network and bank gold at city/port stops.
    // Run after gold income so a payout lands in the same tick it is earned.
    this.rails.advance(this.tickCount);
    // Trade ships sail between ports and pay both ends gold on arrival.
    this.trade.advance(this.tickCount);
    // Mobile warships hunt down enemy transports/warships/trade ships before
    // transports advance/land this tick.
    this.advanceWarships();
    // Fort guns shell hostile ships in range (OpenFront's defense-post gun),
    // likewise before transports advance/land.
    this.advanceFortGuns();
    this.advanceShips();
    // SAM Launchers shoot down in-flight warheads before they can detonate.
    this.interceptNukes();
    this.advanceNukes();
    this.advanceAttacks();
    this.checkVictory();

    this.tickCount += 1;
    return {
      tick: this.tickCount,
      winner: this.winnerId,
      rejections,
      activeAttacks: this.attacks.length,
      crossings: this.crossings,
      nukeDetonations: this.nukeDetonations,
      nukeInterceptions: this.nukeInterceptions,
      shipLosses: this.shipLosses,
    };
  }

  /**
   * The current fallout combat multiplier (OpenFront's `falloutDefenseModifier`),
   * scaled by how much of the map's land is irradiated: ×5 on a pristine map,
   * easing toward ×3 as fallout blankets the world. 1 when nothing glows.
   */
  private falloutModifier(): number {
    if (this.grid.falloutCount === 0) return 1;
    return falloutCombatModifier(this.grid.falloutCount / Math.max(1, this.grid.capturableCount));
  }

  /**
   * Effective troop-loss magnitude for capturing `ref`: the tile's terrain
   * magnitude (OpenFront's plains/highland/mountain `mag`), raised by the
   * defender's Fortress Wall, any nearby defense-post aura, and — on nuked
   * ground — the fallout combat penalty.
   */
  private tileMagnitude(ref: TileRef, target: PlayerId): number {
    let mag = terrainCombat(this.grid.map.magnitude(ref)).mag;
    if (target !== NEUTRAL_PLAYER) mag *= this.grid.modifiersOf(target).defense;
    mag *= this.grid.defenseFactorAt(ref);
    if (this.grid.hasFallout(ref)) mag *= this.falloutModifier();
    // A marked traitor defends at half strength (OpenFront's traitorDefenseDebuff),
    // so its tiles are far cheaper to take for the window after a betrayal.
    if (target !== NEUTRAL_PLAYER && this.isTraitor(target)) mag *= TRAITOR_DEFENSE_DEBUFF;
    return mag;
  }

  /** A defender's raw per-tile troop density (pool ÷ territory, floored at 1). */
  private defenderDensityOf(target: PlayerId): number {
    return defenderLossPerTile(this.grid.troopsOf(target), this.grid.tileCountOf(target));
  }

  /**
   * Troops the attacker spends to capture one tile, mirroring OpenFront's
   * `attackLogic`: neutral land costs `mag/5`; an enemy tile blends the clamped
   * defender/attacker troop ratio with the defender's density (see
   * {@link attackerLossPerTile}). `attackForce` is the attack's current committed
   * pool, so the ratio shifts as the assault is spent down. `ratioDebuff` is the
   * tick's large-empire loss factor, applied inside the ratio term only (see
   * {@link attackerLossPerTile}).
   */
  private attackerTileLoss(
    ref: TileRef,
    attacker: PlayerId,
    target: PlayerId,
    attackForce: number,
    defenderTroops: number,
    defenderDensity: number,
    ratioDebuff = 1,
  ): number {
    const mag = this.tileMagnitude(ref, target);
    if (target === NEUTRAL_PLAYER) {
      // OpenFront's Bots pay half for neutral land (mag/10 vs mag/5), so
      // passive Tribe fillers blanket empty land fast; carried by the
      // attacker's neutralCostMultiplier (1 for everyone else, 0.5 for a Bot).
      return neutralLossPerTile(mag) * this.grid.modifiersOf(attacker).neutralCostMultiplier;
    }
    return attackerLossPerTile(defenderTroops, defenderDensity, attackForce, mag, ratioDebuff);
  }

  /**
   * Finish off a defender an attack has ground below
   * {@link DEAD_DEFENDER_MAX_TILES} — OpenFront's `handleDeadDefender` /
   * `conquerPlayer` sweep, ported structurally: up to ten passes over the
   * dying nation's remaining tiles, each pass handing every tile that borders
   * the attacker to the **attacker**, and any other tile that borders some
   * non-allied third player to *that* player. Repeated passes let the sweep
   * eat inward from the borders; tiles with no player neighbour at all (a
   * remote island) survive, exactly as in OpenFront.
   */
  private finishDeadDefender(attacker: PlayerId, target: PlayerId): void {
    for (let pass = 0; pass < 10 && this.grid.tileCountOf(target) > 0; pass += 1) {
      // tilesOf already returns a fresh copy, safe to claim against while iterating.
      for (const tile of this.grid.tilesOf(target)) {
        let claimant: PlayerId | null = null;
        for (const n of this.grid.map.neighbors(tile)) {
          const owner = this.grid.ownerOf(n);
          if (owner === attacker) {
            claimant = attacker;
            break;
          }
          if (claimant === null && owner !== NEUTRAL_PLAYER && owner !== target && !this.allies.areAllied(owner, target)) {
            claimant = owner;
          }
        }
        if (claimant !== null) this.grid.claim(tile, claimant);
      }
    }
  }

  /**
   * Capture priority of a single frontier tile (lower = taken sooner), mirroring
   * OpenFront's heap key exactly:
   * `(jitter0..7 + 10) · (1 − ownedNeighbours·0.5 + magWeight/2) + enqueueTick`.
   * Tiles enclosed by more of the attacker's own territory (pockets) score lower —
   * even negative — so the front back-fills concavities and grows as a smooth
   * radial blob rather than a tendril; higher ground scores higher, so easy low
   * ground is eaten first; and the enqueue tick (when the tile first joined this
   * front) makes ordering FIFO across generations, so the front rolls layer by
   * layer instead of freezing against an elevation contour. The jitter comes
   * from the attack's own seeded PRNG, rolled once at enqueue exactly like
   * OpenFront's `nextInt(0, 7)`; see `rasterCombatConfig`.
   */
  private tilePriority(attacker: PlayerId, ref: TileRef, entry: FrontierEntry): number {
    let ownedNeighbours = 0;
    const scratch = this.scratchNeighbors;
    const count = this.grid.map.neighborsInto(ref, scratch);
    for (let i = 0; i < count; i += 1) {
      if (this.grid.ownerOf(scratch[i]) === attacker) ownedNeighbours += 1;
    }
    const structural =
      1 - ownedNeighbours * FRONTIER_SURROUND_WEIGHT + terrainPriorityWeight(this.grid.map.magnitude(ref)) / 2;
    return (FRONTIER_JITTER_BASE + entry.jitter) * structural + entry.tick;
  }

  /**
   * The attacker's land frontier against `target`, ordered by capture priority
   * for this tick. Tiles newly on the frontier are stamped with the current
   * tick and a fresh jitter roll from the attack's PRNG (OpenFront's enqueue
   * moment) before scoring; new tiles are visited in ascending ref order, so
   * the sequential draws stay deterministic. A fresh array (the grid's
   * frontier is not mutated).
   */
  private orderedFrontier(attack: RasterAttack): TileRef[] {
    // Score each tile once, then sort — priority is fixed for the tick, so we
    // avoid recomputing it on every comparison.
    const frontier = this.grid.landFrontierOf(attack.attacker, attack.target);
    const scored = frontier.map((ref) => {
      let entry = attack.seen.get(ref);
      if (entry === undefined) {
        entry = { tick: this.tickCount, jitter: attack.rng.nextInt(0, FRONTIER_JITTER_STEPS) };
        attack.seen.set(ref, entry);
      }
      return { ref, p: this.tilePriority(attack.attacker, ref, entry) };
    });
    scored.sort((a, b) => a.p - b.p || a.ref - b.ref);
    return scored.map((s) => s.ref);
  }

  /**
   * Troops a `target` player loses when one of their tiles is captured: a
   * density-based bleed (pool ÷ territory) blunted by their Fortress Wall
   * defence. Snapshotted by callers once per tick so capturing many tiles in
   * one advance doesn't compound the bleed mid-tick.
   */
  private defenderLossFor(target: PlayerId): number {
    const density = defenderLossPerTile(this.grid.troopsOf(target), this.grid.tileCountOf(target));
    return density / this.grid.modifiersOf(target).defense;
  }

  /**
   * Each player gains income proportional to the tiles they hold, accumulated
   * fractionally and flushed into the integer pool. The pool is capped relative
   * to territory size so it cannot grow without bound.
   */
  private applyIncome(): void {
    for (const id of this.grid.players()) {
      const tiles = this.grid.tileCountOf(id);
      if (tiles <= 0) {
        this.incomeAccumulator.set(id, 0);
        continue;
      }
      // OpenFront's territory-scaled ceiling, lifted by each city and scaled by
      // the player's difficulty cap multiplier (weaker AI get a lower ceiling);
      // the bell-curve growth tapers to zero as the pool nears it.
      const cap = maxTroops(tiles, this.grid.activeLevelsOf(id, "city")) *
        this.grid.modifiersOf(id).troopCapMultiplier;
      const troops = this.grid.troopsOf(id);
      if (troops >= cap) {
        this.incomeAccumulator.set(id, 0);
        continue;
      }
      // Bell-curve growth: slow when the pool is tiny, fastest mid-range, easing
      // to zero at the cap. A per-player income modifier scales the rate. The
      // fractional remainder is carried between ticks so the integer pool tracks
      // the real-valued growth without losing sub-1 increments.
      const add = troopGrowth(troops, cap) * this.grid.modifiersOf(id).income;
      const accumulated = (this.incomeAccumulator.get(id) ?? 0) + add;
      const whole = Math.floor(accumulated);
      if (whole > 0) this.grid.setTroops(id, Math.min(cap, troops + whole));
      this.incomeAccumulator.set(id, accumulated - whole);
    }
  }

  /**
   * Each player earns a **flat** passive gold trickle every tick, exactly like
   * OpenFront's `goldAdditionRate` — independent of territory, cities and ports.
   * Gold is otherwise grown through trade ships, trains and conquest, not a
   * per-tile/per-building dividend. Uncapped (a spend resource), so no soft cap.
   */
  private applyGoldIncome(): void {
    for (const id of this.grid.players()) {
      if (this.grid.tileCountOf(id) <= 0) continue; // eliminated — earns nothing
      // OpenFront's goldAdditionRate pays a PlayerType.Bot a 50 base where
      // everyone else gets 100 — expressed here as the 0.5 goldMultiplier a
      // Tribe seat carries.
      this.grid.addGold(id, Math.floor(GOLD_BASE_PER_TICK * this.grid.modifiersOf(id).goldMultiplier));
    }
  }

  /**
   * Advance every transport ship one step along its water route. A ship that
   * reaches its destination disembarks: it captures the landing tile (paying the
   * beachhead cost and bleeding the defender), then commits whatever troops
   * remain as a land attack radiating from the new beachhead. Landings are
   * recorded as {@link SeaCrossing}s for the client to flash.
   */
  /** Live warship units `owner` currently has afloat (drives the cost ramp). */
  warshipCountOf(owner: PlayerId): number {
    let count = 0;
    for (const w of this.warships) if (w.owner === owner) count += 1;
    return count;
  }

  /** `owner`'s active (finished) port tiles, ascending. */
  private activePortsOf(owner: PlayerId): TileRef[] {
    const ports: TileRef[] = [];
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type === "port" && this.grid.ownerOf(ref) === owner) ports.push(ref);
    }
    return ports;
  }

  /** The tile of `refs` nearest (Chebyshev) to `(x, y)`, ties to the lowest ref. */
  private nearestRef(refs: readonly TileRef[], x: number, y: number): TileRef | null {
    const map = this.grid.map;
    let best: TileRef | null = null;
    let bestD = Infinity;
    for (const ref of refs) {
      const d = Math.max(Math.abs(map.x(ref) - x), Math.abs(map.y(ref) - y));
      if (d < bestD || (d === bestD && (best === null || ref < best))) {
        bestD = d;
        best = ref;
      }
    }
    return best;
  }

  /** The water tile nearest the click within the coastal snap radius, or null. */
  private nearestWater(targetX: number, targetY: number, maxRadius: number): TileRef | null {
    const map = this.grid.map;
    const cx = Math.round(targetX);
    const cy = Math.round(targetY);
    let best: TileRef | null = null;
    let bestScore = Infinity;
    for (let dy = -maxRadius; dy <= maxRadius; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= map.height) continue;
      for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
        const x = cx + dx;
        if (x < 0 || x >= map.width) continue;
        const candidate = map.ref(x, y);
        if (!map.isWater(candidate)) continue;
        const score = dx * dx + dy * dy;
        if (score < bestScore || (score === bestScore && (best === null || candidate < best))) {
          bestScore = score;
          best = candidate;
        }
      }
    }
    return best;
  }

  /**
   * Buy a warship — the wiki's flow: the order targets a patch of **water**
   * (the unit's patrol sector; a near-miss click snaps to the nearest water
   * within the coastal snap radius), requires an active **port**, and the unit
   * appears at the owner's port nearest that sector, then sails to it. Gold is
   * the session's concern (like building purchases); this validates and spawns.
   */
  launchWarship(owner: PlayerId, targetX: number, targetY: number): WarshipRejectReason | null {
    const ports = this.activePortsOf(owner);
    if (ports.length === 0) return "NO_PORT";
    const patrol = this.nearestWater(targetX, targetY, CLICK_SNAP_RADIUS);
    if (patrol === null) return "INVALID_TARGET";
    const map = this.grid.map;
    const px = map.x(patrol);
    const py = map.y(patrol);
    const home = this.nearestRef(ports, px, py)!;
    const id = this.nextWarshipId++;
    this.warships.push({
      id,
      owner,
      patrolX: px,
      patrolY: py,
      wanderX: px,
      wanderY: py,
      x: map.x(home),
      y: map.y(home),
      destX: px,
      destY: py,
      hp: WARSHIP_MAX_HP,
      target: null,
      retreating: false,
      shellReadyAt: 0,
      // Every unit draws its patrol wander from its own seeded stream, so
      // replays stay identical without Math.random (OpenFront seeds its
      // executions' PseudoRandom the same way).
      rng: new Prng(ATTACK_RNG_SEED + id),
    });
    return null;
  }

  /** Drop a warship from the live roster by id (already-dead entries are a no-op). */
  private removeWarship(id: number): void {
    const idx = this.warships.findIndex((w) => w.id === id);
    if (idx !== -1) this.warships.splice(idx, 1);
  }

  /**
   * The nearest hostile (non-owner, non-allied) target within
   * {@link WARSHIP_TARGET_RANGE} of `w`, in OpenFront's fixed priority order:
   * any enemy transport ship beats every enemy warship, which beats every
   * enemy trade ship — never a nearer lower-tier target over a farther
   * higher-tier one. Trade prizes are considered only while the owner still
   * runs a port (`canCaptureTrade` — the wiki: no port, no capturing), and a
   * trader already *heading to* one of the owner's ports is left alone (its
   * arrival pays that port in full).
   */
  private pickWarshipTarget(
    w: Warship,
    canCaptureTrade: boolean,
    tradeTargets: ReturnType<TradeSystem["targetableShips"]>,
  ): { kind: WarshipTargetKind; id: number; x: number; y: number } | null {
    const map = this.grid.map;
    const isHostile = (owner: PlayerId): boolean =>
      owner !== w.owner && owner !== NEUTRAL_PLAYER && !this.allies.areAllied(w.owner, owner);

    let best: { kind: WarshipTargetKind; id: number; x: number; y: number; d: number } | null = null;
    const consider = (kind: WarshipTargetKind, id: number, x: number, y: number): void => {
      const d = Math.max(Math.abs(x - w.x), Math.abs(y - w.y));
      if (d > WARSHIP_TARGET_RANGE) return;
      if (!best || d < best.d) best = { kind, id, x, y, d };
    };

    for (const s of this.ships) {
      if (!isHostile(s.attacker)) continue;
      const tile = s.path[s.progress];
      consider("transport", s.id, map.x(tile), map.y(tile));
    }
    if (best) return best;

    for (const other of this.warships) {
      if (other.id === w.id || !isHostile(other.owner)) continue;
      consider("warship", other.id, other.x, other.y);
    }
    if (best) return best;

    if (!canCaptureTrade) return null;
    for (const t of tradeTargets) {
      if (!isHostile(t.owner) || t.toOwner === w.owner) continue;
      consider("trade", t.id, t.x, t.y);
    }
    return best;
  }

  /**
   * Step `w` one tick's distance toward `(tx, ty)`, snapping exactly onto it
   * once close enough (arriving is always allowed, even at a home tile that
   * itself sits on land — "docking"). When the straight step would run onto
   * land, the ship **sidesteps**: it takes the unit step (of the eight compass
   * directions) that stays on water and closes the most distance, so it slides
   * along a coastline instead of freezing against it. Only distance-*reducing*
   * sidesteps are taken (no oscillation); a deeply concave shore can still pin
   * a ship for a while — a documented simplification versus full per-tick BFS
   * water routing, which a moving target would make far more expensive.
   */
  private moveWarshipToward(w: Warship, tx: number, ty: number, speed = WARSHIP_TILES_PER_TICK): void {
    w.destX = tx;
    w.destY = ty;
    const dx = tx - w.x;
    const dy = ty - w.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist === 0) return;
    const step = Math.min(speed, dist);
    const nx = w.x + (dx / dist) * step;
    const ny = w.y + (dy / dist) * step;
    if (step >= dist) {
      w.x = nx;
      w.y = ny;
      return;
    }
    const map = this.grid.map;
    const open = (x: number, y: number): boolean => {
      const rx = Math.round(x);
      const ry = Math.round(y);
      return map.inBounds(rx, ry) && !map.isLand(map.ref(rx, ry));
    };
    if (open(nx, ny)) {
      w.x = nx;
      w.y = ny;
      return;
    }
    // Coast in the way: slide along it via the best open compass step that
    // still gets closer to the target. Fixed direction order keeps ties (and
    // therefore replays) deterministic.
    const DIRS: ReadonlyArray<readonly [number, number]> = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    let bestX = w.x;
    let bestY = w.y;
    let bestD = dist;
    for (const [ux, uy] of DIRS) {
      const cx = w.x + ux * step;
      const cy = w.y + uy * step;
      if (!open(cx, cy)) continue;
      const d = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
      if (d < bestD) {
        bestD = d;
        bestX = cx;
        bestY = cy;
      }
    }
    w.x = bestX;
    w.y = bestY;
  }

  /**
   * Resolve `w`'s shot at `target`: an enemy transport is sunk outright (no HP
   * pool — its troops are lost with no refund); an enemy warship takes
   * {@link WARSHIP_SHELL_DAMAGE}. Trade ships are never *shot* — a trade prize
   * is chased down and captured on contact in {@link advanceWarships}.
   */
  private fireOn(w: Warship, target: { kind: WarshipTargetKind; id: number }): void {
    if (target.kind === "transport") {
      const idx = this.ships.findIndex((s) => s.id === target.id);
      if (idx !== -1) {
        const sunk = this.ships[idx];
        this.shipLosses.push({ victim: sunk.attacker, by: w.owner, kind: "transport", x: w.destX, y: w.destY });
        this.ships.splice(idx, 1);
      }
      return;
    }
    if (target.kind === "trade") return; // captured on contact, not shelled
    const enemy = this.warships.find((x) => x.id === target.id);
    if (!enemy) return;
    this.damageWarship(enemy, WARSHIP_SHELL_DAMAGE);
  }

  /** Apply `damage` to a warship; at 0 HP the unit sinks (nothing else falls with it). */
  private damageWarship(enemy: Warship, damage: number): void {
    enemy.hp -= damage;
    if (enemy.hp <= 0) this.removeWarship(enemy.id);
  }

  /**
   * Idle patrol: wander the assigned sector. On (or near) the current
   * waypoint, draw the next one from the unit's own random stream — a point
   * within {@link WARSHIP_PATROL_WANDER_RADIUS} of the sector centre that
   * lands on water (a few tries; the centre itself as the fallback) — then
   * sail toward it.
   */
  private patrolWarship(w: Warship): void {
    const map = this.grid.map;
    if (Math.max(Math.abs(w.wanderX - w.x), Math.abs(w.wanderY - w.y)) < 1) {
      let nextX = w.patrolX;
      let nextY = w.patrolY;
      for (let tries = 0; tries < 8; tries += 1) {
        const cx = w.patrolX + (w.rng.next() * 2 - 1) * WARSHIP_PATROL_WANDER_RADIUS;
        const cy = w.patrolY + (w.rng.next() * 2 - 1) * WARSHIP_PATROL_WANDER_RADIUS;
        const rx = Math.round(cx);
        const ry = Math.round(cy);
        if (map.inBounds(rx, ry) && map.isWater(map.ref(rx, ry))) {
          nextX = cx;
          nextY = cy;
          break;
        }
      }
      w.wanderX = nextX;
      w.wanderY = nextY;
      return;
    }
    this.moveWarshipToward(w, w.wanderX, w.wanderY);
  }

  /**
   * OpenFront's defense-post **gun**: every active fort shells the nearest
   * hostile ship within {@link FORT_SHELL_RANGE} once per
   * {@link FORT_SHELL_RATE_TICKS}. A transport (the landing the post exists to
   * stop) outranks a warship; trade ships are commerce and are never fired on
   * — piracy is the warship's business. A transport is sunk outright (its
   * troops are lost, no refund); a warship takes {@link FORT_SHELL_DAMAGE}.
   * The cooldown is spent only when a shot is actually taken, so an idle gun
   * is always ready the moment an intruder sails into range.
   */
  private advanceFortGuns(): void {
    if (this.ships.length === 0 && this.warships.length === 0) return;
    const map = this.grid.map;
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type !== "fort") continue;
      if ((this.fortShellReadyAt.get(ref) ?? 0) > this.tickCount) continue;
      const owner = this.grid.ownerOf(ref);
      if (owner === NEUTRAL_PLAYER) continue;
      const fx = map.x(ref);
      const fy = map.y(ref);
      const isHostile = (o: PlayerId): boolean =>
        o !== owner && o !== NEUTRAL_PLAYER && !this.allies.areAllied(owner, o);

      let bestShip: TransportShip | null = null;
      let bestD = Infinity;
      for (const s of this.ships) {
        if (!isHostile(s.attacker)) continue;
        const tile = s.path[s.progress];
        const d = Math.max(Math.abs(map.x(tile) - fx), Math.abs(map.y(tile) - fy));
        if (d <= FORT_SHELL_RANGE && d < bestD) {
          bestD = d;
          bestShip = s;
        }
      }
      if (bestShip) {
        this.ships.splice(this.ships.indexOf(bestShip), 1);
        this.fortShellReadyAt.set(ref, this.tickCount + FORT_SHELL_RATE_TICKS);
        continue;
      }

      let bestWarship: Warship | null = null;
      bestD = Infinity;
      for (const w of this.warships) {
        if (!isHostile(w.owner)) continue;
        const d = Math.max(Math.abs(w.x - fx), Math.abs(w.y - fy));
        if (d <= FORT_SHELL_RANGE && d < bestD) {
          bestD = d;
          bestWarship = w;
        }
      }
      if (bestWarship) {
        this.damageWarship(bestWarship, FORT_SHELL_DAMAGE);
        this.fortShellReadyAt.set(ref, this.tickCount + FORT_SHELL_RATE_TICKS);
      }
    }
  }

  /**
   * Advance every mobile warship one tick: heal (only while the owner still
   * runs a port — the wiki's rule), run the retreat hysteresis, pick a target,
   * close the distance, and act — shells for transports/warships, a full-speed
   * chase ending in an on-contact capture for a trade prize. Idle ships wander
   * their patrol sector. A warship sunk earlier this tick — later in the
   * `[...this.warships]` snapshot — is skipped via the `hp <= 0` guard below.
   */
  private advanceWarships(): void {
    if (this.warships.length === 0) return;
    const map = this.grid.map;

    // Per-tick shared lookups: each owner's active ports and the targetable
    // trade ships. Both used to be recomputed per warship — with a full fleet
    // that was thousands of building-roster/trade-ship scans per tick.
    const portsByOwner = new Map<PlayerId, TileRef[]>();
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type !== "port") continue;
      const owner = this.grid.ownerOf(ref);
      const list = portsByOwner.get(owner);
      if (list) list.push(ref);
      else portsByOwner.set(owner, [ref]);
    }
    const tradeTargets = this.trade.targetableShips();

    for (const w of [...this.warships]) {
      if (w.hp <= 0) continue; // sunk by an earlier warship's shot this tick
      // An eliminated owner (no territory left) can't crew a fleet: scuttle any
      // orphaned warship so it stops patrolling and sinking live players' ships
      // (and destroying trade ships it can never bank) for the rest of the match.
      if (this.grid.tileCountOf(w.owner) === 0) {
        this.removeWarship(w.id);
        continue;
      }

      const ports = portsByOwner.get(w.owner) ?? [];
      const hasPort = ports.length > 0;
      // The wiki: a warship heals only while its owner has at least one port.
      if (hasPort) w.hp = Math.min(WARSHIP_MAX_HP, w.hp + WARSHIP_PASSIVE_HEAL_PER_TICK);
      if (w.hp < WARSHIP_RETREAT_HP) w.retreating = true;
      else if (w.hp >= WARSHIP_RETREAT_RECOVER_HP) w.retreating = false;

      if (w.retreating) {
        w.target = null;
        // Limp to the nearest own port to heal; with no harbour left, fall
        // back to the patrol centre (it can't heal there, but it stays on
        // station instead of drifting).
        const haven = this.nearestRef(ports, w.x, w.y);
        if (haven !== null) this.moveWarshipToward(w, map.x(haven), map.y(haven));
        else this.moveWarshipToward(w, w.patrolX, w.patrolY);
        continue;
      }

      const target = this.pickWarshipTarget(w, hasPort, tradeTargets);
      w.target = target ? { kind: target.kind, id: target.id } : null;
      if (!target) {
        this.patrolWarship(w);
        continue;
      }

      if (target.kind === "trade") {
        // The wiki's piracy: rush the prize at double speed and capture it on
        // contact — no shells, no cooldown.
        const d = Math.max(Math.abs(target.x - w.x), Math.abs(target.y - w.y));
        if (d <= WARSHIP_CAPTURE_CONTACT_RANGE) {
          // Attribute the piracy before the prize changes hands — the victim's
          // AI reads this to consider a retaliation warship.
          const prize = this.trade.targetableShips().find((t) => t.id === target.id);
          if (prize) {
            this.shipLosses.push({ victim: prize.owner, by: w.owner, kind: "trade", x: prize.x, y: prize.y });
          }
          this.trade.captureShip(target.id, w.owner);
          w.target = null;
        } else {
          this.moveWarshipToward(w, target.x, target.y, WARSHIP_TRADE_CHASE_SPEED);
        }
        continue;
      }

      if (Math.max(Math.abs(target.x - w.x), Math.abs(target.y - w.y)) > WARSHIP_ENGAGE_RANGE) {
        this.moveWarshipToward(w, target.x, target.y);
        continue;
      }
      // Holding position in gun range: the course line still points at the foe.
      w.destX = target.x;
      w.destY = target.y;
      if (this.tickCount < w.shellReadyAt) continue;
      w.shellReadyAt = this.tickCount + WARSHIP_SHELL_RATE_TICKS;
      this.fireOn(w, target);
    }
  }

  private advanceShips(): void {
    const survivors: TransportShip[] = [];

    for (const ship of this.ships) {
      // An owner who lost their last tile while this transport sailed is
      // eliminated: drop the ship (its embarked troops are forfeit with the
      // nation) rather than let it land and claim a beachhead, which would
      // resurrect a player the session has already removed from play.
      if (this.grid.tileCountOf(ship.attacker) === 0) continue;
      const lastIndex = ship.path.length - 1;
      // Sea God (seaSpeed) makes ships glide faster along their route.
      const step = Math.max(1, Math.round(SHIP_TILES_PER_TICK * this.grid.modifiersOf(ship.attacker).seaSpeed));
      ship.progress = Math.min(lastIndex, ship.progress + step);
      if (ship.progress < lastIndex) {
        survivors.push(ship);
        continue;
      }

      // Arrival. `dest` is the final path tile; `from` the open water it sailed
      // in from (or the embarkation coast for a one-hop river).
      const dest = ship.path[lastIndex];
      const from = ship.path[Math.max(0, lastIndex - 1)];
      this.crossings.push({ attacker: ship.attacker, from, to: dest });

      const owner = this.grid.ownerOf(dest);
      if (owner === ship.attacker) {
        // The beachhead already belongs to us (captured by land while the ship
        // sailed): the assault evaporated mid-voyage and the troops sail home,
        // taxed by the retreat malus — OpenFront charges `malusForRetreat` on
        // exactly this arrival.
        this.grid.addTroops(ship.attacker, ship.troops * (1 - RETREAT_MALUS_FRACTION));
        continue;
      }
      if (owner !== NEUTRAL_PLAYER && this.allies.areAllied(ship.attacker, owner)) {
        // The destination became an ally's shore mid-voyage — the landing is
        // called off and the troops disembark home in full rather than storming
        // a friend (OpenFront hands the boat's troops straight back).
        this.grid.addTroops(ship.attacker, ship.troops);
        continue;
      }
      if (this.isImmune(owner)) {
        // The destination's owner gained spawn immunity mid-voyage — the landing
        // is called off, same as an ally's shore, rather than storming a nation
        // that can't currently be attacked.
        this.grid.addTroops(ship.attacker, ship.troops);
        continue;
      }

      // OpenFront's landing: the beachhead tile is conquered outright — the
      // TransportShipExecution calls `conquer(dst)` with no toll and no repel
      // roll — and the full boat load then pushes inland as a normal land
      // attack against the shore's former owner, radiating (undirected) from
      // the landing tile.
      this.grid.claim(dest, ship.attacker);
      const existing = this.attacks.find((a) => a.attacker === ship.attacker && a.target === owner);
      if (existing) existing.committed += ship.troops;
      else {
        this.attacks.push({
          attacker: ship.attacker,
          target: owner,
          committed: ship.troops,
          anchor: dest,
          rng: new Prng(ATTACK_RNG_SEED),
          seen: new Map(),
        });
      }
    }

    this.ships.length = 0;
    this.ships.push(...survivors);
  }

  /**
   * The frontier tile nearest the frontier's centroid — a stable, central point
   * on the contested border to anchor the attack's troop-count label. `frontier`
   * is assumed non-empty.
   */
  private frontierAnchor(frontier: TileRef[]): TileRef {
    let sx = 0;
    let sy = 0;
    for (const ref of frontier) {
      sx += this.grid.map.x(ref);
      sy += this.grid.map.y(ref);
    }
    const cx = sx / frontier.length;
    const cy = sy / frontier.length;
    let anchor = frontier[0];
    let bestDist = Infinity;
    for (const ref of frontier) {
      const dx = this.grid.map.x(ref) - cx;
      const dy = this.grid.map.y(ref) - cy;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        anchor = ref;
      }
    }
    return anchor;
  }

  /**
   * Run one expansion step per active attack. Each attack captures tiles from a
   * snapshot of its current land frontier, in deterministic order, until its
   * per-tick spend budget is used up or it can no longer afford the cheapest
   * tile. Stalled attacks (no land frontier, or troops too low) end and refund
   * their leftover troops. Water is never crossed here — that is the transport
   * ship's role.
   */
  private advanceAttacks(): void {
    const survivors: RasterAttack[] = [];

    for (const attack of this.attacks) {
      // An alliance forged while the front was already pushing turns it into
      // friendly ground — the assault stands down and its troops come home in
      // full (a peace, not a defeat, so no retreat malus).
      if (attack.target !== NEUTRAL_PLAYER && this.allies.areAllied(attack.attacker, attack.target)) {
        this.grid.addTroops(attack.attacker, attack.committed);
        continue;
      }

      const frontier = this.orderedFrontier(attack);

      // No reachable target tiles: the front is blocked or the target is gone.
      // OpenFront's `retreat()` here charges no malus — running out of ground
      // is not a deliberate pull-back — so the survivors come home in full.
      if (frontier.length === 0) {
        this.grid.addTroops(attack.attacker, attack.committed);
        continue;
      }

      // Anchor the on-map troop label near the centre of this front: the
      // frontier tile closest to the frontier's centroid. Computed from the
      // pre-capture frontier so the label sits on the contested edge.
      attack.anchor = this.frontierAnchor(frontier);

      const vsPlayer = attack.target !== NEUTRAL_PLAYER;
      const defenderTroops = vsPlayer ? this.grid.troopsOf(attack.target) : 0;
      // Snapshot the defender's raw density and per-tile bleed once for the tick,
      // so capturing many tiles this advance doesn't compound either mid-front.
      const defenderDensity = vsPlayer ? this.defenderDensityOf(attack.target) : 0;
      const defenderBleed = vsPlayer ? this.defenderLossFor(attack.target) : 0;
      // A sprawling nation defends each tile worse (OpenFront's defenseSig), so
      // its tiles cost the attacker less — an anti-snowball lever. A huge *attacker*
      // also projects force cheaply (OpenFront's largeAttackBonus). Both snapshotted
      // once for the tick, and both fold the OpenFront speed bonuses into cost.
      const largeFactor = vsPlayer
        ? largeDefenderLossFactor(this.grid.tileCountOf(attack.target)) *
          largeAttackerLossFactor(this.grid.tileCountOf(attack.attacker))
        : 1;

      // Per-tick advance budget (OpenFront's `attackTilesPerTick`): scales with
      // the attacker's troop advantage and the contested border width. OpenFront
      // widens the border term by `nextInt(0, 5)` from the attack's own PRNG,
      // drawn the same way here. `expansionSpeed` is the attacker's own speed
      // modifier.
      const expansionSpeed = this.grid.modifiersOf(attack.attacker).expansionSpeed;
      const borderJitter = attack.rng.nextInt(0, BORDER_JITTER_STEPS);
      let budget =
        attackTilesPerTick(defenderTroops, attack.committed, frontier.length + borderJitter, vsPlayer) *
        expansionSpeed;

      // Defender-side *speed* debuffs, constant for the tick (OpenFront's
      // `largeDefenderSpeedDebuff`, `largeAttackerSpeedBonus` and
      // `traitorSpeedDebuff`): they scale how much budget each captured tile
      // drains, separate from the troop-loss factors above.
      const speedDebuff = vsPlayer
        ? largeDefenderLossFactor(this.grid.tileCountOf(attack.target)) *
          largeAttackerSpeedFactor(this.grid.tileCountOf(attack.attacker)) *
          (this.isTraitor(attack.target) ? TRAITOR_SPEED_DEBUFF : 1)
        : 1;

      let captured = false;
      const falloutMod = this.falloutModifier();
      for (const ref of frontier) {
        // Each capture drains the budget by its speed cost (see below), so a
        // front takes a handful of tiles per tick, not its whole frontier — the
        // OpenFront crawl. The check sits before the capture, so a live front
        // always advances at least one tile per tick (as OpenFront's
        // `while (numTilesPerTick > 0)` loop does).
        if (budget <= 0) break;
        // OpenFront checks the pool at the top of its capture loop: a force
        // below a single troop is spent — the attack dies where it stands and
        // nothing comes home. There is no affordability gate before a capture;
        // the *last* capture may overdraw the pool, exactly as OpenFront's
        // troop count dips below 1 mid-loop.
        if (attack.committed < 1) break;
        // A tile may have been captured already if a player relinquished it; skip
        // anything no longer owned by the target (and forget its frontier entry
        // — without the prune, `seen` grows one record for every tile the front
        // ever touched, hundreds of MB over a map-sweeping campaign).
        if (this.grid.ownerOf(ref) !== attack.target) {
          attack.seen.delete(ref);
          continue;
        }
        // OpenFront's per-tile attacker loss: the ratio shifts as the assault is
        // spent down, so a front that bleeds out grinds to a halt on the spot.
        // The large-empire factor rides inside the ratio term only (OpenFront
        // never discounts the density half of the blend).
        const loss = this.attackerTileLoss(ref, attack.attacker, attack.target, attack.committed, defenderTroops, defenderDensity, largeFactor);

        // Budget drain (OpenFront's `tilesPerTickUsed`): the tile's terrain
        // speed (16.5/20/25), tripled inside the defender's fort aura, scaled
        // up on fallout ground and — vs players — by the clamped troop ratio
        // and the defender-side speed debuffs.
        let speed = terrainCombat(this.grid.map.magnitude(ref)).speed;
        if (vsPlayer && this.grid.defenseFactorAt(ref) > 1) speed *= FORT_SPEED_BONUS;
        if (this.grid.hasFallout(ref)) speed *= falloutMod;
        budget -= vsPlayer
          ? enemySpeedCost(defenderTroops, attack.committed, speed) * speedDebuff
          : neutralSpeedCost(speed, attack.committed);

        if (vsPlayer) this.grid.addTroops(attack.target, -defenderBleed);
        this.grid.claim(ref, attack.attacker);
        // Captured ground leaves the frontier for good — drop its entry (a
        // tile lost and retaken re-enqueues with a fresh tick/jitter, exactly
        // like a tile joining the front for the first time).
        attack.seen.delete(ref);
        attack.committed -= loss;
        captured = true;
      }

      // A defender this attack has just ground below the dead-defender
      // threshold is finished off outright (OpenFront's `handleDeadDefender`).
      if (vsPlayer && captured) {
        const left = this.grid.tileCountOf(attack.target);
        if (left > 0 && left < DEAD_DEFENDER_MAX_TILES) {
          this.finishDeadDefender(attack.attacker, attack.target);
        }
      }

      // Decide the attack's fate: a force spent below a single troop is dead —
      // it dissolves where it stands with no refund (OpenFront deletes the
      // attack the moment its troop count drops under 1). Anything else pushes
      // on next tick.
      if (attack.committed >= 1) survivors.push(attack);
    }

    this.attacks.length = 0;
    this.attacks.push(...survivors);
  }

  /**
   * Declare a winner once a player holds {@link WIN_TILE_FRACTION} of the
   * capturable land (OpenFront's domination win). The match ends the tick the
   * threshold is crossed — no drawn-out mop-up of the last hold-outs. At most
   * one player can sit at ≥80%, so first-found is unambiguous.
   */
  private checkVictory(): void {
    if (this.winnerId !== null || this.grid.capturableCount === 0) return;
    const threshold = this.grid.capturableCount * WIN_TILE_FRACTION;
    for (const id of this.grid.players()) {
      if (this.grid.tileCountOf(id) >= threshold) {
        this.winnerId = id;
        return;
      }
    }
  }
}
