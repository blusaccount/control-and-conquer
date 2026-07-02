# OpenFront.io 1:1 nachbauen — Balancing-, Platzierungs-, UI- & Visualisierungsplan

> **Erstellt:** 2026-06-30. Ziel: das **Balancing und die Spielgefühl-Schicht von
> openfront.io so genau wie möglich nachahmen** — Truppen/Population, Land-Kampf,
> Gebäude, Schiffe, Infrastruktur (Schienen/Züge), Wasser, Terrain, Bot-/Nationen-
> Feld, Spawn-Phase, In-Game-UI + Steuerung und die Map-Visualisierung
> (Gebäude, Straßen/Gleise, Schiffe, Züge).
>
> Ergänzt `openfront-gap-analysis.md` (Ist-Zustand) um einen **konkreten,
> wertgenauen Umbauplan**. Alle OpenFront-Zahlen unten stammen quellenecht aus
> dem Live-`main`-Branch (Stand der Recherche), primär aus
> `src/core/configuration/Config.ts` (die `DefaultConfig`-Klasse — der alte Pfad
> `DefaultConfig.ts` existiert nicht mehr), plus `src/core/execution/*.ts`,
> `src/core/game/*.ts` und `src/client/hud|render/*`.

## Umsetzungsstand (2026-06-30)

| Phase | Status |
|---|---|
| **P0 — Maßstab & Takt** (10 TPS, Start 25 000, `maxTroops`/`troopGrowth`, Glockenkurve, City→+250k Cap) | ✅ **umgesetzt & getestet** |
| **P1 — Land-Kampf-Port** (`attackLogic`: mag/speed 80·100·120, Verlust-Blend, `attackTilesPerTick`, emergente Mehrfront-Verdünnung, Terrain-Bänder 9/19) | ✅ **umgesetzt & getestet** |
| **P2 — Gebäude/Gold/Defense-Post/Platzierung** (City/Port/Factory `2^n·125k` Cap 1M; Fort `(n+1)·50k` Cap 250k; flaches Gold-Base + skalierte Dividenden; Fort Stärke 5/Radius 30; Port nur Küste; `structureMinDist 15`) | ✅ **umgesetzt & getestet** |
| **P3 — Trade-Schiffe + Warships** (Trade: Port→Port-Gold-Sigmoid, beide Häfen kassieren, Flotten-Cap; Warship: küstengebundene Struktur versenkt feindliche Transporter in Reichweite) | ✅ **umgesetzt & getestet** · mobile Warship-Jagd auf Trade, Boote-`floor(troops/5)` noch offen |
| **P3b — Nukes, Tier 1** (Missile Silo 1M flach, Cooldown 90 Ticks, Bauzeit 100 Ticks; Atom Bomb 750k, Radius 15/40 (100 % / 50 %-Chance), Truppen-Verlust proportional zur zerstörten Landfläche; nukt man einen Verbündeten bricht das Bündnis + Verräter-Debuff) | ✅ **Atom Bomb umgesetzt & getestet** · Hydrogen Bomb, MIRV, SAM-Abfang noch offen; zerstörtes Land wird neutral statt (wie im Original) zu Wasser — Terrain ist in dieser Engine nach der Generierung unveränderlich, siehe `src/Core/nukes.ts` |
| **P4 — Spawn-Immunität** (geschütztes Eröffnungsfenster `SPAWN_IMMUNITY_SECONDS`, Angriffe/Boote auf immune Nationen abgewiesen) | ✅ **umgesetzt & getestet** · Bot/Nation-Split ✅, Radial-Menü ✅, Hotkey-Parität ✅ (siehe Update 2026-07-02 unten) · übrige Visualisierung (WebGL-Look-Feinschliff) noch offen |

> **Update (Ökonomie-Angleichung):** Gold ist jetzt **flach wie OpenFront** —
> `goldAdditionRate` = 100/Tick, **unabhängig** von Tiles/Städten/Häfen. Städte
> geben **0 Gold** (nur Pop-Cap), Häfen geben **0 Pauschal-Gold** (nur Trade).
> Dazu das **Eroberungs-Bounty** (`conquerGoldAmount`): Sieger erbt das Gold einer
> besiegten Nation (KI 100 %, Mensch 50 %). Truppen-Wachstumsformel war seit P0
> schon exakt. Damit deckt sich Ökonomie **und** Population/Wachstum wertgenau mit
> OpenFront. **Bot/Nation-Schwierigkeits-Skalierung jetzt ebenfalls drin:** KI
> nimmt OpenFronts Nations-Handicaps je Stufe — Start 12 500/18 750/25 000,
> Pop-Cap ×0.5/0.75/1.0, Wachstum ×0.9/0.95/1.0 (leicht/mittel/schwer); der
> Mensch spielt immer auf voller Stärke.

Der **Balancing-Kern** (Truppen/Population, Land-Kampf, Wirtschaft/Gebäude) ist
damit wertgenau auf OpenFront umgestellt; 238 Unit-Tests grün. P3/P4 sind als
eigenständige Folge-PRs vorgesehen, weil sie neue Systeme (Trade/Warship/Nukes)
bzw. die UI-/Render-Schicht betreffen und nicht ungetestet eingeschoben werden
sollten.

> **Update (2026-07-02 — frischer Quellcode-Abgleich):** siehe
> `openfront-gap-analysis.md` §3c für den Detail-Abgleich gegen den aktuellen
> `openfrontio/OpenFrontIO`-main-Branch (Tag v0.32.6). Kurzfassung der neuen
> Funde mit Bezug zu diesem Plan: (1) **SAM Launcher/Hydrogen Bomb/MIRV** —
> **erledigt**, siehe §3c #3 im Gap-Analysis-Dokument; (2)
> **Zug-Tempo** ist mit `TRAIN_TILES_PER_TICK=3` (`buildings.ts:240`) 50 % zu
> schnell — OpenFronts `speed:2` (§2.6) noch nicht exakt umgesetzt, einfacher
> Fix, weiterhin offen; (3) **Bot/Nation-Zweiklassen-KI** (§2.9, „zwei
> getrennte KI-Typen") — **erledigt**: jeder dritte KI-Sitz ist jetzt ein
> passiver Bot-Filler (flache OpenFront-Tribe-Zahlen, baut nichts, nimmt jede
> Allianz an) mit eigenem Zwei-Wort-Namensgenerator, der Rest bleibt volle
> Nation-KI mit den 5 Persönlichkeiten — weiterhin ohne Slider-Konfigurierbarkeit
> (Feldgröße bleibt kartenskaliert); (4) Schwierigkeit **„Impossible"** (§2.9)
> fehlt als vierte Stufe; (5) tote, irreführende Konstanten
> `DEFENSE_POST_RADIUS`/`DEFENSE_POST_STRENGTH` in
> `rasterCombatConfig.ts` (nie benutzt — Forts nutzen korrekt
> `FORT_DEFENSE_RADIUS`/`STRENGTH` aus `buildings.ts`) sollten aufgeräumt
> werden. Phase 4 (UI/Radial-Menü/Hotkeys/Karten-Katalog) bleibt der größte
> offene Block fürs Look-and-Feel-Ziel dieses Plans.

## 0) Methodik & Lizenz-Grenze (wichtig)

OpenFront ist **AGPL-3.0**. Wie bisher (siehe Kommentar-Header in
`rasterCombatConfig.ts`) bleibt dieses Projekt eine **Clean-Room-Reimplementierung**:

- **Zahlen-Konstanten und Formel-*Formen* sind Fakten** (Spielregeln, nicht
  urheberrechtlich geschützt) — die dürfen wir 1:1 übernehmen und dokumentieren.
- **Kein Quelltext und keine Art-Assets** von OpenFront werden kopiert. Icons
  bleiben eigene Emoji/SVGs; Layout/Steuerung werden funktional nachgebaut, nicht
  als Pixel-Kopie.
- So bleibt das Projekt frei (re-)lizensierbar.

**Quellen-Notiz zur Genauigkeit:** Werte aus der Source (Config.ts/Execution)
gelten als autoritativ. Das Miraheze-Wiki war während der Recherche durchgängig
nicht erreichbar (503); Community-Guides (openfrontpro.com, openfront.fyi) wurden
nur als Bestätigung benutzt und sind teils veraltet (v. a. Hotkeys).

---

## 1) Grundsatz-Entscheidungen (zuerst klären — sie tragen den ganzen Plan)

Diese drei Entscheidungen bestimmen, ob wir *exakt* nachbauen oder nur die
Formel-Formen treffen. Empfehlung jeweils **fett**.

| # | Entscheidung | OpenFront | C&C heute | Empfehlung |
|---|---|---|---|---|
| E1 | **Tickrate** | 10 TPS (`msPerTick = 100`) | 20 TPS | **Auf 10 TPS gehen.** Dann übertragen sich *alle* Pro-Tick-Konstanten direkt, ohne Umrechnung. (Alternativ 20 TPS behalten und jede Pro-Tick-Rate halbieren — fehleranfällig.) |
| E2 | **Zahlen-Maßstab** | groß: Start 25 000 Truppen, Max-Pop 10⁵–10⁶, Gold/Bau in 10⁵–10⁷ | klein: Start 50, Pool `tiles×50`, Gold zweistellig | **Den großen OF-Maßstab komplett übernehmen.** Halbe Maßstäbe brechen den Verbund (Bau-Kosten, Trade-Gold, Max-Pop hängen zusammen). Client formatiert mit `k`/`M` (deckt auch Playtest-Fund F ab). |
| E3 | **Kampf-Modell** | *Verlust + Tiles-pro-Tick* (`attackLogic` + `attackTilesPerTick`) | *Kosten-Budget* (`captureCost` + `EXPANSION_SPEND_FRACTION`) | **`advanceAttacks` auf das OF-Modell umbauen** (siehe §4). Nur Konstanten-Tuning trifft das Gefühl nicht „genau". |

> Der Rest des Plans ist unter der Annahme **E1=10 TPS, E2=OF-Maßstab,
> E3=Formel-Port** geschrieben. Will man kleiner/sanfter starten, sind die
> meisten Phasen einzeln auch im alten Maßstab umsetzbar — dann aber „im Stil von"
> statt „exakt wie" OpenFront.

---

## 2) Referenz: OpenFront-Ist-Werte (quellenecht)

Hilfsfunktionen (Util.ts): `within(v,min,max)=clamp`; `sigmoid(v,k,mid)=1/(1+e^(−k(v−mid)))`.

### 2.1 Truppen / Population (ein einziger `troops`-Pool — **kein** Worker/Truppen-Split, **kein** `troopAdjustmentRate`; das ist veraltetes Community-Wissen)
```
msPerTick               = 100            # 10 Ticks/s
startManpower           = Mensch 25 000 | Bot 10 000 | Nation E/M/H/I 12 500/18 750/25 000/31 250
maxTroops               = 2·(tiles^0.6·1000 + 50 000) + Σ city.level·250 000
                          Bot: /3   Nation: ×0.5/0.75/1.0/1.25 (E/M/H/I)
growth (toAdd je Tick)  = (10 + troops^0.73 / 4) · (1 − troops/maxTroops)
                          Bot: ×0.5   Nation: ×0.9/0.95/1.0/1.05
cityTroopIncrease       = 250 000 je City-Level (geht in maxTroops, NICHT als Einkommen)
```
Wachstum ist eine **Glockenkurve**: Peak bei mittlerem Füllstand, → 0 am Cap.

### 2.2 Land-Kampf (`attackLogic` / `attackTilesPerTick`, Config.ts)
```
Terrain          mag   speed
  Plains          80   16.5
  Highland       100   20
  Mountain       120   25
  Impassable     → wirft Fehler (nicht angreifbar)

attackAmount (Default-Commit) = troops/5 (20 %)   | Bot: troops/20 (5 %)   | Slider 1–100 %

# Gegen SPIELER:
defenderTroopLoss   = defender.troops / defender.numTiles            # Dichte
attackerTroopLoss   = 0.6·[ within(def/atk, 0.6, 2) · mag · 0.8 · debuffs ]
                    + 0.4·[ 1.3 · defenderTroopLoss · mag/100 ]
tilesPerTickUsed    = within(def.troops/(5·atk), 0.2, 1.5) · speed · debuffs
attackTilesPerTick  = within((5·atk/def.troops)·2, 0.01, 0.5) · grenzTiles · 3

# Gegen NEUTRAL (TerraNullius):
attackerTroopLoss   = mag/5  (Mensch)  | mag/10 (Bot)   → 16/20/24 Truppen je Tile
defenderTroopLoss   = 0
attackTilesPerTick  = grenzTiles · 2
tilesPerTickUsed    = within(2000·max(10,speed)/atk, 5, 100)

# Tile-Aufnahme-Reihenfolge (Min-Heap, niedrig=zuerst):
priority = (rand0..7 + 10)·(1 − eigeneNachbarn·0.5 + mag/2) + tick
           # mag-Gewicht: Plains 1, Highland 1.5, Mountain 2 → Flachland zuerst

malusForRetreat = 25 %   (gegen Spieler; gegen Neutral 0)

# Groß-Reich-Dämpfer (nur gegen Spieler):
defenseSig            = 1 − sigmoid(def.numTiles, ln2/50 000, 150 000)
largeDefender*Debuff  = 0.7 + 0.3·defenseSig          # Verteidiger-Bonus mit Größe
# Angreifer >100 000 Tiles:
largeAttackBonus      = sqrt(100 000/atkTiles)^0.7
largeAttackerSpeed    = (100 000/atkTiles)^0.6
# Bot-Verteidiger: mag ×0.7 | Verräter: defense ×0.5, speed ×0.8
# Fallout-Tile: mag & speed × (5 − falloutRatio·2)  [2.5..5]
```

### 2.3 Verteidigungsposten (Defense Post)
```
cost                 = min(250 000, (n+1)·50 000)        # 50k,100k,…,Cap 250k (linear)
defensePostRange     = 30 Tiles  (binär „in Reichweite", KEIN linearer Falloff)
defensePostDefenseBonus = 5   → mag ×5  (Angreiferverlust ×5)
defensePostSpeedBonus   = 3   → speed ×3 (verlangsamt Angriff)
# zusätzlich Geschütz: shellAttackRate 100, targettingRange 75, Shell-Schaden 250
```

### 2.4 Gebäude — Kosten, Effekt, Bauzeit & Platzierung
```
# Kosten (costWrapper: n = bereits gebaute des Typs; geteilte Zähler beachten)
City        = min(1 000 000, 2^n · 125 000)      # verdoppelt; +250k maxTroops/Level; Bahnstation
Port        = min(1 000 000, 2^n · 125 000)      # ZÄHLER GETEILT mit Factory; Trade+Warship+Station
Factory     = min(1 000 000, 2^n · 125 000)      # Zähler geteilt mit Port; Bahnstation/Zug-Spawn
DefensePost = min(  250 000, (n+1)· 50 000)
MissileSilo = 1 000 000 (flach);  SiloCooldown 90 Ticks
SAMLauncher = min(3 000 000, (n+1)·1 500 000);  SAMCooldown 90 Ticks; samRange 70..150
Warship     = min(1 000 000, (n+1)· 250 000);  maxHealth 1000
AtomBomb 750k · HydrogenBomb 5M · MIRV 25M + n·15M

# Bauzeit (Ticks):  City 20 · Factory 20 · Port 50 · DefensePost 50 · MissileSilo 100 · SAM 300
# Platzierungs-Regeln (PlayerImpl.canBuild → validStructureSpawnTiles):
structureMinDist   = 15      # Mindestabstand² zu jedem anderen Bauwerk
radiusPortSpawn    = 20      # Port snappt auf nächstes EIGENES Küsten-(Shore-)Tile
# alle Landbauten: nur auf eigenem Land; Auto-Snap aufs nächste gültige Tile;
# canBuild liefert das Ziel-Tile (oder false) → Ghost-Vorschau am Cursor
```

### 2.5 Gold-Ökonomie
```
passives Gold        = flach 100/Tick (Mensch) | 50/Tick (Bot) · goldMultiplier
                       # NICHT pro Tile/Worker — Haupt-Gold kommt aus Trade & Zügen
tradeShipGold(dist)  = 75 000/(1+e^(−0.03·(dist−300))) + 50·dist     # dist = gereiste Tiles
  tradeShipShortRangeDebuff = 300   # kurze Routen stark bestraft
  Auszahlung: BEIDE Häfen (Quelle + Ziel) erhalten den VOLLEN Betrag
  Trade-Schiff kaperbar → Käufer bekommt das Gold
trainGold(je Stadt)  = ally 35 000 | team/other 25 000 | self 10 000
  erste 10 Städte ohne Abzug, danach −5 000/Stadt, Boden 5 000
trainSpawnRate       = (numFactories+10)·15   (Spawn-Chance 1/rate, je Stationslevel)
tradeShipSpawnRate   = floor(100·1/(rejections+1) / (1 − sigmoid(numTradeShips, ln2/50, 400)))
```

### 2.6 Schienen / Züge (auto-verlegt, kein Handbau)
```
trainStationMinRange = 15    trainStationMaxRange = 110
railroadMaxSize      = 110·√2 ≈ 155.6   (max. Gleis-Länge)
Stationen            = City | Port | Factory; Factory ist Katalysator
Routing              = A* nur kardinal (4-Nachbarn); directionChangePenalty 3 (gerade Linien);
                       waterPenalty 5 (Gleise nur als kurze Shore-zu-Shore-Brücken)
Zug                  = Lok + Schluss-Lok + N Waggons; speed 2, spacing 2; folgt der Gleis-Polylinie
```

### 2.7 Schiffe & Wasser
```
TransportShip  cost 0; trägt floor(troops/5); max 3 gleichzeitig; 1 Tile/Tick; Retreat 25 %
               KEINE Pauschal-Landungsgebühr — Landung läuft über normale attackLogic
Warship        cost min(1M,(n+1)·250k); HP 1000; patrol 100; target 130; shellRate 20;
               Shell 250 Schaden; passiveHeal 1/Tick; Rückzug bei HP<750; Ziele: Transport>Warship>Trade
TradeShip      cost 0; Port→Port; kaperbar/zerstörbar; 1 Tile/Tick
Wasser         OCEAN_BIT vs See (Wasser ∧ ¬Ozean); Boot-Reichweite über
               Wasser-Komponenten-Konnektivität (KEIN Distanz-Cap); Seen sind isoliert
```

### 2.8 Terrain & Karte
```
Terrain-Byte:  IS_LAND_BIT 7 · SHORELINE_BIT 6 · OCEAN_BIT 5 · MAGNITUDE 0x1f (0..31)
Bänder:        Plains 0..9 · Highland 10..19 · Mountain 20..30 · Impassable 31 (nur Land)
               Impassable: nicht besitz-/angreif-/atombar; Hintergrundfarbe → Karte wirkt nicht rechteckig
Pathfinding-Kosten (nur Wege, nicht Kampf): 2 wenn magnitude<10 sonst 1
Nukes          wandeln zerstörtes Land → Wasser (Küste verschiebt sich); Impassable nie zerstört
Map-Größen     pro-Map-Manifest (width·height·num_land_tiles); GameMapSize Compact (4×-Downscale) | Normal
```

### 2.9 Bots & Nationen (zwei getrennte KI-Typen!)
```
PlayerType     Bot | Human | Nation
Bot            0..400 (Default 400 öffentlich, Slider im SP-Lobby); zufällige Platzierung;
               passiver Map-Filler: stationär, baut nichts, schwache Angriffe (1–5 % Pop);
               Zwei-Wort-„Stammes"-Namen (Prefix+Suffix); grau im Namens-Schatten
Nation         Anzahl aus Map-Manifest nations[] + Auffüllung; Default 25 % auf Compact-Maps;
               volle KI: baut, alliert, schickt Warships, nukt, Emoji-Reaktionen; Difficulty-skaliert;
               Namen + Spawn-Zellen aus dem Manifest
maxPlayers     pro-Lobby (kein globaler Wert); Renderer reserviert bis 1024 (Mensch+Bot+Nation)
```

### 2.10 Spawn-Phase
```
numSpawnPhaseTurns  = Singleplayer 100 Ticks (~10 s) | Random-Spawn 150 | öffentlich 300 (~30 s)
Spawn wählen        = Land-Tile klicken; im Normal-Modus frei verschiebbar; bei Random-Spawn nach
                      erstem Setzen gesperrt; nach Phasenende fix
Spawn-Immunität     = nach dem Setzen (spawnImmunityDuration) → ImmunityTimer im HUD
Anzeige             = Spawn-Timer-Balken (füllt sich ticks/numSpawnPhaseTurns); alle Human/Nation-
                      Spawn-Tiles werden während der Phase gerendert
Nation-Spawn        = bevorzugt Manifest-Zelle (Suchradius ~25, lehnt Berge ~2 % ab)
```

### 2.11 In-Game-UI & Steuerung (funktional — autoritativ aus `UserSettings.ts`/`InputHandler.ts`)
```
Leaderboard   Spalten Rang | Spieler | Owned % | Gold | Max-Truppen; klick-sortierbar; Top-5 + Aufklappen
ControlPanel  Gold (Münze) · Truppen current/max-Balken · +Rate/s (grün/orange) · Attack-Ratio-Slider 1–100 %
Radial-Menü   Rechtsklick: Mitte = Angriff (Schwert) bzw. Truppen spenden (befreundet); Äste Build/Ally/Emoji
Ghost-Bauen   Ctrl+Klick / Build-Zifferntaste dann Linksklick; Vorschau-Geist mit farbiger Outline
Hotkeys       1–5 City/Factory/Port/DefensePost/Silo · 6–0 SAM/Warship/Atom/Hydro/MIRV
              T/Y Attack-Ratio −/+ (10 %) · B Boot-Angriff · G Boden-Angriff · Shift+R Vergeltung
              K/L Allianz anfragen/brechen · U Raketenrichtung · Q/E Zoom · C Kamera zentrieren
              W/A/S/D + Pfeile Pan · Space Alt-(Terrain-)Ansicht · M Gitter · F alle Warships · P Pause
Maus          Linksklick Primäraktion · Rechtsklick Radial/Kontext (+ bricht Ghost ab) · Drag Pan · Scroll Zoom
              Shift+Drag Warship-Box-Select
Sonstiges     Chat/QuickChat · Emoji (Ctrl+Alt+Klick) · KEIN Minimap-Layer gefunden · keine Fog-of-War
```

### 2.12 Visualisierung (OF rendert in **WebGL2**-Pässen — wir spiegeln den *Look* in Canvas 2D)
```
Terrain       eine Textur-Quad, NEAREST-Filter (pixelscharf je Zoom)
Territorium   Owner-Palette + optionale Muster; Grenzen GPU-gestempelt + Defense-Post-Schachbrett
Strukturen    spielerfarbener Kreis/Punkt + weißes Icon aus 6-Spalten-Atlas (City,Port,Factory,
              DefensePost,SAM,Silo); 2 LODs: Icon bei Zoom>0.5, sonst kleine Punkte;
              Ghost-Vorschau (Alpha 0.5; grün=Upgrade, schwarz=ok, rot=ungültig); Level-Ziffern>1;
              Bau-/Bereitschafts-Fortschrittsbalken unter der Struktur
Gleise        Orientierungs-Textur je Tile (vertikal/horizontal/4 Eck-Typen); LOD: Detail-Sprites nah,
              Anti-Alias-Linien mittel; Owner-Farbe; Ghost-Gleise halbtransparent
Züge          Lok+Waggons folgen der Polylinie; im Boden-Buffer (unter Strukturen); keine Rotation
Schiffe       Sprites Transport/Trade/Warship; KEINE Rotation, kein Wake; Schritt Tile-für-Tile;
              Warship-Zustands-Flags (retreating/angry); NUR Warships haben Health-Bars
Allgemein     keine Fog-of-War; Icon-/Unit-Größe über Zoom-Uniforms skaliert
```

---

## 3) Gegenüberstellung: C&C-Ist → OpenFront-Ziel (pro System)

Aktuelle Konstanten liegen in `rasterCombatConfig.ts`, `buildings.ts`,
`simulationConfig.ts`, `botField.ts`, `RasterGameSession.ts`.

| System | C&C heute | OpenFront-Ziel | Bewertung |
|---|---|---|---|
| Tickrate | 20 TPS | **10 TPS** | ändern (E1) |
| Start-Truppen | 50 | **25 000** (Bot 10 000) | ändern (E2) |
| Truppen-Cap | `tiles·50` linear | **`2·(tiles^0.6·1000+50 000)+Σcity·250k`** | Formel ersetzen |
| Truppen-Wachstum | `tiles·0.02·(1−troops/cap)` | **`(10+troops^0.73/4)·(1−troops/max)`** | Glockenkurve, Formel ersetzen |
| City-Truppen | +0.1/Tick Einkommen | **+250k auf maxTroops/Level** (kein Einkommen) | umstellen |
| Terrain-Bänder | Schwellen 7/18 | **9/19** (0–9/10–19/20–30, 31 impassable) | Schwellen anpassen |
| Terrain-Faktor | 0.9/1.0/1.3 | **mag 80/100/120 + speed 16.5/20/25** | erweitern (mag *und* speed) |
| Angreifer-Bonus | `ATTACKER_EFFICIENCY 0.8` | **×0.8** | ✅ passt |
| Truppen-Verhältnis | `DEFENDER_STRENGTH [0.6,2.0]` | **within(def/atk,0.6,2)** | ✅ passt |
| Verteidiger-Verlust | Dichte `troops/tiles` | **`def.troops/def.numTiles`** | ✅ passt |
| Angreifer-Verlust | `base·terrain·0.8·…·ceil` | **0.6·[ratio·mag·0.8·debuffs]+0.4·[1.3·dichte·mag/100]** | Formel ersetzen (§4) |
| Front-Tempo | `attackSpeedFactor=1/garrison` | **`within(def/(5·atk),0.2,1.5)·speed·debuffs`** | Formel ersetzen |
| Tiles/Tick-Budget | `EXPANSION_SPEND_FRACTION 0.12` | **`within(10·atk/def,0.01,0.5)·grenze·3` / `grenze·2`** | Modell umbauen (§4) |
| Retreat-Malus | `0.25` | **25 %** | ✅ passt |
| Groß-Reich-Dämpfer | — | defenseSig-Sigmoid + Angreifer-Bonus | **neu** (P2) |
| Fort/Defense-Post | Kosten `120·1.7^n`; Stärke 2, Radius 4, linear | **`min(250k,(n+1)·50k)`; Range 30, ×5 mag, ×3 speed, binär** | umstellen |
| Defense-Post-Geschütz | — | shellRate 100, range 75, Schaden 250 | **neu** (P3) |
| City-Kosten/-Effekt | `100·1.6^n`, Gold+Truppen | **`min(1M,2^n·125k)`, +maxTroops & Station** | umstellen |
| Port | `80·1.5^n`, Gold; überall | **`min(1M,2^n·125k)` (Zähler mit Factory geteilt); nur Küste; Trade+Warship** | umstellen + Küstenpflicht |
| Factory | `150·1.6^n` | **`min(1M,2^n·125k)` (Zähler mit Port geteilt)** | umstellen |
| Platzierung | nur eigenes Land | **+ `structureMinDist 15`; Auto-Snap; Port-Shore** | erweitern |
| Bauzeit | sofort | **City/Factory 20, Port/DP 50, Silo 100, SAM 300 Ticks** | **neu** |
| Passiv-Gold | `0.01/Tile` + City/Port-Dividende | **flach 100/Tick (Bot 50); Gold v. a. aus Trade/Zügen** | umstellen |
| Trade-Schiffe | — | **Port→Port-Gold-Sigmoid, beide Häfen voll, kaperbar** | **neu** (P2) |
| Zug-Gold | `10/Station` | **35k/25k/10k je Stadt, Boden 5k** | hochskalieren |
| Schienen-Reichweite | connect 55 / len 90 / fan 4 | **min 15 / max 110 / railroadMax ≈155; A* kardinal, Wasser-Brücke** | anpassen |
| Boot-Landung | `SEA_CROSSING_SURCHARGE 8` | **keine Pauschale; normale attackLogic** | Surcharge entfernen |
| Boot-Truppen | committet voll | **`floor(troops/5)` pro Boot** | begrenzen |
| Boote max | 3 | **3** | ✅ passt |
| Boot-Tempo | 1 Tile/Tick | **1 Tile/Tick** | ✅ passt |
| Warships | — | Kosten/HP/patrol/target/shell wie §2.7 | **neu** (P3) |
| Bot-Feld | 1 Typ, 4/6/8 + √land, Cap 31 | **Bot (Filler) + Nation (Voll-KI); Slider 0–400; Manifest-Nationen** | aufteilen + konfigurierbar |
| Spawn-Phase | 15 s, frei verschiebbar | **~10 s SP; + Immunität; Timer-Balken; Spawn-Marker** | erweitern |
| Attack-UI | Slider % | **Ratio-Slider 1–100 % + Radial-Menü + Hotkeys** | erweitern |
| Build-UI | Buttons | **Radial + Ghost-Vorschau + Ziffern-Hotkeys** | erweitern |
| Leaderboard | „Name 1234 · 5678" | **Rang|Spieler|Owned %|Gold|MaxTruppen, sortierbar** | umbauen (Fund F) |
| Visualisierung | Emoji-Icons, Punkte | **Farbscheibe+Icon, LOD, Ghost, Level-Ziffern, Bau-/HP-Bars** | erweitern |

---

## 4) Kern: das Kampf-Modell von `RasterConflict.advanceAttacks` auf OpenFront umbauen

Heute ist C&C ein **Kosten-Budget**-Modell (`captureCost` Truppen pro Tile,
`EXPANSION_SPEND_FRACTION` des Pools/Tick). OpenFront ist ein **Verlust +
Tiles-pro-Tick**-Modell. Zielablauf je aktivem Angriff (Angreifer-Force `A` gegen
Verteidiger `D`), pro Tick:

1. **Grenzgröße** `border = |landFrontierOf(att,target)|` (+ deterministischer
   Jitter 0..5 statt `Math.random`, damit Replays stabil bleiben).
2. **Tile-Budget** `tilesThisTick = D.isPlayer ? within(5A/D.troops·2, 0.01, 0.5)·border·3 : border·2`.
3. Je Tile in Prioritäts-Reihenfolge (`priority = (jitter0..7+10)·(1 − ownedNbrs·0.5 + magWeight/2)`,
   magWeight Plains 1 / Highland 1.5 / Mountain 2), bis `tilesThisTick` erschöpft
   ist *oder* `A ≤ 0`:
   - Terrain → `mag, speed` (Plains 80/16.5 · Highland 100/20 · Mountain 120/25),
     dann Multiplikatoren: **Defense-Post in Range** (mag×5, speed×3),
     **Bot-Verteidiger** (mag×0.7), Fallout, Verräter, Groß-Reich-Dämpfer.
   - **Spieler:** `defLoss = D.troops/D.numTiles`;
     `attLoss = 0.6·within(D.troops/A,0.6,2)·mag·0.8·debuffs + 0.4·1.3·defLoss·mag/100`;
     `D.troops −= defLoss`; `A −= attLoss`.
   - **Neutral:** `attLoss = mag/5`; kein Verteidigerverlust.
   - Tile erobern; `tilesThisTick −= within(D.troops/(5A),0.2,1.5)·speed·debuffs` (bzw.
     neutral `within(2000·max(10,speed)/A,5,100)` als Tempo-Term).
4. **`A ≤ 0`** → Angriff endet; Reste mit 25 %-Malus (Spieler) bzw. frei (Neutral)
   zurück (vorhandene `refundRetreat`-Logik bleibt).

`captureCost`, `attackSpeedFactor`, `defenderStrengthFactor`,
`EXPANSION_SPEND_FRACTION` werden durch diese Funktionen ersetzt; die guten
Bausteine (`defenderLossPerTile`, `orderedFrontier`, Anker-Label, Allianz-Checks,
kombinierte Defender-Strength über mehrere Fronten) bleiben erhalten. **Die
Tile-Prioritäts-Formel von OF ist enger als unsere `FRONTIER_*`-Gewichte** —
`orderedFrontier` auf die OF-Priorität umstellen (Flachland zuerst, Pocket-Füllen
über den `ownedNbrs·0.5`-Term, der ohnehin schon dem `FRONTIER_SURROUND_WEIGHT`
entspricht).

---

## 5) Umbauplan in Phasen (geordnet, mit Dateien, Werten, Tests)

Reihenfolge so, dass jede Phase für sich lauffähig/testbar bleibt. **P0–P2 =
Balancing-Kern; P3 = große neue Systeme; P4 = UI/Visualisierung.**

### Phase 0 — Maßstab & Takt (Fundament)
- `simulationConfig.ts`: `SIMULATION_TICK_RATE 20 → 10`. Ship-/Train-/Animations-
  konstanten prüfen (1 Tile/Tick bleibt korrekt).
- `RasterGameSession.ts`: `startingTroops 50 → 25 000` (Bots 10 000 über Bot-Seat).
- `rasterCombatConfig.ts`: `MAX_POOL_PER_TILE`/`poolCap`/`growthFactor` durch
  **`maxTroops`** + **`troopGrowth`** ersetzen (§2.1). `applyIncome` ruft die neue
  Glockenkurve auf (closed-form `toAdd`, kein Pro-Tile-Akkumulator mehr nötig).
- Client: Zahlen mit `k`/`M` formatieren (Leaderboard/HUD) — deckt Fund F.
- **Tests:** maxTroops-Tabellenwerte (z. B. 1 Tile, 100, 10 000 Tiles, +Städte);
  Wachstum tickt gegen Cap und plateaut; Bot-Drittel/Halbierung.

### Phase 1 — Land-Kampf (das „Gefühl")
- `RasterConflict.advanceAttacks`/`captureCost` auf das OF-Modell (§4) umbauen.
- `rasterCombatConfig.ts`: Terrain auf `mag 80/100/120 + speed 16.5/20/25`,
  Schwellen `9/19`; `attackerLoss`-Blend, `tilesPerTickUsed`, `attackTilesPerTick`,
  OF-`tilePriority`. `DEFENDER_STRENGTH [0.6,2]`, `ATTACKER_EFFICIENCY 0.8`,
  `RETREAT_MALUS 0.25` bleiben (passen schon).
- **Tests:** Parität (def=atk) → Verlust ~ erwartet; Übermacht rollt durch;
  Unterzahl stallt; Neutral-Expansion `mag/5`; Mehrfront-Verdünnung; Flachland
  wird vor Berg genommen; Replays deterministisch (Jitter statt RNG).

### Phase 2 — Gebäude, Gold & Defense-Post (zweite Achse)
- `buildings.ts`: Kosten auf OF (`City/Port/Factory min(1M,2^n·125k)`,
  `DefensePost min(250k,(n+1)·50k)`); **Port/Factory teilen den Bau-Zähler**.
  City-Effekt = **+250k maxTroops/Level** (Truppen-Dividende entfernen).
  Passiv-Gold flach (100/Tick, Bot 50); City/Port-Gold-Dividenden entfernen.
  Zug-Gold auf 35k/25k/10k. Schienen-Reichweiten 15/110/≈155.
- Defense-Post: Range 30, ×5 mag, ×3 speed, **binär in-range** (Falloff raus);
  `FORT_*`/`DEFENSE_POST_*` zusammenführen.
- **Platzierung** (`processBuild`): `structureMinDist 15`²-Check; Auto-Snap aufs
  nächste gültige eigene Tile; **Port nur auf Shore** (radius 20); Bauzeit-Ticks
  (Struktur erst nach `constructionDuration` aktiv).
- **Tests:** Kostenrampe inkl. geteiltem Port/Factory-Zähler; Min-Abstand lehnt zu
  nahe Bauten ab; Port ohne Küste abgelehnt; City hebt maxTroops; Bauzeit gating.

### Phase 3 — Neue Systeme: Trade-Schiffe, Warships, (Silos/SAM/Nukes optional)
- **Trade-Schiffe** (größter Gold-Hebel): Port→Port, Gold-Sigmoid (§2.5), beide
  Häfen voll, kaperbar; Spawn-Rate-Sigmoid. Neuer `core`-Modul analog `railSystem`.
- **Boote schärfen:** `SEA_CROSSING_SURCHARGE` raus; Boot trägt `floor(troops/5)`;
  Landung über normale `attackLogic`. (max 3, 1 Tile/Tick, 25 % bleiben.)
- **Warships** (P3): Kosten/HP/patrol/target/shell §2.7; Ziel-Priorität
  Transport>Warship>Trade; Hafen-Heilung.
- **Nukes/Silo/SAM** (P3, optional, großer Scope): Silo flach 1M (CD 90), SAM
  `min(3M,(n+1)·1.5M)` (CD 90, deterministische Abfangung), Atom/Hydro/MIRV-Radien;
  Land→Wasser-Konversion + Fallout-Kampfmodifikator.
- **Tests:** Trade-Gold je Distanz; Kaper-Umleitung; Boot-Kapazität; Warship-
  Schaden 250/HP 1000; SAM-Abfang-Reichweite.

### Phase 4 — Bot-/Nationen-Feld, Spawn-Phase, UI & Visualisierung
- **Bot vs Nation trennen** (`botField.ts`, `RasterBotController.ts`): `Bot` =
  passiver Filler (stationär, baut nichts, schwache 1–5 %-Angriffe, Zwei-Wort-
  Stammesnamen); `Nation` = heutige Voll-KI (baut/alliert/expandiert, Manifest-
  Name+Spawn). Anzahl als **Lobby-Slider** (Bots 0–N, Nationen aus Map-Manifest +
  Default ~25 % auf kleinen Maps) statt nur `RASTER_BOTS`.
- **Spawn-Phase:** ~10 s SP; **Spawn-Immunität** nach dem Setzen; Timer-Balken;
  alle Human/Nation-Spawn-Marker während der Phase rendern.
- **In-Game-UI** (`rasterClient.ts`): Leaderboard-Spalten Rang|Spieler|Owned %|
  Gold|MaxTruppen (sortierbar, Top-5+Aufklappen); ControlPanel mit Gold/Truppen-
  Balken/+Rate/Attack-Ratio-Slider **1–100 %**; **Radial-Menü** (Rechtsklick:
  Angriff/Build/Ally/Emoji); **Hotkeys** (1–0 Bauten, T/Y Ratio, B Boot, G Boden,
  K/L Ally, WASD Pan, Q/E Zoom, C Zentrieren, Space Alt-Ansicht, F Warships).
- **Visualisierung** (`rasterClient.ts`, Canvas 2D — *Look* spiegeln, nicht WebGL
  portieren): Struktur = spielerfarbene Scheibe + Icon (Emoji bleibt), LOD
  (Punkte bei weitem Zoom — z. T. schon da), **Ghost-Vorschau** mit Outline
  (grün Upgrade / schwarz ok / rot ungültig), **Level-Ziffern** für Upgrades,
  **Bau-Fortschrittsbalken**, **Warship-Health-Bars**, Defense-Post-Reichweiten-
  Tönung. Gleise bleiben Polylinien; Züge optional als Lok+Waggons; Schiffe als
  kleine Sprites (bewusst ohne Rotation wie OF). Grenzen kräftiger (Fund D).
- **Defeat/Spectate** (Playtest-Fund A) gehört organisatorisch hierher.

---

## 6) Risiken & offene Entscheidungen

- **E1/E2/E3 oben** sind die Hebel: ohne den großen Maßstab + 10 TPS wird es
  „im Stil von", nicht „exakt wie" OpenFront. Empfehlung = volle Treue.
- **Nukes/SAM/Warships** sind je ein eigenes Subsystem (Cooldowns, Projektile,
  Terrain-Konversion). Sie sind für das *Kern*-Balancing (Truppen/Gebäude/Kampf)
  nicht nötig — bewusst als P3 nachgelagert, damit P0–P2 schnell „OpenFront-feel"
  liefern.
- **Groß-Reich-Dämpfer** (defenseSig) bremst das Snowballing zusätzlich (Fund B/C);
  in P1 vorbereitet, voll in P2/P3.
- **Visualisierung:** OF ist WebGL2; wir bleiben bei Canvas 2D und ahmen den *Look*
  nach (Performance auf 1.6 M-Tile-Karten im Auge behalten — Icons/Bars nur
  zoom-gegated zeichnen, wie heute schon).
- **Kein Minimap-/Fog-Layer** in OpenFront — nichts nachzubauen.
- **Lizenz:** weiterhin nur Werte/Formeln, kein Code/Asset-Transfer (§0).

## 7) Konkret nächste kleine Schritte
1. **Phase 0** umsetzen (10 TPS + 25 000 Start + `maxTroops`/`troopGrowth`) — ein
   geschlossener, gut testbarer Commit, der den ganzen Maßstab umstellt.
2. **Phase 1** Kampf-Port (§4) — der spürbarste Gefühls-Sprung.
3. Danach Phase 2 (Gebäude/Gold/Defense-Post inkl. Platzierungs-Regeln).
