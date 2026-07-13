# PR-Plan: OpenFront-Gameplay-Feeling ohne Lizenzverstoß (Review 2026-07-02)

> **Auftrag:** Codebase-Review + Abgleich mit openfront.io, daraus ein
> evaluierter PR-Plan, der das exakte Spielgefühl von OpenFront nachbaut und
> das Projekt **kommerziell nutzbar** hält.
>
> Dieses Dokument ist die **Umsetzungsreihenfolge**: konkrete, einzeln
> mergebare PRs mit Scope, Dateien, Akzeptanzkriterien und Lizenz-Leitplanken.
> (Die früheren Begleit-Dokumente Gap-Analyse, Balance-Replication-Plan und
> Playthrough-Notizen wurden als veraltet entfernt.)

> **Status-Update (2026-07-13):** Seit dem Review sind über den Plan hinaus
> gelandet: das PvP-Fundament **M1+M2** (geteilte Lockstep-Sessions, private
> Lobbys mit Share-Code/Invite-Link/öffentlicher Liste, Reconnect mit
> Resume-Token + Turn-Backlog — s. `docs/multiplayer-authority.md`), der
> **Map-Editor** mit `.ccmap`-Import/Export, und ein kompletter
> **KI-Parity-Rewrite**: die frühere Persönlichkeiten-KI wurde durch
> OpenFronts exaktes Nation/Tribe-Modell ersetzt (Schwierigkeits-gestaffelte
> Strategielisten, Relations-Ledger, Allianz-Urteil, MIRV-Programm,
> SAM-bewusstes Nuke-Aiming, Warship-Retaliation, Emoji-Chatter; Werte ohne
> Code-Übernahme extrahiert — Ledger in `docs/ai-openfront-parity.md`).
> Eroberte Gebäude **wechseln seitdem den Besitzer** (OpenFront-Semantik;
> Defense Posts werden geschleift, Tribes löschen Erbeutetes) — ältere
> Akzeptanzkriterien unten („Eroberung zerstört Struktur") beschreiben den
> damaligen Stand. Erwähnungen von „Persönlichkeiten" unten sind ebenso
> historisch. Teststand: 416 grün.

## 1) Lizenz-Evaluierung (Grundlage für alles Weitere)

Recherchestand 2026-07-02, Quellen: `LICENSING.md`, `LICENSE`, `LICENSE-ASSETS`
im `openfrontio/OpenFrontIO`-Repo (per Web abgerufen, nicht geklont).

### OpenFronts Lizenzstruktur

| Bestandteil | Lizenz | Konsequenz für uns |
|---|---|---|
| Quellcode (seit 2025-09-04) | **AGPL-3.0** + seit 2025-12-16 §7-Zusatz (Pflicht-Attribution „© OpenFront and Contributors" in Footer/Ladescreen von Forks) | Jede Code-Übernahme (auch übersetzt/portiert) macht unser Projekt zum Derivat → AGPL-Pflicht inkl. Netzwerk-Copyleft (Quelloffenlegung schon beim *Hosten*). **Absolut kein Code-Transfer.** |
| `src/client` (2025-03 bis 2025-09) | GPL-3.0 | dito — kein Transfer. |
| Historischer Code (vor 2025-03-25) | MIT (WarFront-Erbe) | Theoretisch nutzbar mit Attribution — **nicht empfohlen** (vermischt die Argumentation, veraltet). |
| Assets in `/resources` | **CC BY-SA 4.0** | Nutzung nur mit Attribution + ShareAlike → für ein proprietäres Projekt praktisch unbrauchbar. **Nicht verwenden.** |
| Assets in `/proprietary` + CDN/Server-Inhalte | **All Rights Reserved** (OpenFront Inc.) | Extraktion/Nutzung explizit verboten. **Nicht anfassen** — das schließt Karten-Bitmaps/Manifeste, Sprites, Sounds, Flaggen-Sets, Namenslisten, Theme-JSONs ein. |
| Name „OpenFront" | Firma **OpenFront Inc.** dahinter | Markenrisiko: Name/Branding nicht im Produkt/Marketing verwenden. Nominative Nennung („inspiriert von …") in Docs ist ok. |

### Was rechtlich sicher bleibt (und unsere Methodik trägt)

- **Spielregeln, Mechaniken, Formel-Formen und Zahlenkonstanten sind nicht
  urheberrechtlich schützbar** (Ideen/Fakten, keine Ausdrucksform). Eine
  eigenständige Implementierung derselben Regeln ist zulässig — genau das ist
  der Ist-Zustand dieses Repos (eigene Architektur: `RasterConflict`/Canvas 2D
  vs. OpenFronts Execution-Klassen/WebGL2, eigene Namen, eigene Assets).
- **Ehrlichkeits-Korrektur zur „Clean-Room"-Behauptung:** Streng genommen
  bedeutet Clean-Room *kein* Blick in den Quellcode. Unsere Balance-Werte
  wurden aber quellcode-basiert abgeglichen (`Config.ts`-Werte, s.
  Balance-Plan §0). Das ist vertretbar (Konstanten = Fakten; reine
  Werte-Extraktion erzeugt kein Derivat), schwächt aber das Etikett. →
  **Empfehlung:** in README/Docs künftig von „unabhängiger Reimplementierung
  (keine Code-/Asset-Übernahme; Regeln und Konstanten sind nicht schutzfähige
  Fakten)" sprechen statt „Clean-Room", und die Provenienz-Doku (welcher Wert
  woher) weiterpflegen. Für **künftige** Wert-Abgleiche bevorzugt öffentliche
  Quellen (Wiki, Patch-Notes, eigenes Nachspielen/Messen) nutzen; Quellcode
  nur lesen, wo öffentliche Quellen fehlen, und dann **nur Werte notieren,
  nie Struktur/Bezeichner/Kommentare übernehmen**.
- **Guardrails für jeden PR in diesem Plan:**
  1. Kein OpenFront-Code, keine OpenFront-Assets (auch keine Karten-Daten,
     Nation-Namenslisten, Icon-Atlanten, Colorblind-Palette-JSONs).
  2. Eigene Karten ausschließlich aus gemeinfreien Geodaten (Natural Earth,
     GEBCO/SRTM) oder prozedural — wie bereits bei `earth-topo.png`/Rivers.
  3. UI wird **funktional** nachgebaut (Layout/Bedienlogik), nie als
     Pixel-Kopie; Icons bleiben eigene Vektoren/Emoji.
  4. Übernommene Zahlen im Commit/Doc mit Quelle vermerken (Provenienz).
- **Randnotiz Markenrecht (außerhalb OpenFront):** Der Projektname
  „Control & Conquer" liegt nah an EAs Marke „Command & Conquer", und das
  README nennt C&C: Generals als Design-Ziel. Vor einer Kommerzialisierung
  Namenswahl juristisch prüfen/ggf. umbenennen — das ist aktuell das größere
  Markenrisiko als OpenFront.

**Fazit:** Der eingeschlagene Weg (Regeln nachbauen, nichts kopieren) hält das
Projekt kommerziell lizenzierbar. Die AGPL macht die Grenze sogar besonders
scharf: solange kein Code/Asset übernommen wird, hat OpenFront keinen
copyleft-Hebel auf dieses Repo.

## 2) Review-Ergebnis: Wo steht die Codebase?

Kurzfassung (heute gegen Code verifiziert, 309 Tests grün):

**Bereits wertgenau bzw. funktional gleichauf:** 10 TPS, Start 25k,
`maxTroops`-/Wachstums-Glockenkurve, komplettes Land-Kampf-Modell
(mag/speed-Bänder, Verlust-Blend, Tiles/Tick, Frontier-Priorität,
Groß-Reich-Dämpfer, Retreat-Malus), Gebäude-Kostenrampen + Bauzeiten +
Platzierungsregeln, Forts/Defense-Posts, Trade-Schiffe (Gold-Sigmoid), mobile
Warships, Silo/Atom/Hydrogen/MIRV/SAM/Fallout, Schienen+Züge, Allianzen mit
Verräter-Debuff, Bot/Nation-Zweiklassen-KI mit Persönlichkeiten, Spawn-Phase +
Immunität, Radialmenü, Hotkey-Parität, sortierbares Leaderboard,
Defeat/Spectate.

**Verifizierte Rest-Lücken (Code-Stand heute):**

| # | Lücke | OpenFront | C&C heute | Feel-Gewicht |
|---|---|---|---|---|
| L1 | Attack-Ratio-Slider | 1–100 %, Default 20 %, Schritt 10 | **erledigt (PR A)** — 1–100 %, Default 20, T/Y ±10 | — |
| L2 | Boot-Kapazität | `floor(troops/5)` pro Boot | **war bereits umgesetzt** (Session kappt auf `floor(pool/5)`; PR A pinnt das per Test) | — |
| L3 | **Allianz-Lebenszyklus** | ~5 min Laufzeit, Renewal-Prompt ~30 s vor Ablauf, natürlicher Ablauf ≠ Verrat; Verrats-Zähler; Auto-Embargo | **erledigt (PR C)** — 5-min-Ablauf, beidseitiges Renewal, Verrats-Konto + 🗡-Marker, Bot-Verhalten; Auto-Embargo folgt mit PR F (Embargo-System) | — |
| L4 | **Struktur-Upgrades (Level)** | seit v24: Bau auf bestehendes Gebäude = Upgrade (City-Level ×250k Cap, Stations-Level etc.), Level-Ziffern im Render | **erledigt (PR D)** — City/Port/Factory upgradebar (gleiche Kostenrampe, Effekt pro Level), Level-Badge + amber Upgrade-Ghost, Bot-Upgrades; Fort/Silo/SAM bewusst v1-ausgenommen | — |
| L5 | **Win-Condition** | Prozent-Schwelle der Landfläche (FFA; Teams 95 %) → Spiele *enden* | **erledigt (PR B)** — `WIN_TILE_FRACTION = 0.8`, Match endet an der Schwelle; Leaderboard zeigt Sieg-Fortschritt | — |
| L6 | Emojis / Quick-Chat | Emoji-Reaktionen übers Territorium, Preset-Nachrichten | **erledigt (PR E)** — 8-Emoji-Set, Radial-Ast, über dem Ziel-Territorium schwebend + verblassend, Bot-Reaktionen (🤝/👎/😡); Preset-Chat bewusst als Event-Zeilen | — |
| L7 | Spenden / Zielanfragen / Embargo | Truppen-/Gold-Spende an Verbündete, Target-Request, Handels-Embargo (manuell + automatisch bei Verrat) | **erledigt (PR F)** — Truppen-/Gold-Spende (Slider-%), „Verbündete angreifen lassen" (Target-Request, Bots folgen), Embargo (manuell + auto bei Verrat, sperrt Trade-Schiffe) | — |
| L8 | Waffen-Feinheiten | MIRV = Schwarm vieler kleiner Sprengköpfe übers Zielterritorium; SAM-Abfangquote je Waffentyp; Defense-Post-Geschütz (Shells vs. Schiffe) | **großteils erledigt (PR G)** — MIRV-Schwarm (bis 350 Warheads), Fort-Geschütz, Hydrogen-Radien; offen: SAM-Quote je Waffentyp | niedrig (Rest) |
| L9 | Map-Katalog | Dutzende kuratierte Karten, Featured/All/Favorites/Suche, Random | 3 Größen derselben Earth-Karte | **hoch** (größte Content-Lücke) |
| L10 | Schwierigkeit „Impossible" + Nation-Confusion | 4 Stufen (Impossible: Start 31 250, Cap ×1.25, Wachstum ×1.05); Fehlangriffs-Chance 10/5/2.5/0 % | **erledigt (PR J)** — inkl. Fix: Solo-Worker seatet jetzt identisch zum Server (Bot/Nation-Split + Difficulty) | — |
| L11 | Identität/Kosmetik | Name, Flagge, Muster/Skins, Clans | Farbe/Emoji deterministisch aus Id | mittel |
| L12 | PvP/Lobby/Teams | FFA/Duos/Trios/Quads, Ranked 1v1, Custom-Lobbys | Solo vs. Bots | strukturell größte Lücke |
| L13 | Kleinkram | Zugtempo 2 Tiles/Tick; K/M/B-Format; tote `DEFENSE_POST_*`-Konstanten; Warship-Veterancy-Pips; Colorblind-Theme; Tag/Nacht-Ambient | Zug/Format/Konstanten **erledigt (PR A)**; offen: Veterancy-Pips, Colorblind, Ambient | niedrig |

**Quellen-Hinweis zu Zahlen:** Community-Wikis dokumentieren teils ältere
Versionen (z. B. Defense-Post „Radius 40/×6", City „+25k") und widersprechen
dem quellcode-verifizierten Stand v0.32.6 (Radius 30/×5, City +250k). Bei
Konflikten gilt der bereits im Balance-Plan §2 dokumentierte, versionsaktuelle
Wert; Wiki-Werte nur übernehmen, wenn nichts Aktuelleres existiert, und die
Version notieren. OpenFront patcht monatlich (v24 Upgrades → v29 Ranked → v31
Clans/Wasser-Nukes) — „exakt" heißt immer „exakt Stand Version X".

**Doku-Drift (im Zuge von PR A fixen):** README/`simulation-tick-model.md`
nennen noch 20 TPS (Code: 10) und eine Map-Liste mit World/Procedural, die das
Menü nicht mehr anbietet; `simulation-tick-model.md` beschreibt noch das alte
Kosten-Budget-Kampfmodell.

## 3) Der PR-Plan

Reihenfolge nach **Feel-Gewinn pro Aufwand**, jeder PR einzeln mergebar und
getestet. Größen: S (<½ Tag), M (1–2 Tage), L (mehrere Tage), XL (Epic).

| PR | Titel | Lücken | Größe | Prio |
|---|---|---|---|---|
| A | Quick-Wins: Slider-, Boot-, Zug-, Format-Parität + Doku-Hygiene | L1, L2, L13(teilw.) | S | **P0** |
| B | Win-Condition: Prozent-Schwelle + Siegfortschritt | L5 | S/M | **P0** |
| C | Allianz-Lebenszyklus: Ablauf, Renewal, Verrats-Reputation | L3 | M | **P1** |
| D | Struktur-Upgrades (Level) | L4 | M/L | **P1** |
| E | Diplomatie I: Emojis + Quick-Chat | L6 | M | P1 |
| F | Diplomatie II: Spenden, Zielanfragen, Embargo | L7 | M | P1 |
| G | Waffen-Feintuning: MIRV-Schwarm, SAM-Quoten, Fort-Geschütz | L8 | M | P2 |
| H | Map-Katalog I: Pipeline + 6–10 neue Karten | L9 | L | **P1** |
| I | Map-Katalog II: Browser-UI (Featured/Favorites/Suche/Random) | L9 | M | P2 |
| J | „Impossible" + Nation-Confusion | L10 | S | P2 |
| K | Identität: Name + Flagge + Territorium-Muster | L11 | M | P2 |
| L | Politur: Veterancy-Pips, Colorblind-Palette, Ambient | L13 | M | P3 |
| M1–M4 | PvP-Epic (geteilte Session → Lobby → Teams → Persistenz) | L12 | XL | P1 (parallel-Track) |

### PR A — Quick-Wins Balance-/UI-Parität (S, P0) — ✅ umgesetzt (2026-07-02)

Bündelt alle Ein-Zeilen- bis Ein-Datei-Abweichungen; größter Feel-Effekt pro
Zeile ist der Slider (OpenFront-Spieler committen reflexhaft 20 %).

- `public/index.html` + `rasterClient.ts`: Slider **1–100 %, Default 20,
  Hotkey-Schritt 10** (T/Y).
- `RasterConflict.launchShip`: Boot trägt **`floor(troops/5)`** statt des
  vollen Commits (Rest bleibt im Pool).
- `buildings.ts`: `TRAIN_TILES_PER_TICK 3 → 2`.
- `rasterClient.ts` `formatCount`: **„K/M/B"** groß, Dezimalstaffel 1K–10K: 2
  Stellen, 10K–100K: 1, ≥100K: 0.
- `rasterCombatConfig.ts`: tote `DEFENSE_POST_RADIUS/STRENGTH` löschen.
- Doku-Drift fixen (README-TPS/Maps, `simulation-tick-model.md`).
- **Tests:** Boot-Kapazität; Formatgrenzen. **Akzeptanz:** Default-Klick
  committet 20 %; Boot-Landung entspricht OF-Größenordnung.

### PR B — Win-Condition: Prozent-Schwelle (S/M, P0) — ✅ umgesetzt (2026-07-02, 80 % verifiziert via openfrontpro.com/mechanics/winning + Miraheze-Wiki)

Ohne Schwelle enden Matches nie organisch — einer der spürbarsten
Unterschiede im Matchverlauf.

- `rasterCombatConfig.ts`: `WIN_TILE_FRACTION` (FFA; **exakten OF-Wert vor
  Umsetzung aus öffentlichen Quellen verifizieren** — Community nennt je nach
  Modus/Version ~72–80 %, Teams 95 %); `checkVictory` prüft
  `tileCountOf(id) ≥ fraction · capturableCount`.
- Client: Siegfortschritts-Anzeige des Führenden (dezente Leiste/Prozent im
  Leaderboard), Victory-Banner unverändert.
- **Tests:** Schwellen-Sieg, kein Doppel-Sieg, Zeitlimit-Fallback bleibt.

### PR C — Allianz-Lebenszyklus (M, P1) — ✅ umgesetzt (2026-07-02; Auto-Embargo bewusst zu PR F verschoben)

Größte verbleibende **Mechanik**-Lücke: ewige Allianzen erstarren die
Diplomatie; OpenFronts 5-Minuten-Puls (verlängern oder auslaufen lassen)
erzeugt die typischen Verrats- und Neusortierungs-Momente.

- `src/Core/alliances.ts`: Allianzen bekommen `formedAtTick` +
  `ALLIANCE_DURATION_TICKS` (~3000 = 5 min; Wert aus öffentlichen Quellen,
  Version notieren). Registry wird tick-aware (`tick(now)`): Ablauf entfernt
  das Bündnis **ohne** Verräter-Status. Renewal: beidseitige Bestätigung im
  Fenster der letzten ~30 s verlängert.
- Verrats-Reputation: pro Spieler persistenter `betrayals`-Zähler (Snapshot →
  Leaderboard-Tooltip/Icon); Bot-KI gewichtet Annahme-Entscheidung damit
  (Verräter bekommen seltener Allianzen).
- Client: Restlaufzeit am 🤝-Marker, Renewal-Prompt (Event + Button),
  Event-Log-Einträge für Ablauf/Verlängerung.
- Bots: Nations verlängern persönlichkeitsbasiert (Turtle immer, Aggressor
  nur bei Nutzen), Tribes immer.
- **Tests:** Ablauf ohne Traitor-Debuff; Renewal-Fenster; Bot-Antworten
  deterministisch.

### PR D — Struktur-Upgrades / Level (M/L, P1) — ✅ umgesetzt (2026-07-02; Upgrades wirken sofort statt mit Bauzeit — dokumentierte Vereinfachung)

Seit OpenFront v24 Kernbestandteil des Spätspiels (Gold-Senke statt
Gebäude-Spam); unser Renderer hat Level-Ziffern/grünen Upgrade-Ghost bereits
als Zielbild dokumentiert (Balance-Plan §2.12).

- `buildings.ts`: `level`-Feld; Bau auf eigenes Gebäude gleichen Typs =
  Upgrade zum Preis des nächsten Zählerstands (Kostenzähler zählt
  Instanzen+Level — wie OFs `costWrapper` über Anzahl).
- Effekte pro Level: City +250k Cap/Level (Formel nutzt schon `Σ level`),
  Port: Trade-Spawn-Checks pro Level (Hook existiert: „per port level"),
  Fabrik: Zug-Spawn je Stationslevel, Fort/SAM/Silo: v1 bewusst Level 1
  (dokumentieren, was OF dort je Level tut, bevor wir raten).
- Snapshot + Client: Level-Ziffer >1, Ghost-Preview grün bei Upgrade-Ziel.
- Bots: Nations upgraden Citys, wenn `structureMinDist` keinen Neubau mehr
  erlaubt.
- **Tests:** Kostenfolge Bau→Upgrade; Cap-Erhöhung; Eroberung zerstört
  Struktur samt Level.

### PR E — Emojis + Quick-Chat (M, P1) — ✅ umgesetzt (2026-07-03)

Reine Feel-/Sozial-Schicht, macht die Welt „bewohnt" — auch solo, weil
Nations reagieren.

- Protokoll: `CLIENT_RASTER_EMOJI` (Ziel-Spieler oder broadcast), Server
  rate-limitet; Snapshot-Event.
- Client: Radial-Ast „Emoji" (eigenes Set aus System-Emoji — **nicht** OFs
  Auswahl kopieren, funktional gleich: Zustimmung/Spott/Drohung/…),
  Anzeige aufsteigend über dem Territorium des Senders.
- Quick-Chat: Preset-Sätze als Event-Log-Nachrichten an Ziel-Spieler.
- Bot-KI: Nations senden kontextuelle Reaktionen (nach Verrat, Nuke, Sieg im
  Krieg) — deterministisch getriggert.
- **Tests:** Rate-Limit; Event-Serialisierung.

### PR F — Spenden, Zielanfragen, Embargo (M, P1) — ✅ umgesetzt (2026-07-03; damit ist auch die in PR C offengelassene Auto-Embargo-Kopplung geschlossen)

Vervollständigt die Diplomatie-Äste des Radialmenüs (heute: „diese Systeme
existieren hier nicht").

- **Truppen-Spende** an Verbündeten: transferiert Attack-Ratio-Anteil des
  Pools (Radial-Mitte auf Verbündeten, wie OF); **Gold-Spende** analog.
- **Zielanfrage:** Marker + Event beim Verbündeten („greif X an"); Nations
  folgen persönlichkeitsbasiert.
- **Embargo:** manuell pro Spieler + automatisch bei Verrat; Wirkung: keine
  Trade-Schiff-Routen zwischen den Parteien (`tradeSystem.ts` filtert),
  Anzeige im Leaderboard.
- **Tests:** Spende erhält Pool-Summen; Embargo stoppt Routen-Auswahl.

### PR G — Waffen-Feintuning (M, P2) — **großteils erledigt (2026-07-04)**

- **MIRV-Schwarm:** ✅ **erledigt** — Sättigungsschlag über das Territorium
  des Ziel-Spielers (Besitzer des Ziel-Tiles): bis 350 Warheads, Landepunkte
  ≥25 Manhattan-Tiles auseinander, je Warhead 12/18-Radien, einzeln
  SAM-abfangbar (öffentliche Wiki-Werte, "MIRV", 2026-07). Deterministisches
  Spatial-Thinning über die Tile-Menge des Opfers (Bucket-Grid).
- **SAM-Quoten je Waffe** (Atom hoch, Hydrogen mittel, MIRV-Warheads 50 %) +
  Range-Stacking mehrerer SAMs — exakte Quoten vor Umsetzung öffentlich
  verifizieren (Wiki-Angaben widersprechen sich). **Weiterhin offen.**
- **Defense-Post-Geschütz:** ✅ **erledigt** — Forts beschießen feindliche
  Schiffe in Reichweite (shellRate 100, Range 75, 250 Schaden; Transport vor
  Warship, Trade-Schiffe nie).
- **Hydrogen-Radien:** ✅ **erledigt** — 80/100 laut öffentlichen Wikis
  (openfront.miraheze.org / openfront.wiki, "Hydrogen Bomb", 2026-07).
- **Tests:** MIRV-Spacing/-Abdeckung, Fort-vs-Transport und Fort-vs-Warship
  gepinnt; SAM-Quote pro Typ weiterhin offen.

### PR H — Map-Katalog I: Pipeline + Karten (L, P1)

Größte **Content**-Lücke. Lizenz-kritisch: OpenFronts Karten sind **Assets**
(teils proprietär) — es wird **nichts** übernommen, auch keine Namens-/
Manifest-Listen. Stattdessen:

- `scripts/buildMap.ts` generalisieren: Bounding-Box-Ausschnitte aus der
  vorhandenen gemeinfreien Topo-Quelle (Natural Earth/GEBCO) → Kontinente
  (Europa, Asien, Afrika, Amerikas, Ozeanien) + Regionen (z. B. Mittelmeer,
  Ostsee, Japan, Karibik) als eigene, selbst kuratierte Auswahl.
- 2–3 prozedurale Presets (Archipel, Pangäa-artig, Zwei Seen) über den
  vorhandenen Generator (Parameter-Presets, kein neuer Code-Pfad).
- `mapCatalog.ts`: Metadaten (Name, Kategorie, Tile-Zahl, empfohlene
  Bot-Zahl); Nation-Spawn-Hints optional pro Karte.
- **Tests:** jede Katalog-Karte baut, hat >X % Land, zusammenhängende
  Start-Regionen (Smoke-Test über `terrainBuilder`).

### PR I — Map-Katalog II: Browser-UI (M, P2)

- Menü: Tabs Featured/Alle/Favoriten (localStorage), Textsuche,
  „Random Map"; Karten-Thumbnails client-seitig aus dem Terrain-Raster
  gerendert (kein Asset-Import).

### PR J — „Impossible" + Nation-Confusion (S, P2) — ✅ umgesetzt (2026-07-02, inkl. Solo-Worker-Seating-Fix)

- `botField.ts`: vierte Stufe (Start 31 250, Cap ×1.25, Wachstum ×1.05,
  Entscheidungs-Kadenz ~2× Easy); Menü-Option.
- Confusion: Fehlangriffs-Chance 10/5/2.5/0 % (Easy→Impossible),
  deterministisch gehasht statt RNG.
- **Tests:** Stufen-Tabelle; Confusion-Determinismus.

### PR K — Identität/Kosmetik (M, P2)

- Menü: Spielername (Validierung/Längen-Cap), Flaggen-Picker (eigenes Set:
  Emoji-Flaggen oder generierte Heraldik — **keine** OF-Flaggen-Assets),
  optional 2–3 Territorium-Muster (Schraffur/Punkte) über die vorhandene
  Palette.
- Snapshot trägt Name/Flagge; Name-Layout rendert Flagge neben dem
  Nationsnamen.

### PR L — Politur (M, P3)

Warship-Veterancy-Pips (Kills → gestapelte Rechtecke), eigene
Colorblind-Palette (deuteranopie-sicher, **eigene** Werte, validiert z. B.
via Sim-Check), dezentes Tag/Nacht-Ambient, Spawn-Marker aller Nationen
während der Spawn-Phase, Letterboxing-Reduktion (Playtest-Fund G).

### PR M1–M4 — PvP-Epic (XL, P1, paralleler Track)

Strukturell größte Lücke, aber unabhängig vom Feel-Tuning oben; Design liegt
in `docs/multiplayer-authority.md`. Sequenz:

1. **M1 — Geteilte Session:** `MatchRegistry` bekommt einen Mehrspieler-Modus
   (N Menschen + Bots in einer `RasterGameSession`), Spawn-Phase 30 s
   (öffentlicher OF-Wert), Player-Identity (Session-Token), Disconnect =
   Nation wird KI-geführt.
2. **M2 — Lobby/Matchmaking:** Lobby-Browser, Custom-Lobbys
   (Karte/Schwierigkeit/Bots konfigurierbar), Reconnect/Resync (Snapshot-
   Replay auf Join).
3. **M3 — Teams:** Duos/Trios/Quads, Team-Win bei 95 %, kein Friendly Fire,
   geteilte Sicht der Team-Marker.
4. **M4 — Persistenz/Progression:** Match-Resultate speichern; Basis für
   die geplante Roguelite-Meta (eigenes Design, bewusst kein OF-Nachbau —
   hier differenziert sich das Produkt).

## 4) Bewusste Nicht-Ziele (dokumentierte Abweichungen)

- **Canvas 2D statt WebGL2** — Look wird gespiegelt, Engine nicht portiert.
- **Pause/Speed-Keys, Raketenrichtung (U)** — architektonisch nicht
  übertragbar bzw. bewusst ausgelassen. **Warship-Box-Select** ist seit dem
  Unit-Umbau (2026-07-04: Warships sind mobile, per Wasser-Klick gekaufte
  Einheiten mit Patrouillensektor, Spawn am nächsten Hafen, Heilung nur mit
  Hafen, Trade-Kapern auf Kontakt bei doppelter Jagdgeschwindigkeit — Wiki-
  Werte) grundsätzlich möglich, aber weiterhin unimplementiert (P3).
- **Eigene Zugaben bleiben:** Minimap, 👑-Marker, Defeat/Spectate-Flow —
  OpenFront hat sie nicht, sie verbessern das Spiel und schaden der
  „Feel-Parität" nicht.
- **Roguelite/Generals-Asymmetrie** (Projekt-Langfristziel) bleibt bewusst
  *nach* der Feel-Parität einsortiert und ist kein OF-Nachbau.

## 5) Empfohlene Reihenfolge (Kurzfassung)

1. **PR A + B** sofort (zusammen < 1 Tag): Slider/Boot/Format + Prozent-Sieg —
   die zwei spürbarsten Abweichungen im normalen Matchverlauf.
2. **PR C, dann D** (je 1–2 Tage): Allianz-Puls und Upgrades — die letzten
   großen Mechanik-Lücken.
3. **PR H** parallel anstoßen (Content-Pipeline hat Vorlaufzeit), danach I.
4. **PR E/F/G/J/K** in beliebiger Reihenfolge dazwischen.
5. **M1–M4** als eigener Track, sobald das Solo-Feel „fertig" ist — oder
   früher, wenn PvP fürs Produkt Priorität hat.
