# OpenFront-ähnliche Roadmap: Repository Audit + Gap-Analyse

> **Letztes Update:** 2026-06-29 (OpenFront-Combat-Fidelity: Dichte-Bleed, Prioritäts-Fronten, Retreat-Malus, Defense-Posts, Grenz-Rendering).
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
  Income → Schiffe → Attack-Advance (prioritäts-geordnete Front) → Win-Check**
  (`src/Core/RasterConflict.ts`).
- **Organisches Truppenwachstum** über einen Pool pro Spieler
  (`INCOME_PER_TILE_PER_TICK`, fraktionaler Akkumulator, gedeckelt durch
  `MAX_POOL_PER_TILE × tiles`).
- **Terrain-Kosten:** höhere Elevation und gegnerische Tiles kosten mehr Truppen;
  amphibische Landungen tragen einen `SEA_CROSSING_SURCHARGE`.
- **OpenFront-Combat-Fidelity** (`RasterConflict.ts`, `rasterCombatConfig.ts`):
  - *Dichtebasierter Verteidiger-Verlust:* Bleed = Pool ÷ Territorium (gefloored),
    statt konstant — Überdehnung wird bestraft (`defenderLossPerTile`).
  - *Prioritäts-Frontordnung:* Fronten nehmen leichtes, eingeschlossenes Tiefland
    zuerst (Magnitude + Owned-Neighbour-Bonus + deterministischer Jitter), wachsen
    also organisch statt in Tile-Reihenfolge; das höchstpriorisierte bezahlbare
    Tile wird pro Tick garantiert genommen (kein Front-Deadlock).
  - *Retreat-Malus:* eine an einem Spieler blockierte/abgewehrte Offensive erstattet
    nur 75 % der Resttruppen (`RETREAT_MALUS_FRACTION`); neutraler Rückzug bleibt frei.
  - *Defense-Posts:* jede Hauptstadt befestigt ihr Umland (Capture-Kosten ×bis-zu-
    `DEFENSE_POST_STRENGTH`, linearer Falloff bis `DEFENSE_POST_RADIUS`); fällt die
    Hauptstadt, verschwindet die Aura.
- **Win-Condition:** ein Spieler, der alle eroberbaren Tiles hält, gewinnt;
  `SERVER_RASTER_MATCH_ENDED` wird einmalig gebroadcastet.

### Networking / Multiplayer
- WebSocket + autoritativer Server (`ws`, `src/Server/index.ts`).
- **Solo-Match-Isolation** via `MatchRegistry`: jeder Client bekommt eine eigene
  `RasterGameSession` gegen ein **Feld serverseitiger Bots** (Default 4, FFA;
  konfigurierbar über `RASTER_BOTS`).
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
- **Hand-authored Real-Maps** (`realMaps.ts`): ASCII-Landmasken (World), gleiche
  Finishing-Pipeline (`terrainBuilder.ts`).
- **Heightmap-Maps** (`heightmapMaps.ts` + `pngDecode.ts`): große, reale Karten,
  aus einer committeten Equirectangular-Topografie-PNG (`assets/maps/earth-topo.png`)
  zur gewählten Gridgröße heruntergesampelt — bis OpenFront-Maßstab (~2 Mio.
  Tiles). Gleiche Finishing-Pipeline; Quelle regenerierbar via `scripts/buildMap.ts`.
- **Map-Auswahl** (`mapCatalog.ts`): Spieler wählen ihre Karte pro Run im Menü
  (Earth in drei Größen, World, Procedural); der Server löst die Wahl in
  Session-Optionen auf.
- **Sea-Links** (`seaLinks.ts`): vorberechnete amphibische Adjazenz für schmale
  Gewässer.

### UI / UX
- Canvas 2D, 1 Pixel pro Tile (`rasterPaint.ts`/`rasterPalette.ts`); Pan/Zoom-
  Kamera (`rasterClient.ts`) für große Karten.
- **Nations-Grenzen:** besetzte Rand-Tiles (Nachbar anderen Besitzers) werden als
  aufgehellte Outline der Besitzerfarbe gezeichnet — klare Nationsformen wie in
  OpenFront; Delta-Repaints zeichnen geänderte Tiles **plus Nachbarn** neu.
- Boot-Animationen für amphibische Landungen (`rasterClient.ts`).
- Slider-basierte Attack-UX (% des Pools), Event-Log, Victory-Banner.

### Persistenz / Stats
- Komplett In-Memory, kein Storage-Layer.

### Build / CI
- `npm test` (tsx --test, 141 Unit-Tests), `npm run build`/`lint` (tsc), `npm run dev`.
- **GitHub-Actions-CI** (`.github/workflows/ci.yml`): lint + build + test als PR-Gate.

## 3) Priorisierte Gap-Analyse (offene Punkte)

| Bereich | Status | Priorität |
|---|---|---|
| Spielbare Nationen / Fraktions-Fähigkeiten (Generals-Asymmetrie) | offen | P1 |
| Roguelite-Meta-Loop (Runs, Upgrades zwischen Matches) | offen | P1 |
| Echtes PvP (geteilte Session, Matchmaking, Player-Identity) | offen | P1 |
| Stärkere Bot-KI (Sea-Crossing-Nutzung, Zielpriorisierung) | **erledigt** — strategiebasierte Multi-Bot-KI mit Persönlichkeiten, amphibischer Expansion & Gegner-Priorisierung (`RasterBotController`) | — |
| Schwierigkeits-/Persönlichkeits-Presets als wählbare Lobby-Option | offen | P2 |
| Delta-Snapshots (Owner-Raster nur als Diff senden) | **erledigt** — initialer Full-Snapshot + inkrementelle Owner-Deltas bei niedriger Churn (`encodeOwnerDelta`) | — |
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
2. Geteilte PvP-Session als zweiter `MatchRegistry`-Modus neben Solo.
3. Bot-Persönlichkeit/Anzahl als wählbare Lobby-Option (heute nur via `RASTER_BOTS`).
