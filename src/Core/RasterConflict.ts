import type { TileRef } from "./GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import { NO_ALLIANCES, type AllianceView } from "./alliances.js";
import {
  GOLD_BASE_PER_TICK,
  WARSHIP_ENGAGE_RANGE,
  WARSHIP_MAX_HP,
  WARSHIP_PASSIVE_HEAL_PER_TICK,
  WARSHIP_RETREAT_HP,
  WARSHIP_RETREAT_RECOVER_HP,
  WARSHIP_SHELL_DAMAGE,
  WARSHIP_SHELL_RATE_TICKS,
  WARSHIP_TARGET_RANGE,
  WARSHIP_TILES_PER_TICK,
} from "./buildings.js";
import {
  FALLOUT_DURATION_TICKS,
  MIRV_SCATTER_RADIUS,
  MIRV_WARHEAD_COUNT,
  NUKE_TILES_PER_TICK,
  nukeBlast,
  SAM_INTERCEPT_CHANCE,
  SAM_RANGE,
  SAM_RELOAD_TICKS,
  type NukeKind,
} from "./nukes.js";
import { RailSystem, type RailView, type TrainView } from "./railSystem.js";
import { TradeSystem, type TradeShipTarget, type TradeView } from "./tradeSystem.js";
import {
  attackerLossPerTile,
  attackTilesPerTick,
  defenderLossPerTile,
  defenderStrengthFactor,
  FRONTIER_JITTER_SPAN,
  FRONTIER_SURROUND_WEIGHT,
  FRONTIER_TOWARD_WEIGHT,
  terrainPriorityWeight,
  largeAttackerLossFactor,
  largeDefenderLossFactor,
  maxTroops,
  troopGrowth,
  MAX_TRANSPORT_SHIPS_PER_PLAYER,
  NEUTRAL_CAPTURE_COST,
  neutralLossPerTile,
  RETREAT_MALUS_FRACTION,
  SHIP_TILES_PER_TICK,
  terrainCombat,
  TRAITOR_DEFENSE_DEBUFF,
  TRAITOR_DURATION_TICKS,
  TRAITOR_SPEED_DEBUFF,
  WIN_TILE_FRACTION,
} from "./rasterCombatConfig.js";

/** A request to expand from `attacker`'s territory into `target`'s tiles. */
export interface AttackIntent {
  attacker: PlayerId;
  /** Player whose tiles are targeted, or {@link NEUTRAL_PLAYER} for free land. */
  target: PlayerId;
  /** Troops to commit from the attacker's pool. Positive integer. */
  troops: number;
  /**
   * The tile the player actually clicked, used to bias which part of the front
   * advances first so the push heads *toward* the click (see
   * {@link FRONTIER_TOWARD_WEIGHT}). Optional: omitted (e.g. a beachhead's inland
   * push) means undirected, radial growth.
   */
  toward?: TileRef;
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
}

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
   * The tile the attacker pointed at, biasing the front to advance toward it
   * (see {@link FRONTIER_TOWARD_WEIGHT}). `-1` means undirected (radial). The
   * latest reinforcing click wins, so re-clicking elsewhere redirects the push.
   */
  toward: TileRef;
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
 * A live warship unit — spawned when its home "warship" structure finishes
 * construction, torn down (structure and all) when it's sunk or its home tile
 * is lost. `x`/`y` are fractional tile-space, so movement eases smoothly.
 */
interface Warship {
  id: number;
  owner: PlayerId;
  /** The structure tile this warship launched from — where it heals and retreats to. */
  homeRef: TileRef;
  x: number;
  y: number;
  hp: number;
  target: { kind: WarshipTargetKind; id: number } | null;
  /** True once hp has dropped below the retreat threshold, until it heals back past the recovery one. */
  retreating: boolean;
  /** Tick (exclusive) this warship's guns are next ready to fire. */
  shellReadyAt: number;
}

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
 * Deterministic [0,1) draw from a cheap integer hash of two seeds — the same
 * technique the nuke-blast outer-ring roll and the frontier jitter use, so
 * replays stay exact (no `Math.random`).
 */
const pseudoRandom01 = (a: number, b: number): number =>
  ((a * 2654435761 + b * 40503) >>> 0) / 0x100000000;

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
  /** Live mobile warship units, one per active "warship" structure. */
  private readonly warships: Warship[] = [];
  /** Monotonic id source so each warship has a stable handle for the client. */
  private nextWarshipId = 1;
  /** Home structure tile → warship id, so {@link syncWarships} spawns/despawns exactly once per structure. */
  private readonly warshipByHome = new Map<TileRef, number>();
  /** Transport-ship landings resolved during the current tick. */
  private crossings: SeaCrossing[] = [];
  private tickCount = 0;
  private winnerId: PlayerId | null = null;

  constructor(grid: TerritoryGrid, allies: AllianceView = NO_ALLIANCES) {
    this.grid = grid;
    this.allies = allies;
    this.rails = new RailSystem(grid);
    // The trade system consults the (deferred) diplomacy view so an embargoed
    // pair never dispatches trade ships to each other.
    this.trade = new TradeSystem(grid, (a, b) => this.allies.isEmbargoed?.(a, b) ?? false);
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

  /** Live mobile warships, for the snapshot (empty until a warship structure finishes building). */
  activeWarships(): WarshipState[] {
    return this.warships.map((w) => ({
      id: w.id,
      owner: w.owner,
      x: w.x,
      y: w.y,
      hp: Math.max(0, Math.round(w.hp)),
      maxHp: WARSHIP_MAX_HP,
      retreating: w.retreating,
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
    const toward = intent.toward ?? -1;
    const existing = this.attacks.find((a) => a.attacker === attacker && a.target === target);
    if (existing) {
      existing.committed += troops;
      // The freshest click redirects the combined push; an undirected reinforce
      // (no toward) leaves the existing heading untouched.
      if (toward >= 0) existing.toward = toward;
    } else {
      this.attacks.push({ attacker, target, committed: troops, anchor: -1, toward });
    }
    if (target !== NEUTRAL_PLAYER) this.lastAttackedBy.set(target, attacker);
    return null;
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
   * (mirroring building purchases); this only enqueues the flight(s). A MIRV
   * splits into {@link MIRV_WARHEAD_COUNT} independent warheads that scatter
   * around the aim point (each flies its own straight-line course and can be
   * intercepted separately); every other kind is a single flight. Combat
   * effects (troop loss, territory clearing) land on impact in
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
      for (let i = 0; i < MIRV_WARHEAD_COUNT; i += 1) {
        const id = this.nextNukeId++;
        const angle = pseudoRandom01(id, 17) * Math.PI * 2;
        const dist = pseudoRandom01(id, 31) * MIRV_SCATTER_RADIUS;
        const wx = targetX + Math.cos(angle) * dist;
        const wy = targetY + Math.sin(angle) * dist;
        this.enqueueNuke(id, attacker, fromX, fromY, wx, wy, "mirv");
      }
      return;
    }
    this.enqueueNuke(this.nextNukeId++, attacker, fromX, fromY, targetX, targetY, kind);
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

        let destroy = distSq <= innerSq;
        if (!destroy) {
          // Deterministic [0,1) draw from a cheap integer hash of (ref, nuke id) —
          // same wobble technique as the frontier jitter, so replays stay exact.
          destroy = pseudoRandom01(ref, nuke.id) < outerChance;
        }
        if (!destroy) continue;

        const owner = this.grid.ownerOf(ref);
        if (owner !== NEUTRAL_PLAYER) {
          if (!tilesBefore.has(owner)) tilesBefore.set(owner, this.grid.tileCountOf(owner));
          tilesCleared.set(owner, (tilesCleared.get(owner) ?? 0) + 1);
        }
        // Clear to neutral, then leave the ground radioactive: it can't be
        // recaptured and renders as fallout until it decays (see tickFallout).
        this.grid.claim(ref, NEUTRAL_PLAYER);
        this.grid.setFallout(ref, FALLOUT_DURATION_TICKS);
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
        if (pseudoRandom01(sam, nuke.id) < SAM_INTERCEPT_CHANCE) {
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
      };
    }

    for (const intent of intents) {
      const reason = this.launchAttack(intent);
      if (reason) rejections.push({ intent, reason });
    }

    this.crossings = [];
    this.nukeDetonations = [];
    this.nukeInterceptions = [];
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
    this.advanceShips();
    // SAM Launchers shoot down in-flight warheads before they can detonate.
    this.interceptNukes();
    this.advanceNukes();
    // Decay fallout before attacks advance, so ground that recovered this tick
    // is immediately available to the frontier again.
    this.grid.tickFallout();
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
    };
  }

  /**
   * Troop cost to capture a single tile across a land border, factoring terrain,
   * ownership, fortifications and — via `strengthFactor` — how strongly the
   * defender is garrisoned relative to the assault (see
   * {@link defenderStrengthFactor}). Transport-ship landings price their
   * beachhead separately via {@link beachheadCost}. `strengthFactor` defaults to
   * 1 (no defender-strength effect), which neutral grabs always use.
   */
  /**
   * Effective troop-loss magnitude for capturing `ref`: the tile's terrain
   * magnitude (OpenFront's plains/highland/mountain `mag`), raised by the
   * defender's Fortress Wall and any nearby defense-post aura.
   */
  private tileMagnitude(ref: TileRef, target: PlayerId): number {
    let mag = terrainCombat(this.grid.map.magnitude(ref)).mag;
    if (target !== NEUTRAL_PLAYER) mag *= this.grid.modifiersOf(target).defense;
    mag *= this.grid.defenseFactorAt(ref);
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
   * pool, so the ratio shifts as the assault is spent down.
   */
  private attackerTileLoss(
    ref: TileRef,
    attacker: PlayerId,
    target: PlayerId,
    attackForce: number,
    defenderTroops: number,
    defenderDensity: number,
  ): number {
    const mag = this.tileMagnitude(ref, target);
    if (target === NEUTRAL_PLAYER) {
      // OpenFront's Bots pay half for neutral land (mag/10 vs mag/5), so
      // passive Tribe fillers blanket empty land fast; carried by the
      // attacker's neutralCostMultiplier (1 for everyone else, 0.5 for a Bot).
      return neutralLossPerTile(mag) * this.grid.modifiersOf(attacker).neutralCostMultiplier;
    }
    return attackerLossPerTile(defenderTroops, defenderDensity, attackForce, mag);
  }

  /**
   * Return leftover committed troops to an attacker's pool. Pulling back from a
   * *player* costs {@link RETREAT_MALUS_FRACTION} of the survivors (the
   * OpenFront retreat malus); falling back from neutral land is free. Used
   * wherever an attack or landing ends without taking its objective.
   */
  private refundRetreat(attacker: PlayerId, troops: number, target: PlayerId): void {
    if (troops <= 0) return;
    const kept = target === NEUTRAL_PLAYER ? troops : troops * (1 - RETREAT_MALUS_FRACTION);
    this.grid.addTroops(attacker, kept);
  }

  /**
   * Capture priority of a single frontier tile (lower = taken sooner), mirroring
   * OpenFront's structural key: `jitter · (1 − ownedNeighbours·0.5 + magWeight/2)`.
   * Tiles enclosed by more of the attacker's own territory (pockets) score lower —
   * even negative — so the front back-fills concavities and grows as a smooth
   * radial blob rather than a tendril; higher ground scores higher, so easy low
   * ground is eaten first. The `jitter` is a small deterministic hash of tile and
   * tick (OpenFront uses a wide RNG range we can't, so replays stay identical)
   * that scatters otherwise-equal perimeter tiles; see `rasterCombatConfig`.
   */
  private tilePriority(attacker: PlayerId, ref: TileRef): number {
    let ownedNeighbours = 0;
    for (const n of this.grid.map.neighbors(ref)) {
      if (this.grid.ownerOf(n) === attacker) ownedNeighbours += 1;
    }
    const structural =
      1 - ownedNeighbours * FRONTIER_SURROUND_WEIGHT + terrainPriorityWeight(this.grid.map.magnitude(ref)) / 2;
    // Deterministic [0,1) wobble from a cheap integer hash of (ref, tick).
    const hash = ((ref * 2654435761 + this.tickCount * 40503) >>> 0) / 0x100000000;
    return structural * (1 + hash * FRONTIER_JITTER_SPAN);
  }

  /**
   * The attacker's land frontier against `target`, ordered by capture priority
   * for this tick. When `toward >= 0` the ordering is biased so the front
   * advances toward that tile (the click): each tile's priority gains its
   * distance-to-`toward`, normalised across the frontier to [0,1], times
   * {@link FRONTIER_TOWARD_WEIGHT}. A fresh array (the grid's frontier is not
   * mutated).
   */
  private orderedFrontier(attacker: PlayerId, target: PlayerId, toward: TileRef): TileRef[] {
    // Score each tile once, then sort — priority is fixed for the tick, so we
    // avoid recomputing it on every comparison.
    const frontier = this.grid.landFrontierOf(attacker, target);
    if (toward < 0 || frontier.length === 0) {
      const scored = frontier.map((ref) => ({ ref, p: this.tilePriority(attacker, ref) }));
      scored.sort((a, b) => a.p - b.p || a.ref - b.ref);
      return scored.map((s) => s.ref);
    }

    // Directed push: normalise each tile's Euclidean distance to the clicked
    // tile across the frontier, so the side facing the click sorts first. The
    // bias is bounded (< the per-neighbour surround step), so pocket-filling
    // still dominates and the front bulges rather than snakes.
    const tx = this.grid.map.x(toward);
    const ty = this.grid.map.y(toward);
    let minD = Infinity;
    let maxD = -Infinity;
    const dist = frontier.map((ref) => {
      const dx = this.grid.map.x(ref) - tx;
      const dy = this.grid.map.y(ref) - ty;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
      return d;
    });
    const span = maxD - minD || 1;
    const scored = frontier.map((ref, i) => ({
      ref,
      p: this.tilePriority(attacker, ref) + ((dist[i] - minD) / span) * FRONTIER_TOWARD_WEIGHT,
    }));
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
   * Troops a transport ship spends to seize its landing tile. Mirrors OpenFront:
   * a landing pays the **normal** attacker loss for the beachhead tile via the
   * same `attackLogic` as a land capture — there is **no** flat amphibious
   * surcharge. The garrison defends a beachhead exactly as it defends an inland
   * tile (defender strength, density, defense posts, large-empire debuffs all
   * apply), so an opposed landing is only as dear as the ground itself.
   */
  private beachheadCost(ref: TileRef, attacker: PlayerId, target: PlayerId, attackerForce: number): number {
    const defTroops = target === NEUTRAL_PLAYER ? 0 : this.grid.troopsOf(target);
    const defDensity = target === NEUTRAL_PLAYER ? 0 : this.defenderDensityOf(target);
    const largeFactor = target === NEUTRAL_PLAYER
      ? 1
      : largeDefenderLossFactor(this.grid.tileCountOf(target)) *
        largeAttackerLossFactor(this.grid.tileCountOf(attacker));
    return Math.ceil(this.attackerTileLoss(ref, attacker, target, attackerForce, defTroops, defDensity) * largeFactor);
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
      this.grid.addGold(id, GOLD_BASE_PER_TICK);
    }
  }

  /**
   * Advance every transport ship one step along its water route. A ship that
   * reaches its destination disembarks: it captures the landing tile (paying the
   * beachhead cost and bleeding the defender), then commits whatever troops
   * remain as a land attack radiating from the new beachhead. Landings are
   * recorded as {@link SeaCrossing}s for the client to flash.
   */
  /**
   * Spawn a mobile warship the tick its home "warship" structure finishes
   * construction, and despawn one whose home structure is gone (captured, or
   * torn down by {@link fireOn} when the unit itself was sunk) — a warship
   * structure and its mobile unit live and die together, one-to-one.
   */
  private syncWarships(): void {
    const activeHomes = new Set<TileRef>();
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type !== "warship") continue;
      activeHomes.add(ref);
      if (this.warshipByHome.has(ref)) continue;
      const id = this.nextWarshipId++;
      this.warshipByHome.set(ref, id);
      this.warships.push({
        id,
        owner: this.grid.ownerOf(ref),
        homeRef: ref,
        x: this.grid.map.x(ref),
        y: this.grid.map.y(ref),
        hp: WARSHIP_MAX_HP,
        target: null,
        retreating: false,
        shellReadyAt: 0,
      });
    }
    for (const [ref, id] of [...this.warshipByHome]) {
      if (activeHomes.has(ref)) continue;
      this.warshipByHome.delete(ref);
      this.removeWarship(id);
    }
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
   * higher-tier one.
   */
  private pickWarshipTarget(
    w: Warship,
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

    for (const t of this.trade.targetableShips()) {
      if (!isHostile(t.owner)) continue;
      consider("trade", t.id, t.x, t.y);
    }
    return best;
  }

  /**
   * Step `w` one tick's distance toward `(tx, ty)`, snapping exactly onto it
   * once close enough (arriving is always allowed, even at a home tile that
   * itself sits on land — "docking"). An intermediate step that would land on
   * land instead holds position for the tick rather than crossing it: a
   * straight-line course with a basic no-land guard, not full water routing
   * (like transport ships get via {@link TerritoryGrid.findWaterRoute}) — a
   * documented simplification, since a warship's target moves tick to tick
   * and re-pathing a BFS route every tick would be far more expensive.
   */
  private moveWarshipToward(w: Warship, tx: number, ty: number): void {
    const dx = tx - w.x;
    const dy = ty - w.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist === 0) return;
    const step = Math.min(WARSHIP_TILES_PER_TICK, dist);
    const nx = w.x + (dx / dist) * step;
    const ny = w.y + (dy / dist) * step;
    if (step >= dist) {
      w.x = nx;
      w.y = ny;
      return;
    }
    const map = this.grid.map;
    const rx = Math.round(nx);
    const ry = Math.round(ny);
    if (!map.inBounds(rx, ry) || map.isLand(map.ref(rx, ry))) return;
    w.x = nx;
    w.y = ny;
  }

  /**
   * Resolve `w`'s shot at `target`: an enemy transport or trade ship is sunk
   * outright (neither has an HP pool in this engine — a transport's troops are
   * lost with no refund, mirroring the old coast-defence behaviour this
   * replaces); an enemy warship takes {@link WARSHIP_SHELL_DAMAGE} and, if that
   * kills it, its home structure is demolished along with it.
   */
  private fireOn(w: Warship, target: { kind: WarshipTargetKind; id: number }): void {
    if (target.kind === "transport") {
      const idx = this.ships.findIndex((s) => s.id === target.id);
      if (idx !== -1) this.ships.splice(idx, 1);
      return;
    }
    if (target.kind === "trade") {
      this.trade.destroyShip(target.id);
      return;
    }
    const enemy = this.warships.find((x) => x.id === target.id);
    if (!enemy) return;
    enemy.hp -= WARSHIP_SHELL_DAMAGE;
    if (enemy.hp <= 0) {
      this.warshipByHome.delete(enemy.homeRef);
      this.grid.demolishBuilding(enemy.homeRef);
      this.removeWarship(enemy.id);
    }
  }

  /**
   * Advance every mobile warship one tick: sync new/lost units, heal, run the
   * retreat hysteresis, pick (or keep) a target, close the distance, and fire
   * once in range and off cooldown. A destroyed enemy warship's home structure
   * is torn down in the same tick, so its own advance this tick — later in the
   * `[...this.warships]` snapshot — is skipped via the `hp <= 0` guard below.
   */
  private advanceWarships(): void {
    this.syncWarships();
    if (this.warships.length === 0) return;
    const map = this.grid.map;

    for (const w of [...this.warships]) {
      if (w.hp <= 0) continue; // sunk by an earlier warship's shot this tick

      w.hp = Math.min(WARSHIP_MAX_HP, w.hp + WARSHIP_PASSIVE_HEAL_PER_TICK);
      if (w.hp < WARSHIP_RETREAT_HP) w.retreating = true;
      else if (w.hp >= WARSHIP_RETREAT_RECOVER_HP) w.retreating = false;

      if (w.retreating) {
        w.target = null;
        this.moveWarshipToward(w, map.x(w.homeRef), map.y(w.homeRef));
        continue;
      }

      const target = this.pickWarshipTarget(w);
      w.target = target ? { kind: target.kind, id: target.id } : null;
      if (!target) {
        // No hostile in range: hold near home rather than a scripted patrol
        // route — deterministic, and it still reads as "on station" until
        // something worth chasing shows up.
        this.moveWarshipToward(w, map.x(w.homeRef), map.y(w.homeRef));
        continue;
      }

      if (Math.max(Math.abs(target.x - w.x), Math.abs(target.y - w.y)) > WARSHIP_ENGAGE_RANGE) {
        this.moveWarshipToward(w, target.x, target.y);
        continue;
      }
      if (this.tickCount < w.shellReadyAt) continue;
      w.shellReadyAt = this.tickCount + WARSHIP_SHELL_RATE_TICKS;
      this.fireOn(w, target);
    }
  }

  private advanceShips(): void {
    const survivors: TransportShip[] = [];

    for (const ship of this.ships) {
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
        // The beachhead is already ours (captured by land while the ship sailed);
        // the troops simply reinforce the pool.
        this.grid.addTroops(ship.attacker, ship.troops);
        continue;
      }
      if (owner !== NEUTRAL_PLAYER && this.allies.areAllied(ship.attacker, owner)) {
        // The destination became an ally's shore mid-voyage — the landing is
        // called off and the troops disembark home rather than storming a friend.
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

      const cost = this.beachheadCost(dest, ship.attacker, owner, ship.troops);
      if (ship.troops < cost) {
        // Too few troops to force a landing — the assault is repelled. Survivors
        // fall back into the pool, taxed by the retreat malus if they recoiled off
        // a defended (player-held) shore; a failed neutral landing is free.
        this.refundRetreat(ship.attacker, ship.troops, owner);
        continue;
      }

      if (owner !== NEUTRAL_PLAYER) this.grid.addTroops(owner, -this.defenderLossFor(owner));
      this.grid.claim(dest, ship.attacker);
      const remaining = ship.troops - cost;
      if (remaining >= NEUTRAL_CAPTURE_COST) {
        // Push the survivors inland: a land attack against the tile's former
        // owner, expanding from the freshly-taken beachhead.
        const existing = this.attacks.find((a) => a.attacker === ship.attacker && a.target === owner);
        if (existing) existing.committed += remaining;
        // A beachhead's inland push has no clicked target — it radiates outward
        // from the landing tile (undirected).
        else this.attacks.push({ attacker: ship.attacker, target: owner, committed: remaining, anchor: dest, toward: -1 });
      } else {
        this.grid.addTroops(ship.attacker, remaining);
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

      const frontier = this.orderedFrontier(attack.attacker, attack.target, attack.toward);

      // No reachable target tiles: the front is blocked or the target is gone.
      // Pulling back from a player is taxed (retreat malus); neutral is free.
      if (frontier.length === 0) {
        this.refundRetreat(attack.attacker, attack.committed, attack.target);
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

      // Tiles this front may take this tick (OpenFront's `attackTilesPerTick`):
      // it scales with the attacker's troop advantage and the contested border
      // width, so an overwhelming assault rolls fast while an under-committed poke
      // barely creeps. `expansionSpeed` is the attacker's own speed modifier.
      const expansionSpeed = this.grid.modifiersOf(attack.attacker).expansionSpeed;
      // A marked traitor's own assaults advance slower (OpenFront's traitorSpeedDebuff).
      const traitorSpeed = this.isTraitor(attack.attacker) ? TRAITOR_SPEED_DEBUFF : 1;
      const budget = Math.max(
        1,
        Math.round(attackTilesPerTick(defenderTroops, attack.committed, frontier.length, vsPlayer) * expansionSpeed * traitorSpeed),
      );

      let taken = 0;
      for (const ref of frontier) {
        if (taken >= budget) break;
        // A tile may have been captured already if a player relinquished it; skip
        // anything no longer owned by the target.
        if (this.grid.ownerOf(ref) !== attack.target) continue;
        // OpenFront's per-tile attacker loss: the ratio shifts as the assault is
        // spent down, so a front that bleeds out grinds to a halt on the spot.
        const loss = this.attackerTileLoss(ref, attack.attacker, attack.target, attack.committed, defenderTroops, defenderDensity) * largeFactor;
        if (attack.committed < loss) break;

        if (vsPlayer) this.grid.addTroops(attack.target, -defenderBleed);
        this.grid.claim(ref, attack.attacker);
        attack.committed -= loss;
        taken += 1;
      }

      // Decide the attack's fate. Nothing taken means the leading frontier tile
      // was unaffordable — the front is blocked (a retreat that taxes player
      // refunds, and can't stall carrying the same troops forever). Otherwise a
      // sub-1 remainder is returned whole; anything more survives to push on.
      if (taken === 0) {
        this.refundRetreat(attack.attacker, attack.committed, attack.target);
      } else if (attack.committed < NEUTRAL_CAPTURE_COST) {
        this.grid.addTroops(attack.attacker, attack.committed);
      } else {
        survivors.push(attack);
      }
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
