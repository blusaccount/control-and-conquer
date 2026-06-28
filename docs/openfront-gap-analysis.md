# OpenFront-ähnliche Roadmap: Repository Audit + Gap-Analyse

> **Letztes Update:** 2026-06-28 (Bündel „Game Feel #1" gemerged).
> Dieses Dokument spiegelt den Ist-Zustand auf `main`.

## 1) Zielbild (Referenz: openfront.io)
- Tile/Territory-Karte, Spieler starten auf einem Teil, expandieren über Nachbarschaft.
- **Organisches Truppenwachstum** pro Tile pro Tick (keine manuelle Ressourcenverwaltung).
- **One-Click-Angriff:** Klick eigenes Gebiet → Klick feindliches Nachbargebiet.
- **Frontlinien-Visualisierung** als animierte Front zwischen zwei Gebieten.
- **Deterministischer Server**, Client rendert nur.
- **Echtzeit-Multiplayer** via WebSocket-Snapshots.
- **Kein Spielereingriff im Kampf** — Kämpfe laufen autonom ab.

## 2) Aktueller Stand (Ist-Zustand)

### Gameplay-Loop
- Deterministischer Server-Tick bei 20 TPS (`src/Server/index.ts`, `simulationConfig.ts`).
- `MapState.processTick()` führt pro Tick aus: **Attack-Validation → Income → Conflict-Advance → Win-Check** (`src/Core/MapState.ts`).
- **Organisches Truppenwachstum** vorhanden (`INCOME_PER_TICK = 0.05`, ein voller Trupp pro Tile pro Sekunde, fraktionaler Akkumulator privat im MapState gehalten).
- Conflict-Engine: Attrition + Progress-Advance/Retreat + automatische Resolution (Capture/Repel).
- **Win-Condition:** Sobald ein Team alle Territorien hält und keine Conflicts laufen, wird `winnerTeamId` gesetzt und `SERVER_MATCH_ENDED` einmalig gebroadcastet.

### Networking / Multiplayer
- WebSocket + autoritativer Server (`ws`, `src/Server/index.ts`).
- **Match-Isolation** via `MatchRegistry` (paart je zwei Clients in eine eigene `GameSession`).
- Diskriminierte ServerMessage-Union (`SERVER_LOBBY_WAITING`, `SERVER_PLAYER_ASSIGNED`, `SERVER_STATE_SNAPSHOT`, `SERVER_ACTION_REJECTED`, `SERVER_MATCH_ENDED`).
- Strikte Runtime-Validation eingehender Commands (`src/Server/validateCommand.ts`).
- Drift-Detection, Slow-Tick-Warnung, Catch-up-Cap im Scheduler.

### Lobby / Matchmaking
- Implizites Pairing nach Connection-Order; 1v1 fixiert (`TEAM_ROTATION = ["blue", "red"]`).
- Keine Lobby-UI, kein Ready-Check, kein Rematch.

### Map / Territory
- Hardcoded 8-Polygon-Karte „Conqueror Basin" (`src/Core/mapData.ts`).
- Polygon-basierter Hit-Test im Client.
- Noch kein datengetriebenes Kartenformat, keine prozedurale Generierung.

### UI / UX
- Canvas 2D mit polygon-fill + Truppen-Labels.
- **Client modularisiert** in `state` / `geometry` / `dom` / `render` / `net` / `input`; `main.ts` ist nur noch Bootstrap (~9 Zeilen). Module werden als ES-Module über `/assets/` ausgeliefert.
- **Slider-basierte Attack-UX** (Range 10–90% in 5%-Schritten, Default 50%).
- **Frontlinien-Overlay** mit Gradient + pulsierendem Border.
- Victory-Banner über der Karte sobald `winnerTeamId` gesetzt ist.

### Persistenz / Stats
- Komplett In-Memory, kein Storage-Layer.

### Build / CI / Observability
- `npm test`, `npm run build`, `npm run lint`, `npm run dev` (Casing-Bug gefixt).
- 39 Unit-Tests (Core + Server + Tick-Determinismus + Wachstum + Win-Condition + Client-Geometrie).
- Auto-Deploy via Render auf https://control-and-conquer.onrender.com nach Push auf `main`.
- **GitHub-Actions-CI** (`.github/workflows/ci.yml`): `lint + build + test` als PR-Gate auf jeden PR und Push nach `main`.

## 3) Priorisierte Gap-Analyse (offene Punkte)

| Bereich | Status | Priorität | Aufwand | Risiko |
|---|---|---|---|---|
| Karte vergrößern + datengetrieben (JSON-Loader, 30+ Tiles) | offen | P1 | M | M |
| N-Player-Support (Teams als Array, Color-Palette) | offen | P1 | M | M |
| Bot-KI für Solo-Matches | offen | P1 | S | L |
| Lobby-UI (Waiting-Screen, Rematch-Button) | offen | P1 | S | L |
| Client-Modul-Splittung (`render`/`input`/`net`) | ✅ erledigt | P1 | S | L |
| GitHub-Actions-CI (lint+build+test als PR-Gate) | ✅ erledigt | P1 | S | L |
| Reconnect/Resync-Protokoll | offen | P2 | M | M |
| Delta-Snapshots (relevant ab > ~30 Tiles) | offen | P2 | M | M |
| Persistenz für Match-Resultate / MMR | offen | P2 | M | M |
| Strukturierte Logs + Metriken | offen | P2 | M | L |

## 4) Architektur (Ist)

```
                 ┌─────────────────────────────────┐
                 │            Render               │
                 │  control-and-conquer.onrender   │
                 └────────────────┬────────────────┘
                                  │ auto-deploy
                                  ▼
┌───────────────┐   WS    ┌────────────────────┐
│  Browser      │ ◄─────► │  Node.js + ws      │
│  Canvas 2D    │         │  src/Server/       │
│  src/Client/  │         │  ┌──────────────┐  │
└───────────────┘         │  │ MatchRegistry│  │
                          │  └──────┬───────┘  │
                          │         │ 1:N      │
                          │  ┌──────▼───────┐  │
                          │  │ GameSession  │  │
                          │  └──────┬───────┘  │
                          │         │ owns 1   │
                          │  ┌──────▼───────┐  │
                          │  │   MapState   │  │
                          │  │ (Core)       │  │
                          │  └──────────────┘  │
                          └────────────────────┘
```

## 5) Layering-Regeln
- `src/Core/` darf **nicht** auf `src/Server/` zugreifen.
- Game-Mechanik-Konstanten leben in `src/Core/conflictConfig.ts`.
- Server-Scheduling lebt in `src/Server/simulationConfig.ts`.
- Tests dürfen aus `src/Core/` und `src/Server/` importieren.

## 6) Nächste konkret kleine Schritte
1. Karte auf JSON-Loader umstellen (50+ Tiles).
2. Solo-Bot-KI (simpel: greedy „angreife schwächstes Nachbargebiet").
3. Rematch-Flow (Client-Button → Server-Reset oder neue Session).
4. ~~GitHub-Actions-Workflow (`.github/workflows/ci.yml`).~~ ✅ erledigt
5. ~~Client-Modul-Splittung (`render`/`input`/`net`).~~ ✅ erledigt
