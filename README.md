# Control & Conquer

A trusted-base, server-authoritative territorial RTS prototype inspired by
**OpenFront.io** (global tile map, organic border expansion), with the long-term
goal of fusing in **Command & Conquer: Generals** asymmetry (playable nations
with unique abilities) and **Mechabellum**-style roguelite progression.

The current build is the **OpenFront-style foundation**: a deterministic
pixel-raster engine where you start on a single tile and expand your border
across land — and across narrow seas by amphibious landing — until you own the
map. Combat is autonomous: you only express intent (commit N% of your troop pool
toward a tile); the server resolves the front.

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
| **Earth — Standard** | `earth` heightmap @ 512 | ~100k |
| **Earth — Large** (default) | `earth` heightmap @ 1024 | ~400k |
| **Earth — Huge** | `earth` heightmap @ 2048 | ~1.6M |
| **World — Classic** | `world` ASCII map | ~2.6k |
| **Procedural** | seeded terrain generator | ~40k |

The Earth maps are downsampled from a committed equirectangular topology raster;
the same source scales from a quick game up to an OpenFront-scale world. World is
a small stylised six-continent sketch, and Procedural rolls a fresh continent.

`RASTER_MAP` optionally overrides the **default** choice used when a client sends
none — it must name a catalogue id, e.g. `RASTER_MAP=earth-huge npm run dev`.

On large maps, drag to pan and scroll to zoom. Regenerate or replace the
heightmap source with the build tool:

```bash
tsx scripts/buildMap.ts --in <source-heightmap.png> --out earth-topo.png --max-width 2048
```

The size of the AI field **scales with the map**: the tiny World — Classic
sketch stays a readable handful, while the large Earth maps fill up with many
more rival nations (up to 31), so bigger worlds feel crowded rather than empty.
Difficulty shifts the whole curve — harder games pack a denser, more aggressive
field onto the same land. Set a fixed count instead with `RASTER_BOTS` (max 31),
e.g. `RASTER_BOTS=12 npm run dev`, which overrides the per-map scaling.

Each bot is seated with a distinct personality (land-grabber, warmonger,
all-rounder, opportunist, turtle) and plays a strategic game: it races for cheap
neutral land to compound its income, strikes the weakest rival it can beat, and
uses amphibious crossings to attack across narrow seas.

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
simulation (20 TPS); the client renders snapshots and sends intent-only commands.

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
