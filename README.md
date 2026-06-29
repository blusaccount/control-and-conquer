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

Then open <http://localhost:3000> and click **Play vs Bot** to drop into a
free-for-all against a field of AI opponents.

Select the active real-world map with the `RASTER_MAP` env var
(`mediterranean` (default) or `world`), e.g. `RASTER_MAP=world npm run dev`.

Set the number of AI opponents with `RASTER_BOTS` (default 4, max 5), e.g.
`RASTER_BOTS=5 npm run dev`. Each bot is seated with a distinct personality
(land-grabber, warmonger, all-rounder, opportunist, turtle) and plays a
strategic game: it races for cheap neutral land to compound its income, strikes
the weakest rival it can beat, and uses amphibious crossings to attack across
narrow seas.

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
  hand-authored ASCII map (`realMaps`). Ownership and troop pools live in
  `TerritoryGrid`; the tick logic lives in `RasterConflict`.
- **`src/Server/`** — WebSocket server, fixed-step scheduler, per-client solo
  matches against a server-side bot, command validation, snapshot serialization.
- **`src/Client/`** — WebSocket client, canvas raster renderer, click-to-expand,
  boat animations for amphibious crossings.

See [`docs/`](docs/) for the tick model, multiplayer authority design, and the
OpenFront gap analysis / roadmap.

## Status

Early prototype. Solo-vs-bots only (no human-vs-human yet); state is in-memory; the faction/nation and
roguelite layers are designed but not yet implemented. See
[`docs/openfront-gap-analysis.md`](docs/openfront-gap-analysis.md) for the
prioritized roadmap.
