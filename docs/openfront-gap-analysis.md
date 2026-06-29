# OpenFront-ähnliche Roadmap: Repository Audit + Gap-Analyse

> **Letztes Update:** 2026-06-29 (Refactoring-Review: Raster-Engine).
> Dieses Dokument spiegelt den Ist-Zustand auf `main` nach dem Umbau auf die
> Pixel-Raster-Engine (commit „Rebuild as OpenFront-style raster game"). Die
> ältere Polygon-/`MapState`-Engine existiert nicht mehr.

## 1) Zielbild (Referenz: openfront.io + Roguelite + Generals-Asymmetrie)
- Pixel-Raster-Karte: Spieler starten auf einem Tile und expandieren über
  4-Nachbarschaft (Land) sowie amphibische Übersetzungen über schmale Seen.
- **Organisches Truppenwachstum** pro Tile pro Tick (keine manuelle Wirtschaft).
- **One-Click-Angriff:** Klick auf ein Ziel-Tile → Front wächst dorthin.
- **Deterministischer Server**, Client rendert nur.
- **Kein Spielereingriff im Kampf** — Fronten lösen sich autonom auf.
- Geplant: spielbare Nationen mit einzigartigen Fähigkeiten, Roguelite-Meta.

## 2) Aktueller Stand (Ist-Zustand)

### Gameplay-Loop
- Deterministischer Server-Tick bei 20 TPS (`src/Server/index.ts`,
  `simulationConfig.ts`).
- `RasterConflict.processTick()` führt pro Tick aus: **Intent-Registrierung →
  Income → Attack-Advance (BFS-Ring) → Win-Check** (`src/Core/RasterConflict.ts`).
- **Organisches Truppenwachstum** über einen Pool pro Spieler
  (`INCOME_PER_TILE_PER_TICK`, fraktionaler Akkumulator, gedeckelt durch
  `MAX_POOL_PER_TILE × tiles`).
- **Terrain-Kosten:** höhere Elevation und gegnerische Tiles kosten mehr Truppen;
  amphibische Landungen tragen einen `SEA_CROSSING_SURCHARGE`.
- **Win-Condition:** ein Spieler, der alle eroberbaren Tiles hält, gewinnt;
  `SERVER_RASTER_MATCH_ENDED` wird einmalig gebroadcastet.

### Networking / Multiplayer
- WebSocket + autoritativer Server (`ws`, `src/Server/index.ts`).
- **Solo-Match-Isolation** via `MatchRegistry`: jeder Client bekommt eine eigene
  `RasterGameSession` gegen einen serverseitigen Bot.
- Diskriminierte ServerMessage-Union (`SERVER_RASTER_PLAYER_ASSIGNED`,
  `SERVER_RASTER_SNAPSHOT`, `SERVER_RASTER_ACTION_REJECTED`,
  `SERVER_RASTER_MATCH_ENDED`).
- Strikte Runtime-Validation eingehender Commands (`validateCommand.ts`) +
  Business-Rules in `RasterGameSession.validateAndBuildIntent`.
- Terrain wird nur einmal pro Client gesendet (Cache-Key `terrainHash`); danach
  nur das Owner-Raster.
- Drift-Detection, Slow-Tick-Warnung, Catch-up-Cap im Scheduler.

### Map / Terrain
- **1-Byte-pro-Tile-Codec** (`terrainCodec.ts`): Land/Wasser, Küste, Ozean-vs-See,
  5-Bit-Magnitude (Elevation bzw. Wassertiefe, 31 = impassable Fels).
- **Prozeduraler Generator** (`terrainGenerator.ts`): seed-deterministisches
  Fractal-Value-Noise → Land/Wasser-Maske → Speckle-Cleanup → Finishing-Pipeline.
- **Hand-authored Real-Maps** (`realMaps.ts`): ASCII-Landmasken (Mediterranean,
  World), gleiche Finishing-Pipeline (`terrainBuilder.ts`).
- **Sea-Links** (`seaLinks.ts`): vorberechnete amphibische Adjazenz für schmale
  Gewässer.

### UI / UX
- Canvas 2D, 1 Pixel pro Tile (`rasterPaint.ts`/`rasterPalette.ts`), hochskaliert.
- Boot-Animationen für amphibische Landungen (`rasterClient.ts`).
- Slider-basierte Attack-UX (% des Pools), Event-Log, Victory-Banner.

### Persistenz / Stats
- Komplett In-Memory, kein Storage-Layer.

### Build / CI
- `npm test` (tsx --test, 76 Unit-Tests), `npm run build`/`lint` (tsc), `npm run dev`.
- **GitHub-Actions-CI** (`.github/workflows/ci.yml`): lint + build + test als PR-Gate.

## 3) Priorisierte Gap-Analyse (offene Punkte)

| Bereich | Status | Priorität |
|---|---|---|
| Spielbare Nationen / Fraktions-Fähigkeiten (Generals-Asymmetrie) | offen | P1 |
| Roguelite-Meta-Loop (Runs, Upgrades zwischen Matches) | offen | P1 |
| Echtes PvP (geteilte Session, Matchmaking, Player-Identity) | offen | P1 |
| Stärkere Bot-KI (Sea-Crossing-Nutzung, Zielpriorisierung) | offen | P2 |
| Delta-Snapshots (Owner-Raster nur als Diff senden) | offen | P2 |
| Reconnect/Resync-Protokoll | offen | P2 |
| Persistenz für Match-Resultate / Progression | offen | P2 |
| Lobby-/Menü-UI über „Play vs Bot" hinaus | offen | P3 |

## 4) Architektur (Ist)

```
┌───────────────┐   WS    ┌────────────────────────────┐
│  Browser      │ ◄─────► │  Node.js + ws (Server/)     │
│  Canvas 2D    │         │  ┌──────────────────────┐   │
│  Client/      │         │  │ MatchRegistry        │   │
└───────────────┘         │  └──────────┬───────────┘   │
                          │             │ 1:1 (solo)     │
                          │  ┌──────────▼───────────┐    │
                          │  │ RasterGameSession    │    │
                          │  │  + RasterBotController│   │
                          │  └──────────┬───────────┘    │
                          │             │ owns           │
                          │  ┌──────────▼───────────┐    │
                          │  │ Core/                │    │
                          │  │  GameMap (terrain)   │    │
                          │  │  TerritoryGrid (owner)│   │
                          │  │  RasterConflict (sim)│    │
                          │  └──────────────────────┘    │
                          └────────────────────────────┘
```

## 5) Layering-Regeln
- `src/Core/` darf **nicht** auf `src/Server/` oder `src/Client/` zugreifen.
- Game-Mechanik-Konstanten leben in `src/Core/rasterCombatConfig.ts`.
- Server-Scheduling lebt in `src/Server/simulationConfig.ts`.
- Tests dürfen aus allen `src/`-Ebenen importieren.

## 6) Nächste konkret kleine Schritte
1. Fraktions-Datenmodell (Nation → Modifikatoren auf Income/Capture-Kosten).
2. Sea-Crossing-Nutzung in der Bot-KI (heute nur Land-Frontier).
3. Delta-Owner-Snapshots als Bandbreiten-Optimierung ab größeren Karten.
4. Geteilte PvP-Session als zweiter `MatchRegistry`-Modus neben Solo.
