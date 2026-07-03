# Control & Conquer

A trusted-base, server-authoritative territorial RTS prototype inspired by
**OpenFront.io** (global tile map, organic border expansion), with the long-term
goal of fusing in **Command & Conquer: Generals** asymmetry (playable nations
with unique abilities) and **Mechabellum**-style roguelite progression.

The current build is the **OpenFront-style foundation**: a deterministic
pixel-raster engine where you start on a single tile and expand your border
across land — and across narrow seas by amphibious landing — until you own the
map. Combat is autonomous: you only express intent (commit N% of your troop pool
toward a tile); the server resolves the front. Diplomacy layers on top:
**alliances** are mutual-consent, non-aggression pacts (propose → accept, break to
betray) — allied nations can't attack each other, and the AI nations weigh
alliances by personality (see `src/Core/alliances.ts`).

## Quick start

```bash
npm install
npm run dev      # tsx watch — serves http://localhost:3000
```

Then open <http://localhost:3000>, **pick a map and a starter class** in the
menu, and drop into a free-for-all against a field of AI opponents.

## Maps

Players choose their map per-run from a shared catalogue (`src/Core/mapCatalog.ts`),
so the menu and the server never drift on the available options:

| Choice | Source | Approx. tiles |
|--------|--------|---------------|
| **Earth — Standard** | `earth` heightmap @ 640 | ~155k |
| **Earth — Large** (default) | `earth` heightmap @ 1280 | ~620k |
| **Earth — Huge** | `earth` heightmap @ 2560 | ~2.5M |

The Earth maps are downsampled from a committed equirectangular topology raster;
the same source scales from a quick game up to an OpenFront-scale world. Each
tier's edge is 1.25× the previous (≈1.56× the area, so "about 50% bigger"), big
enough to host a crowded multi-nation FFA. A seeded procedural generator still
exists server-side as a fallback, but it is intentionally not offered in the
menu; the old small "World — Classic" sketch was retired — it was too cramped
for a readable field of rivals.

`RASTER_MAP` optionally overrides the **default** choice used when a client sends
none — it must name a catalogue id, e.g. `RASTER_MAP=earth-huge npm run dev`.

On large maps, drag to pan and scroll to zoom. Regenerate or replace the
heightmap source with the build tool:

```bash
tsx scripts/buildMap.ts --in <source-heightmap.png> --out earth-topo.png --max-width 2048
```

The AI field is **packed**, like OpenFront (whose default is a flat 400 bots).
It scales with the map to keep OpenFront's density (~1 player per ~1300 tiles):
the Standard map seats ~130 opponents, the larger Earth maps up to the **400**
ceiling, so the world reads as a dense mosaic rather than a sparse handful.
Difficulty tilts the curve — harder games pack more onto the same land. Pick a
fixed count in the menu's **AI opponents** slider (0 = auto-scale), or force one
server-side with `RASTER_BOTS` (max 400), e.g. `RASTER_BOTS=200 npm run dev`.

The field is a **bot-heavy** two-tier mix, exactly like OpenFront's Bot/Nation
split (its default World seats ~400 bots to ~75 nations, ≈1 nation per 5 bots).
About one seat in six is a full-strategy **Nation** — a distinct personality
(land-grabber, warmonger, all-rounder, opportunist, turtle) that expands
deliberately (OpenFront's 45–100-tick decision cadence), allies, reacts with
emoji, and builds toward OpenFront's late game: a train-and-trade economy
(cities, ports, a rail-served factory) that bankrolls border forts, warship
patrols and finally a missile silo — after which it wages nuclear war
(retaliation first, then deterrence) and stands up SAM cover once warheads fly. The rest are passive **Bot** filler —
low-threat, difficulty-flat "tribes" (e.g. "Roman Empire") that grab cheap
neutral land fast (OpenFront's half-price `mag/10` expansion) and, once the map
fills, keep the borders alive by weakly poking a neighbour (`troops/20` at
OpenFront's ~1/3 tribe odds) instead of freezing — never build, always ally.
The result is a living, churning crowd sprinkled with a few real powers.

## Combat model

Combat is autonomous: you only commit N% of your troop pool toward a tile, and
the engine resolves the front. Each tick a front captures border tiles in
priority order; per captured tile the **attacker** spends troops and the
**defender** (if a player) bleeds troops. The per-tile attacker cost is:

```
cost = base · terrain · attackerEfficiency · garrisonFactor · fortifications
```

- **base** — flat neutral (wilderness) land is cheap; an enemy-held tile is dearer.
- **terrain** — plains / highland / mountain bands (higher ground is mildly dearer).
- **attackerEfficiency** — a flat ~20% bonus favouring the attacker.
- **garrisonFactor** — the clamped ratio of the **defender's** troops to the
  attacking force. A well-garrisoned nation makes every tile far costlier, so an
  under-committed poke stalls and is repelled — holding troops (and border forts)
  is your defence. Attacking on multiple fronts dilutes the garrison's strength
  across them, so a coordinated pincer cracks a defence a single front can't.
- **fortifications** — forts / defense posts raise the cost in an aura.

The defender's per-tile loss is density-based (its pool spread over its
territory), and a front advances faster the bigger the attacker's troop
advantage. These mechanics are an **independent, clean-room reimplementation
inspired by the publicly documented behaviour of [OpenFront.io](https://openfront.io)**.
This project contains no OpenFront source code or assets, is not affiliated with
or endorsed by OpenFront, and reproduces only the (uncopyrightable) game rules —
keeping the project freely licensable.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Run the server with hot reload (`tsx watch`). |
| `npm run build` | Compile TypeScript to `dist/` (`tsc`). |
| `npm start` | Run the compiled server from `dist/`. |
| `npm run lint` | Type-check without emitting (`tsc --noEmit`). |
| `npm test` | Run the unit-test suite (`tsx --test`). |

The client is shipped as ES modules from `dist/` under `/assets/`, so build
before `npm start` in production.

## Architecture

Server-authoritative. The server holds the master state and ticks a fixed-step
simulation (10 TPS, OpenFront's rate); the client renders snapshots and sends
intent-only commands.

```
Browser (Canvas 2D)  ──WebSocket──►  Node + ws
  src/Client/                          src/Server/   MatchRegistry → RasterGameSession (+ bot)
                                       src/Core/     GameMap · TerritoryGrid · RasterConflict
```

- **`src/Core/`** — deterministic simulation engine. No `Server`/`Client`
  imports, no `Math.random`/`Date.now` in the sim path. Terrain is a 1-byte-per-
  tile raster (`terrainCodec`), generated from a seed (`terrainGenerator`) or a
  hand-authored ASCII map (`realMaps`). Ownership, troop **and gold** pools live
  in `TerritoryGrid`; the tick logic lives in `RasterConflict`. A second economy
  axis layers on top: gold accrues from territory and is spent on **buildings**
  (cities, ports, forts — see `buildings.ts`) that boost income, sea reach or
  defence.
- **`src/Server/`** — WebSocket server, fixed-step scheduler, per-client solo
  matches against a server-side bot, command validation, snapshot serialization.
  Large real-world maps are decoded from a heightmap PNG (`pngDecode`) and
  downsampled to the configured grid (`heightmapMaps`) through the same
  `buildTerrainFromMask` finishing pass as every other map. Ownership is shipped
  as a full raster on the first snapshot and as compact per-tile **deltas**
  thereafter, so per-tick bandwidth scales with the churn at the front rather
  than with the (million-tile) map size.
- **`src/Client/`** — WebSocket client, canvas raster renderer, click-to-expand,
  boat animations for amphibious crossings.

See [`docs/`](docs/) for the tick model, multiplayer authority design, and the
OpenFront gap analysis / roadmap.

## Status

Early prototype. Solo-vs-bots only (no human-vs-human yet); state is in-memory; the faction/nation and
roguelite layers are designed but not yet implemented. See
[`docs/openfront-gap-analysis.md`](docs/openfront-gap-analysis.md) for the
prioritized roadmap.

## License

Proprietary — see [`LICENSE`](LICENSE). This project is an independent,
clean-room reimplementation of certain OpenFront.io gameplay mechanics (game
rules and numeric formulas are not copyrightable); no OpenFront source code or
assets are used. See
[`docs/openfront-balance-replication-plan.md`](docs/openfront-balance-replication-plan.md#0-methodik--lizenz-grenze-wichtig)
for the clean-room methodology.
