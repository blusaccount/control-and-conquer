# OpenFront.io — Spielerlebnis (gespielte Solo-Runde)

> **Datum:** 2026-06-29. Eine Solo-Runde auf der **echten** openfront.io (aktuelle
> Live-Version) im Chrome-Fenster gespielt und beobachtet. Zweck: das Gameplay
> und „Feel" des Originals festhalten, um unseren Klon (`control-and-conquer`)
> gezielt anzunähern. Ergänzt die [Gap-Analyse](./openfront-gap-analysis.md).

## 1) Zugang & Hauptmenü

- Die Seite liegt hinter einer **Cloudflare-Bot-Prüfung** und einem
  **GDPR-Consent-Dialog** — beides nur Drumherum, kein Spielinhalt.
- Hauptmenü: Namens-**TAG** (Anon483), **Select Skin** + **Flagge auswählen**
  (kosmetische Identität), und die Modi **Solo / Create Lobby / Ranked / Join
  Lobby**. Daneben laufende Live-Lobbys mit Spielerzahl & Countdown
  (z. B. „84/125 Alps Free for All", „1min 15s").

## 2) Solo-Setup

Klar fokussiertes Setup-Modal („SOLO"):
- **Karte:** Reiter *Featured / All / Favourites* + Suchfeld; viele Karten
  (Welt, Europa, Nordamerika, Südamerika, Asien, Afrika, Japan, **Zufällig**, …).
- **Schwierigkeitsgrad:** *Easy / Medium / Hard / Impossible* (mit Totenkopf-Icons).
- Großer **„Spiel starten"**-Button. Ein Klick → direkt in die Spawn-Phase.

## 3) Spawn-Phase

- Ganzseitige, **fotorealistisch wirkende topografische Weltkarte** (echte
  Höhen-/Küsten-Schattierung), bei „Welt" mit **~125 Nationen**.
- Tooltip **„Wähle eine Startposition"**; überall auf Land sitzen farbige
  Spawn-Punkte der KI-Nationen. Man klickt seinen Startpunkt auf Land.
- Nach der Wahl **zoomt die Kamera automatisch auf die eigene Nation** und das
  Spiel beginnt. Die eigene Nation ist mit einer **👑 Krone** markiert.

## 4) Früh- bis Mid-Game (gespielt als „Anon162", Westafrika)

- Start mit einer kleinen grünen Fläche (~2.6K Truppen), umgeben von Dutzenden
  **kleiner KI-Nationen** als kompakte Blobs (Senegal, Benin, Niger, Chad, Sudan,
  „Samoan Tribe", „Tajik Assembly", „Norman Fief" …) — eine **dicht besiedelte,
  lebendige Welt**, in der ständig etwas zu erobern ist.
- Expansion per **Klick auf Zielgebiet**; ein Auswahl-Tooltip zeigt das Ziel und
  die Truppenkosten an (z. B. **„47 Wildnis"** für neutrales Land).
- Über ~1 Minute wuchs die eigene Nation sichtbar (2.6K → 11.5K Truppen), Nachbarn
  wurden geschluckt; die Front wächst organisch entlang der Grenzen.

## 5) UI / HUD im Detail (das prägt den „Feel")

**Nations-Rendering auf der Karte**
- **Name mittig in der Masse**, darunter die **Truppenzahl** (z. B. „Anon162
  11.5K", „Benin 11.6K"); Schrift skaliert mit Territoriumsgröße.
- **Knackige, kontrastreiche Grenzen** je Nation (eigene Nation zusätzlich weiß
  umrandet) — Gebiete sind sofort klar ablesbar, nicht nur „Farbflächen".
- **Nationalflaggen** neben vielen Namen (Identität/Wiedererkennung).

**Leaderboard (oben links), tabellarisch mit Spaltenköpfen**
- Spalten: **# · Spieler · Besitz % · Gold · Max troops** (z. B. „Anon162 0.6 %
  82.8K Gold 39.4K Max troops"). Besitz in **%** der Karte, nicht roh in Tiles.

**Top-HUD (eigene Nation)**
- Truppen als **aktuell / maximal** („11.8K / 39.4K"), **Gold** (83.4K) und eine
  Reihe **Einheiten-/Gebäude-Icons mit Zählern** (Boote, Städte/Häfen, Raketen …)
  → es gibt eine **Bau-/Einheitenschicht** über reinem Territorium.

**Bottom-HUD (Steuerung)**
- **Einkommensrate** „+891/s", Truppenbalken „11.8K / 39.4K", **Gold**,
- **Angriffs-Ratio-Slider** „20 % (2.37K)" — wie viel des Pools ein Klick
  committet (analog zu unserem %-Slider, aber als zentrales HUD-Element unten),
- Reihe **Aktions-/Bau-Icons** (Baumenü, Boot, …).

**Rahmen**
- Oben rechts: **Timer**, **Schnellvorlauf**, **Pause**, **Einstellungen**,
  **Vollbild**, **Verlassen**.

## 6) Was den Feel ausmacht (Kernbeobachtungen)

1. **Lesbarkeit zuerst:** zentrierte Namen + Truppenzahl + scharfe Grenzen +
   Flaggen machen die Karte auf einen Blick verständlich, trotz ~125 Nationen.
2. **Zwei Ressourcen:** **Truppen** (Expansion/Kampf) **und Gold** (Wirtschaft,
   Käufe/Bauwerke) — Gold ist eine eigene strategische Achse.
3. **Sichtbarer Truppen-Cap:** „aktuell / max" steht permanent im HUD; Wachstum
   strebt sichtbar gegen ein Maximum (kein Gefühl von ins-Unendliche-Zahlen).
4. **Bau-/Einheitenschicht:** Städte/Häfen/Raketen etc. als Icons — mehr als nur
   Tiles färben.
5. **Dichte, kleine Nationen** → ständige Ziele, sofortiges Handlungsangebot, kein
   Leerlauf in der Frühphase.
6. **Sauberes Onboarding:** klares Setup (Karte + Schwierigkeit), explizite
   **Spawn-Wahl**, Auto-Zoom auf die eigene (gekrönte) Nation.

## 7) Abgleich mit unserem Klon

**Schon nah dran:**
- Reale Karten + Terrain-Shading, zentrierte Nationsnamen, amphibische Boote,
  %-Commit-Slider, Leaderboard, Defeat-Screen, logistischer Truppen-Soft-Cap.

**Spürbare Lücken (Kandidaten für die Roadmap):**
- **Gold als zweite Ressource** + **Bau-/Einheitenschicht** (Städte/Häfen/…) —
  der größte inhaltliche Unterschied.
- **Truppen „aktuell / max" im HUD** sichtbar machen (wir haben den Soft-Cap, aber
  zeigen das Maximum nicht an).
- **Truppenzahl unter dem Nationsnamen** auf der Karte (nicht nur im Leaderboard).
- **Stärkerer Grenz-Kontrast** + **eigene Nation hervorheben** (Krone/weiße Umrandung).
- **Nationalflaggen / Skins** (Identität) — kosmetisch, aber prägt den Feel.
- **Explizite Spawn-Wahl-Phase** statt fixem Start; **Auto-Zoom auf den Spawn**.
- **Leaderboard mit Besitz-% und Gold-Spalte** (wir zeigen Tiles · Truppen).
- **Schwierigkeitsgrade** (Easy…Impossible) als Lobby-Option.
- **Sehr viele kleine Nationen** auf großen Karten → lebendigere Welt.
- **HUD-Politur:** Bottom-Action-Leiste, Timer/Pause/Schnellvorlauf, Vollbild.
