import type { TileRef } from "./GameMap.js";
import { NEUTRAL_PLAYER, type PlayerId, type TerritoryGrid } from "./TerritoryGrid.js";
import { NO_ALLIANCES, type AllianceView } from "./alliances.js";
import { GOLD_BASE_PER_TICK, WARSHIP_INTERCEPT_RANGE } from "./buildings.js";
import { RailSystem, type RailView, type TrainView } from "./railSystem.js";
import { TradeSystem, type TradeView } from "./tradeSystem.js";
import {
  attackerLossPerTile,
  attackTilesPerTick,
  defenderLossPerTile,
  defenderStrengthFactor,
  FRONTIER_JITTER_SPAN,
  FRONTIER_MAGNITUDE_WEIGHT,
  FRONTIER_PRIORITY_FLOOR,
  FRONTIER_SURROUND_WEIGHT,
  FRONTIER_TOWARD_WEIGHT,
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
  /** Set once a single player owns every capturable tile, else null. */
  winner: PlayerId | null;
  rejections: Array<{ intent: AttackIntent; reason: AttackRejectReason }>;
  /** Number of attacks still in progress after this tick. */
  activeAttacks: number;
  /** Transport-ship landings that happened this tick (empty on most ticks). */
  crossings: SeaCrossing[];
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
  /** Transport-ship landings resolved during the current tick. */
  private crossings: SeaCrossing[] = [];
  private tickCount = 0;
  private winnerId: PlayerId | null = null;

  constructor(grid: TerritoryGrid, allies: AllianceView = NO_ALLIANCES) {
    this.grid = grid;
    this.allies = allies;
    this.rails = new RailSystem(grid);
    this.trade = new TradeSystem(grid);
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
    return null;
  }

  /** Advance the simulation by one tick. */
  processTick(intents: AttackIntent[] = []): RasterTickResult {
    const rejections: RasterTickResult["rejections"] = [];

    if (this.winnerId !== null) {
      this.tickCount += 1;
      return { tick: this.tickCount, winner: this.winnerId, rejections, activeAttacks: 0, crossings: [] };
    }

    for (const intent of intents) {
      const reason = this.launchAttack(intent);
      if (reason) rejections.push({ intent, reason });
    }

    this.crossings = [];
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
    // Warship coastal batteries sink enemy transports before they advance/land.
    this.interceptTransports();
    this.advanceShips();
    this.advanceAttacks();
    this.checkVictory();

    this.tickCount += 1;
    return {
      tick: this.tickCount,
      winner: this.winnerId,
      rejections,
      activeAttacks: this.attacks.length,
      crossings: this.crossings,
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
    target: PlayerId,
    attackForce: number,
    defenderTroops: number,
    defenderDensity: number,
  ): number {
    const mag = this.tileMagnitude(ref, target);
    return target === NEUTRAL_PLAYER
      ? neutralLossPerTile(mag)
      : attackerLossPerTile(defenderTroops, defenderDensity, attackForce, mag);
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
   * Capture priority of a single frontier tile (lower = taken sooner). Tiles
   * enclosed by more of the attacker's own territory are grabbed first so a front
   * fills its concavities and advances as a smooth, radial bulge rather than
   * snaking outward as a thin tendril — the organic feel of OpenFront's conquest
   * queue. Elevation only gently biases ties between equally-enclosed tiles (the
   * surround term dominates; see the weights in `rasterCombatConfig`). The
   * `jitter` is a deterministic hash of tile and tick (no RNG, so replays stay
   * identical) that scatters captures across otherwise-equal perimeter tiles so
   * the ring grows evenly instead of advancing lopsidedly along one edge.
   */
  private tilePriority(attacker: PlayerId, ref: TileRef): number {
    let ownedNeighbours = 0;
    for (const n of this.grid.map.neighbors(ref)) {
      if (this.grid.ownerOf(n) === attacker) ownedNeighbours += 1;
    }
    const base = Math.max(
      FRONTIER_PRIORITY_FLOOR,
      1 + this.grid.map.magnitude(ref) * FRONTIER_MAGNITUDE_WEIGHT - ownedNeighbours * FRONTIER_SURROUND_WEIGHT,
    );
    // Deterministic [0,1) wobble from a cheap integer hash of (ref, tick).
    const hash = ((ref * 2654435761 + this.tickCount * 40503) >>> 0) / 0x100000000;
    return base * (1 + hash * FRONTIER_JITTER_SPAN);
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
    return Math.ceil(this.attackerTileLoss(ref, target, attackerForce, defTroops, defDensity) * largeFactor);
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
      const cap = maxTroops(tiles, this.grid.activeBuildingCountOf(id, "city")) *
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
   * Sink every enemy transport ship currently within {@link WARSHIP_INTERCEPT_RANGE}
   * (Chebyshev) of a warship not owned by — and not allied to — the ship's owner.
   * A sunk transport's troops are lost outright (no refund): a coast defended by
   * warships turns an unescorted landing into a gamble, the strategic point of a
   * navy. Run before {@link advanceShips} so an interdicted ship dies mid-voyage
   * rather than completing its landing this tick.
   */
  private interceptTransports(): void {
    if (this.ships.length === 0) return;
    const warships: TileRef[] = [];
    for (const [ref, type] of this.grid.activeBuildingEntries()) {
      if (type === "warship") warships.push(ref);
    }
    if (warships.length === 0) return;

    const map = this.grid.map;
    const survivors: TransportShip[] = [];
    for (const ship of this.ships) {
      const tile = ship.path[ship.progress];
      const sx = map.x(tile);
      const sy = map.y(tile);
      let sunk = false;
      for (const w of warships) {
        const owner = this.grid.ownerOf(w);
        if (owner === ship.attacker) continue;
        if (owner !== NEUTRAL_PLAYER && this.allies.areAllied(ship.attacker, owner)) continue;
        if (Math.max(Math.abs(map.x(w) - sx), Math.abs(map.y(w) - sy)) <= WARSHIP_INTERCEPT_RANGE) {
          sunk = true;
          break;
        }
      }
      if (!sunk) survivors.push(ship);
    }
    this.ships.length = 0;
    this.ships.push(...survivors);
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
        const loss = this.attackerTileLoss(ref, attack.target, attack.committed, defenderTroops, defenderDensity) * largeFactor;
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

  /** Declare a winner if a single player owns every capturable tile. */
  private checkVictory(): void {
    if (this.winnerId !== null || this.grid.capturableCount === 0) return;
    for (const id of this.grid.players()) {
      if (this.grid.tileCountOf(id) === this.grid.capturableCount) {
        this.winnerId = id;
        return;
      }
    }
  }
}
