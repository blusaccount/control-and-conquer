# OpenFront-ähnliche Roadmap: Repository Audit + Gap-Analyse

> **Letztes Update:** 2026-06-29 (Economy & Gebäude: Gold als zweite Ressource +
> Bau-Schicht — Städte, Häfen, Forts, Fabriken; auto-verlegte Schienen + Züge).
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
  - *Defense-Posts:* ein **Fort** befestigt sein Umland (Capture-Kosten ×bis-zu-
    `FORT_DEFENSE_STRENGTH`, linearer Falloff bis `FORT_DEFENSE_RADIUS`); wird das
    Tile erobert, verschwindet die Aura. (Es gibt **keine Hauptstadt** mehr — eine
    Nation wird besiegt, indem ihr *gesamtes* Territorium erobert wird, nicht durch
    Fall eines einzelnen Sitzes.)
- **Win-Condition:** ein Spieler, der alle eroberbaren Tiles hält, gewinnt;
  `SERVER_RASTER_MATCH_ENDED` wird einmalig gebroadcastet. Eine Nation ist
  eliminiert, sobald ihr letztes Tile erobert ist (der Eroberer behält das Land).

### Economy & Gebäude (`buildings.ts`, `TerritoryGrid`, `RasterConflict`)
- **Gold als zweite Ressource:** jeder Spieler akkumuliert einen eigenen Gold-Pool
  (`applyGoldIncome`), proportional zum Territorium (`GOLD_PER_TILE_PER_TICK`) plus
  Städte-Dividende — fraktionaler Akkumulator wie bei den Truppen, aber **ungedeckelt**
  (Gold ist eine Ausgabe-Ressource, gesenkt durch Bauwerke).
- **Bau-Schicht** (`CLIENT_RASTER_BUILD` → `RasterGameSession.processBuild`): Gold wird
  auf eigenen Tiles in Strukturen investiert; Kosten skalieren geometrisch je Typ
  (`buildingCost`), sodass Bauwerke knapp bleiben. Vier Typen:
  - **Stadt** 🏛️ — erhöht Gold- *und* Truppen-Einkommen (letzteres weiter durch den
    logistischen Soft-Cap begrenzt, bricht die Pool-Decke also nicht).
  - **Hafen** ⚓ — vergrößert die amphibische Reichweite (`seaRangeOf`, gedeckelt).
  - **Fort** 🛡️ — legt eine Defense-Post-Aura an (Capture-Kosten ↑ im Umkreis).
  - **Fabrik** 🏭 — Katalysator des Schienen-Netzes (s. u.); ohne Fabrik werden keine
    Gleise verlegt.
- **Schienen & Züge** (`railNetwork.ts`, `railSystem.ts`): wie OpenFront verlegt der
  Spieler **keine** Gleise von Hand — eine Fabrik nahe Stadt/Hafen lässt automatisch
  Schienen entstehen. `computeRailNetwork` verdrahtet die eigenen Stationen
  (Fabrik/Stadt/Hafen) deterministisch zu einem Mesh: nur **kardinale** L-Pfade über
  Land, Distanz-/Längen-/Anschluss-Limits (`RAIL_CONNECT_DISTANCE`, `RAIL_MAX_LENGTH`,
  `RAIL_MAX_CONNECTIONS`) wie bei OpenFront (auf unsere Gridgrößen skaliert). `RailSystem`
  lässt **Züge** auf dem Netz fahren (fixe Spawn-Kadenz, kein RNG) und zahlt dem Besitzer
  Gold an jeder Stadt/jedem Hafen aus (`TRAIN_GOLD_PER_STATION`). `RasterConflict` tickt
  das System; Netz + Züge gehen als `rails`/`trains` in den Snapshot und werden im Client
  als Gleis-Polylinien und fahrende Punkte gezeichnet.
- **Bauwerke leben mit ihrem Tile:** wird ein Tile erobert oder neutralisiert, fällt
  die Struktur (und eine Fort-Aura) — der Eroberer erbt nacktes Land (`claim` → `destroyBuilding`).
- **Bots reinvestieren** Gold ab einer Mindestgröße in Städte (`maybeBuildCity`),
  deterministisch wie alle Bot-Entscheidungen.

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
- **Flüsse** (`rivers.ts`, `riverData.ts`): Wie OpenFront gibt es **keinen** eigenen
  Fluss-Terraintyp — Flüsse sind schmale Wasserkanäle. Da die Quell-PNG
  (`earth-topo.png`) reine Topografie ohne Hydrografie ist, werden **echte
  Flussdaten** (Natural Earth River-Centerlines, gemeinfrei) als `[lon,lat]`-
  Polylinien geführt und vor der Finishing-Pipeline als Wasser in die
  Land/Elevation-Maske gestanzt (harter Override des Land-Votes). Da die
  Centerlines die Küsten erreichen, werden ~95 % der Fluss-Tiles per Flood-Fill als
  **Ozean** klassifiziert (navigierbar, Hafen-Reichweite), der Rest als **See** —
  beides wirkt als amphibische Grenze. Deterministisch, projektions-/größen-
  unabhängig. Das committete Asset `assets/maps/earth-rivers.json` (~195 KB, 895
  Polylinien) wird per `scripts/buildRivers.ts` aus der Natural-Earth-GeoJSON
  regeneriert (Quell-GeoJSON nicht committet, wie auch die Topo-Quelle).

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

## 3b) Playtest-Funde (2026-06-29 — gespielte Runde via Chrome, Earth-Standard)

Eine vollständige Runde als normaler Spieler durchgespielt (farbgeführte Grenz-
Expansion + Boote). Beobachtete **Gameplay-/Feel-Lücken** gegenüber openfront.io,
neu gegenüber Abschnitt 3:

| # | Lücke (beobachtet) | Wirkung | Prio |
|---|---|---|---|
| A | **Eliminierung ohne Feedback:** Als meine Hauptstadt fiel (~40 s) hatte ich 0 Tiles/0 Pool und war aus dem Leaderboard, aber das Match lief weiter mit voller Expand-UI und „Playing as Blue Empire" — **kein Defeat-Screen, kein Spectate, kein Zurück-ins-Menü.** Das Stats-Overlay feuert nur beim Gesamt-Matchende, nicht beim Tod des Spielers. | Feel-Breaker: man „stirbt" lautlos und klickt ins Leere. | **P0** |
| B | **Runaway-Ökonomie:** Im Spätspiel hielt Violet 379k+ Truppen (+7838/s) und verschiffte 154k-Truppen-Boote. Income/Truppen wachsen ~exponentiell mit Territorium; die Zahlen werden bedeutungslos. OpenFront bindet Max-Population an Territorium mit abnehmendem Ertrag. | Snowball ist absolut, kein Comeback; Zahlen unlesbar. | **teilw. erledigt** — Truppen-Soft-Cap + **Gold/Bau-Schicht** als zweite, ausgaben-getriebene Achse. |
| C | **Bot-Snowball / Pacing:** Bots expandieren explosiv; ein casual Human ist in ~40 s ausgelöscht, ohne geschützte Anfangsphase oder Schwierigkeitswahl. | Frust für neue Spieler, keine Lernkurve. | **P1** |
| D | **Grenz-Kontrast zu schwach:** Grenzen werden gezeichnet (aufgehellte Outline), lesen sich bei Normalzoom aber eher als Küstenglühen denn als klare Trennlinie Nation-vs-Nation / Nation-vs-Neutral (vgl. OpenFronts knackige Borders). | Karte wirkt „flächig", Fronten schwer ablesbar. | P2 |
| E | **Klick-Feedback nur als Fehlertext:** Einzige Rückmeldung war ein dauerhaftes rotes „Target tile is not capturable land." (Klicks aufs Meer). Kein positives Feedback bei erfolgreicher Expansion (Puls/Ripple/Sound); Wasser-Klicks Richtung Küste werden abgelehnt statt geroutet. | Eingaben fühlen sich unresponsiv an. | P2 |
| F | **Zahlen/Leaderboard-Klarheit:** Zeilen wie „Violet Empire 19595 · 379771 (+7838/s)" — keine Spaltenköpfe, „·" kryptisch, rohe Riesenzahlen ohne k/M-Abkürzung. | Schwer auf einen Blick erfassbar. | P3 |
| G | **Map-Letterboxing:** Auf breiten Earth-Karten große schwarze Balken oben/unten (fit-to-canvas). | Verschenkter Raum, weniger immersiv. | P3 |
| H | **Spawn-Onboarding:** Beim Start ist die eigene (1-Tile-)Hauptstadt kaum auffindbar; Kamera zentriert nicht darauf, kein Hinweis „hier bist du". | Holpriger Einstieg. | P3 |

**Positiv (bereits nah an OpenFront):** reale Küstenlinien + Terrain-Shading,
Wasser-Schimmer, und die neuen mittig in der Masse gehaltenen Nationsnamen wirken
stimmig (siehe Screenshots der Sessions).

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
