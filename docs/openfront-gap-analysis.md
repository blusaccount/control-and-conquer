# OpenFront-ähnliche Roadmap: Repository Audit + Gap-Analyse

## 1) Zielbild (Referenz: OpenFront-ähnliches Browser-RTS)
Ein OpenFront-ähnliches Erlebnis benötigt einen stabilen Gameplay-Loop mit laufenden Matches, echte Multiplayer-Sessions mit Lobby/Matchmaking, skalierbares Karten-/Territory-System, klare Progression/Persistenz, sowie belastbare Build-/CI-/Observability-Pipelines.

## 2) Aktueller Stand (Ist-Zustand)

### Gameplay-Loop
- Deterministischer Core vorhanden (`src/Core/MapState.ts`, `src/Core/BattleEngine.ts`).
- Tick-basierte Ökonomie (+10 Credits pro Provinz/Tick), Unit-Kauf, Movement/Angriff, Minen-Mechanik vorhanden.
- 3 Fraktionen mit einfachen asymmetrischen Boni vorhanden (`src/FactionData/factions.ts`).
- Battle-Timeline mit Visualisierung vorhanden (`src/Client/main.ts`).

### Networking / Multiplayer
- Autoritativer Server mit WebSocket-Broadcast an alle verbundenen Clients (`src/Server/index.ts`, `src/Server/GameSession.ts`).
- Eine globale In-Memory-Session (`new GameSession()`) für alle Spieler/Clients.
- Keine Session-Isolation, kein Reconnect-State, keine Latenz-/Sequence-Strategie.

### Lobby / Matchmaking
- Nicht vorhanden (keine Lobby, kein Ready-Check, keine Match-Erstellung, kein Team-/Slot-Management).

### Map / Territory
- Statische 5-Provinzen-Karte hardcoded in `createInitialState()`.
- Besitzwechsel über Kämpfe vorhanden.
- Keine prozeduralen/größeren Karten, keine Fog-of-War-/Sichtlinien-Mechanik, keine Skalierung auf viele Territorien.

### UI / UX
- Funktionales MVP-UI auf Canvas + Sidebar (`public/index.html`, `src/Client/main.ts`).
- Direkte Kommandos ohne Command-Queue, Hotkeys, Multi-Select, Kontextaktionen.
- Kaum UX für Multiplayer-Flows (Join, Ready, Reconnect, Match-Ende/Rematch).

### Persistenz / Stats
- Vollständig In-Memory, kein Storage-Layer.
- Keine Match-Historie, keine Player-Profile, keine ELO/MMR, keine Seasons/Leaderboards.

### Build / CI / Observability
- Lokale Skripte vorhanden: `npm run lint`, `npm run build`, `npm test`.
- Unit-Tests für Core + Asset-Route vorhanden (`tests/*.test.ts`).
- Keine GitHub Actions/CI-Workflows, kein Deployment-Workflow, keine Runtime-Metriken/Tracing/Logging-Standards.

## 3) Priorisierte Gap-Analyse

| Bereich | Ist-Stand | Gap | Priorität | Aufwand | Risiko |
|---|---|---|---|---|---|
| Multiplayer-Session-Architektur | Eine globale GameSession | Mehrere parallele Matches, Session-Lifecycle, Isolation pro Match | P0 | M | M |
| Lobby/Matchmaking | Nicht vorhanden | Lobby, Player-Slots, Ready-Flow, Match-Start-Regeln | P0 | M | M |
| Persistenz-Basis | Kein DB/Storage | Persistente Spieler, Match-Metadaten, Events, Ergebnisse | P0 | M | M |
| Server-Protokoll | Freies JSON ohne Versioning/Ack | Versioniertes Command/Event-Schema, Validierung, Fehlercodes | P0 | M | M |
| Reconnect/Resync | Nicht vorhanden | Session-Rejoin, Snapshot-Resync, Heartbeat/Timeout | P0 | M | H |
| Autorisierungsmodell | Keine echte Identität | Spieleridentität (temporär Token-basiert), Match-Zugriffsrechte | P1 | M | H |
| Map-System | Hardcoded 5 Provinzen | Datengetriebenes Kartenformat, größere Karten, Balancing-Tools | P1 | M | M |
| Gameplay-Depth | Nur 2 Unit-Typen, einfache Economy | Zusätzliche Unit-/Ability-Tiers, Upgrades, Win-Conditions | P1 | L | M |
| UI-Spielerführung | MVP-Panel | Lobby-UI, Matchmaking-Status, Combat/Map-Telemetrie, Command-Feedback | P1 | M | M |
| Stats/Progression | Nur In-Memory Wins | MMR/ELO, Historie, Leaderboards, Profile | P1 | M | M |
| Performance/Scale | In-Memory single process | Tick-Profiling, Lasttests, ggf. Raum-/Shard-Modell | P2 | L | H |
| Observability | Nur Console-Output | Strukturierte Logs, Metriken (Tick-Zeit, WS-Verbindungen), Alerts | P2 | M | M |
| CI/CD | Keine Workflows | PR-Checks (lint/build/test), Artifact/Deploy-Pipeline | P0 | S | L |
| Security-Hardening | Basis-Validierung in Core | Rate-Limits, Input-Constraints, Abuse-Protection, Audit-Logging | P1 | M | H |

## 4) Technische Architektur-Skizze (inkl. Datenfluss Client ↔ Server)

### Zielarchitektur (Textskizze)
- **Client (Browser)**: Rendering + Input + lokale UI-State-Maschine (keine Autorität über Spielzustand).
- **Gateway/Realtime-Server (Node.js WS)**: Authentifiziert Verbindung, routet Commands in Match-Worker, sendet Events/Snapshots.
- **Match-Service (authoritative simulation)**: Ein Match = ein isolierter Simulationskontext (Tick-Loop + MapState/BattleEngine).
- **Persistence-Service**: Speichert Spielerprofil, Match-Resultate, Event-Summaries.
- **Async-Stats-Pipeline**: Aggregiert Ergebnisse in Leaderboards/MMR.
- **Observability-Stack**: strukturierte Logs + Metriken + Alerting.

### Datenfluss
1. Client verbindet via WS mit Token/Session-ID.
2. Gateway validiert Identität und ordnet Client einer Lobby oder Match-Session zu.
3. Client sendet **Command** (z. B. `move`, `purchase`, `placeMine`) mit Sequenznummer.
4. Match-Service validiert Command gegen autoritativen State.
5. Match-Service berechnet Tick/Battle deterministisch und erzeugt **Domain Events**.
6. Gateway pusht inkrementelle Events + periodische Snapshots an alle Match-Teilnehmer.
7. Client rendert State und bestätigt letzte verarbeitete Sequenz (Ack) für Reconnect/Replay.
8. Match-Ende: Ergebnis + Telemetrie werden persistiert; Stats-Pipeline aktualisiert MMR/Leaderboard.

## 5) Empfohlene Reihenfolge der Umsetzung (konkrete Schritte)

1. **Session-Management einführen**: `GameSessionRegistry` statt globaler Singleton-Session.
2. **Command/Event-Schema versionieren** (zod/io-ts oder äquivalente Runtime-Validierung) inkl. Fehlercodes.
3. **Lobby-Domain modellieren**: Lobby erstellen/joinen/verlassen, Ready-Status, Startbedingungen.
4. **Match-Lifecycle implementieren**: Create → Running → Finished, mit sauberem Cleanup.
5. **Reconnect/Resync-Protokoll bauen**: Heartbeat, Disconnect-Toleranz, Snapshot-Rejoin.
6. **Persistenz-Basis anbinden** (zunächst SQLite/Postgres-kompatibles Repository-Pattern) für Spieler + Match-Metadaten.
7. **Match-Ergebnis-Pipeline ergänzen**: Ergebnisse schreiben, Win/Loss/MMR-Update.
8. **Map-Daten entkoppeln**: Karten als JSON/Schema laden statt Hardcoding in `MapState`.
9. **UI um Multiplayer-Flows erweitern**: Lobby-Screen, Matchmaking-Status, Reconnect-Hinweise.
10. **Core-Gameplay ausbauen**: Win-Conditions, längere Progression, feinere Economy-Tuning-Parameter.
11. **CI aufsetzen**: GitHub Actions mit lint/build/test als Pflicht-PR-Gates.
12. **Observability ergänzen**: strukturierte Logs, Tick-Latenzmetrik, WS-Connection-Metriken, Basis-Alerts.

## 6) Unknowns / Annahmen + Validierungsvorschläge

| Unknown / Annahme | Risiko | Validierungsvorschlag |
|---|---|---|
| Ziel-Spielmodus ist primär 1v1 vs. FFA/Teams | Falsches Datenmodell für Lobby/Matchmaking | Product-Workshop + Event-Tracking-Prototyp; verbindliche Mode-Matrix definieren |
| Tickrate/Match-Länge für gewünschtes Spielgefühl | Entweder träge oder chaotisch | Playtest mit 3 Tickraten + Telemetrie (APM, Matchdauer, Abbruchrate) |
| MMR-System (ELO/TrueSkill) Anforderungen | Unfaire Matchups | Simulationsbasierter Vergleich + A/B in Closed Alpha |
| Kartenkomplexität für Browser-Performance | FPS/Tick-Drops bei größeren Karten | Lasttest-Matrix (Provinzanzahl × Spielerzahl) + Performance-Budget festlegen |
| Reconnect-Fenster (z. B. 30–120s) | Frust bei Disconnects oder Exploit-Risiko | Chaos-Tests mit künstlichem Paketverlust/Disconnect |
| Mindestmaß an Anti-Abuse/Rate-Limit | Spam/DoS/Command-Flood | Load-/Abuse-Tests auf WS-Endpunkte + adaptive Rate-Limits |
| Persistenzmodell (event-sourcing vs snapshot-basiert) | Hohe spätere Migrationskosten | Architektur-Spike mit 2 vertikalen Slice-Implementierungen |
| Zielplattform (nur Desktop-Browser vs. Mobile) | UI/UX-Rework später | Analytics/Interviews + responsive Prototyp-Test |
| Notwendigkeit von Spectator/Replays | Fehlende Community-Features | Nutzerinterviews + Feature-Flag-Experiment |
| Operatives Ziel (Hobby-Scale vs. produktionsnah) | Over-/Under-Engineering | SLO-Definition (Uptime, max. Match-Join-Zeit, max. Tick-Zeit) |

## 7) Top-5 nächste Schritte (für PR-Summary)
1. Session-Registry + isolierte Match-Instanzen einführen.
2. Lobby/Ready/Match-Start als separaten Domain-Flow implementieren.
3. WS-Protokoll versionieren und Commands strikt validieren.
4. Persistenz für Player- und Match-Ergebnisse aufbauen.
5. CI-Pipeline (lint/build/test) und Basis-Observability etablieren.
