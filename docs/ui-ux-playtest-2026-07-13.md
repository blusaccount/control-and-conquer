# UI/UX & gameplay playtest — 2026-07-13

Automated end-to-end playtest against the real game (Chromium + Playwright driving
`http://localhost:3000`, build `946ec78`). Simulated several "normal users":
solo practice rounds on Earth Standard (easy), a two-human multiplayer lobby
round, a touch/mobile session, and a five-viewport responsive audit — reading
the HUD values live while playing to cross-check the economy, combat and trade
maths against `src/Core` constants.

## What was tested and passed

### Onboarding & menus
- Home page, name entry, crest — the typed name flows into the match
  ("Playing as ⚔️ Alice") and into lobbies.
- Practice wizard (settings → battlefield), difficulty chips, map cards.
- Create lobby → share code + invite link (`/?join=CODE`) → second player joins
  by code → member list with HOST/you tags on both clients → non-host has no
  Start button → host starts, both reach the spawn phase. All correct.
- Spawn phase: click-to-found works (solo starts the battle immediately;
  multiplayer waits for all humans, with a server-side auto-seat fallback).

### Controls & hotkeys (all verified working)
- `Q`/`E` and `-`/`=` zoom, mouse-wheel zoom (anchored), `W A S D`/arrow pan,
  drag-pan (and a drag correctly does **not** fire an expand order), `C` centre
  on home, minimap click/drag jumps the camera.
- `T`/`Y` attack-ratio down/up in 10% steps; the readout maths is exact:
  "10% (490)" with a 4.9K pool.
- `B`/`G` boat/ground forced-route arming with clear status lines; re-press
  cancels; `Esc` clears everything.
- Digit row `1–7` arms the right build ghost (City, Factory, Port, Fort,
  Missile Silo, SAM, Warship), `8 9 0` arms Atom/Hydrogen/MIRV — matching the
  documented OpenFront mapping; `Esc` cancels.
- `K` propose alliance at cursor, `L` break (guard message when not allied),
  `R` retreat all fronts, `Shift+R` retaliate (guard message when no attacker),
  `Space` held terrain view (restores on release and on window blur), `M`
  coordinate grid.
- `Ctrl+click` opens the radial build ring, `Alt+click` the emoji ring,
  right-click the root radial (Attack / Boat / Ground / Build / Nuke /
  Diplomacy).
- Hotkeys are correctly suppressed while typing in a text field.
- Touch: tap-to-spawn, tap-driven wizard, drag pan, on-screen zoom buttons
  (touch-only by design — hidden on fine pointers), leaderboard starts
  collapsed on phones and toggles correctly.

### Attacking / defending
- Clicking neutral/enemy land orders "Expanding toward (x, y) with N% of pool";
  territory grows, troops are committed, max-troops scales with land
  (11.3K → 21.9K after early expansion).
- Attacking a specific bot works (leaderboard row focuses its nation; click
  attacks). Events log records combat and bot transports.
- `R` retreat returns survivors with the documented 25% penalty line.
- Allies cannot be attacked ("Allies can't attack each other"); clicking ally
  land just routes an expansion toward it (no friendly capture).
- Human-vs-human combat verified in multiplayer: one player conquered the
  other; the loser got the "Eliminated!" overlay (peak territory, survival
  time, Spectate / Play Again) and transitioned to spectating cleanly.
- Fort builds and costs exactly 50K (linear ramp); city and port charge
  exactly 125,000 each (event log: "built a City (125000 gold)…",
  "built a Port (125000 gold)…").
- Weapon launches are validated with clear errors (e.g. a warhead aimed at
  water answers "A warhead can only target land"); `Shift+R` with no attacker
  answers "No one has attacked you yet."
- Being conquered ends cleanly: "Eliminated — spectating" guards further
  orders, and the Eliminated! overlay shows peak territory / survival time
  with Spectate + Play Again.

### Economy & trading (values checked live)
- Passive gold: HUD shows +1.00K/s; observed +6,000 gold over 6s with no
  actions — matches `GOLD_BASE_PER_TICK (100) × 10 TPS` exactly.
- Troop regen matches the displayed +N/s rate; pool caps at max.
- Conquest gold: expansion produced clear bursts above passive (e.g. +8.7K
  in 5s while absorbing neutral land).
- Building costs match `BUILDING_DEFS`: Fort 50K, City/Port/Factory 125K base,
  Warship 250K, Silo 1M, SAM 1.5M — shown in the build menu, radial ring and
  charged correctly.
- Structure spacing enforced: placements within 15 tiles of another owned
  structure are rejected with "Too close to another building — keep 15 tiles
  between structures."
- City raises max troops by exactly its documented bonus: +250,000 raw
  manpower = **+25.0K at the HUD's ÷10 display scale** (observed 15.7K →
  40.7K; `formatTroops` renders manpower/10, OpenFront convention).
- Port must sit on a shore (coastal snap radius works — clicking near the
  coast places it); building on unowned land rejects with "Build a port on
  land you own."
- Cost ramps display correctly, including the shared port/factory counter:
  after buying 1 port, both Port and Factory show 250K next-cost while City
  stays 125K.
- Diplomacy economy: donate gold/troops and embargo live in the radial
  Diplomacy sub-ring; embargoes block trade pairing
  (`TradeSystem.isEmbargoed`, unit-tested).
- Alliances: `K` offer → easy bots accept in seconds; human-to-human offers
  arrive as action cards with Accept/Reject and both clients show
  "Allied with 1 nation" after accepting. Pacts expire on schedule ("The
  alliance between X and Y has expired") and the renewal-window card
  (Focus / Renew / Ignore) appears before expiry.
- Boat transports: `B` + far-coast click → "Expanding toward (x, y) by boat
  with 20% of pool", the launch event fires ("launched a transport ship with
  36,413 troops"), the troops leave the pool, and land ticked up afterwards
  (1.0% → 1.1%).

### Scaling / responsive audit (1920×1080, 1366×768, 1024×640, 768×1024, 390×844)
- No horizontal overflow, no clipped controls, no overlapping HUD panels at
  any tested size (one exception below).
- Mobile layout adapts: leaderboard collapses to a pill, event log hidden,
  build panel scrolls, touch zoom buttons appear.
- No console errors, no failed network requests in any run.

## Issues found

### 1. (Bug) Control-panel text overlaps when the panel exceeds its max height
`public/index.html` — `.hud-control` is `display:flex; flex-direction:column;
max-height:58vh; overflow-y:auto`. When its content grows past the cap (long
multi-line status + diplomacy line + full build grid — routine mid-game at
900px-tall windows), the flex children **shrink** (default `flex-shrink:1`):
`#statusMessage` collapses to its 16px min-height while its wrapped text
overflows and renders on top of the selection-info block. Reproduced
deterministically; see `8-combat` / overlap probe screenshots. Suggested fix:
`.hud-control > * { flex-shrink: 0; }` (keeps the intended scrollbar).

### 2. (UX) Multiplayer spawn banner keeps saying "Choose a starting location" after you've picked
The banner copy ("…the battle begins the moment you do") is written for solo.
In multiplayer the phase stays `spawn` until every human picks, so after
choosing, the player still sees the same banner, and further clicks answer
with a red "Choose open, unclaimed land for your start position." A
"Waiting for the other players…" state after picking would remove the
confusion (`updateStartBanner`, rasterClient.ts).

### 3. (Minor) Tiny click targets
- Leaderboard sort headers ("Player", "Owned", "Gold", "Max") are ~11px tall.
- The "Practice vs. AI (solo)" link is 15px tall.
Fine with a mouse, fiddly on touch — consider more padding on coarse pointers.

### 4. (Cosmetic) Emoji radial slices show each emoji twice
Each radial slice renders the emoji as the button glyph *and* as the text
label below it (`renderRadialSlices` uses `item.label` for both the tooltip
and the visible label; for emoji slices label == glyph).

### 5. (UX) Trade pacing: a new port pays nothing for minutes, silently
Mechanics are correct (11/11 `tests/tradeSystem.test.ts`; embargo blocking
included), and bots do build ports. But in a live idle measurement the first
several minutes after building a port earned **exactly** passive income
(+120,100 gold observed vs ~120,561 passive over 2 idle minutes, with six
bot ports on the map); the first payout — a single +27K jump consistent with
a long-haul `tradeShipGold` arrival — landed ~3.5 minutes in. Nothing in the
UI tells the player a trade ship was dispatched or arrived (no event line,
no status), so a port can look broken while partners/routes/trip-time line
up. Suggest an event/status line on trade arrivals ("Trade ship arrived:
+27K gold") and possibly on first dispatch.

### 6. (UX) "Easy" is unforgiving for passive players
In three separate easy solo runs, a small nation that stopped expanding (to
idle-observe the economy) was attacked and fully eliminated by bots within
3.5–7 minutes. Fine for OpenFront veterans; brutal for a first-time player
reading the UI. Worth considering a grace period or gentler early aggression
on easy.

> **Post-script:** the AI has since been rebuilt on OpenFront's exact
> balancing (see `docs/ai-openfront-parity.md`). Easy nations now follow
> through on only ~1 in 4 attack decisions against humans (measured 21% vs
> 90% on hard in a controlled scenario). A *tiny* idle nation can still fall
> — tribes poke random neighbours and boat probes are unthrottled, exactly
> as upstream — so this is now faithful behaviour rather than a local
> balance quirk.

### 7. (Cosmetic) Eliminated player's HUD keeps a live troop pool
After elimination the control panel shows the dead nation still regenerating
troops ("1.74K / 10.0K (+266/s)" with Land 0.0%) — sim values for a seat that
no longer exists on the map. Freeze or hide the resource rows when
spectating.

### 8. (Observation) Simulation drift under load
With several concurrent matches + browsers on a 4-core box the server logged
"Simulation drift detected (1454ms behind)… Resyncing schedule" once and
recovered cleanly. Not user-visible; worth knowing it triggers under load.

### 9. (Non-issue, for the record)
- On-screen zoom +/- buttons are hidden on desktop — intentional
  (`@media (pointer: coarse)`).
- Event log is hidden by default and opt-in via settings — intentional;
  alliance offers still surface as action cards.
- "Playing as Anonymous" only happens when the name field is left empty.

## Focused econ run numbers

From the dedicated verification rounds (solo, Earth Standard, easy):

- Passive gold: +6,000 over 6 idle seconds — exactly the displayed 1.00K/s.
- Fort: charged ~50K. City: event "built a City (125000 gold) at (170, 0)";
  max troops 15.7K → 40.7K (= +250K raw manpower, the exact documented
  city bonus at the ÷10 display scale). Port: event
  "built a Port (125000 gold) at (168, 0)"; next port/factory cost ramps to
  250K (shared counter).
- Attack ratio readout: "10% (490)" against a 4.9K displayed pool — exact.
- Boat: "Expanding toward (219, 5) by boat with 20% of pool" + transport
  event with 36,413 troops.
- Trade (idle gold integral, port at (170,0), six bot ports on the map):
  income tracked passive exactly for ~3 minutes (60s: +60,300 vs ~60,295;
  121s: +120,100 vs ~120,561; 181s: +181,100 vs ~180,843), then one +27K
  single-window jump — the first trade payout — before bots eliminated the
  idle nation at 209s. See Issue 5 (pacing/feedback) and Issue 6
  (easy-difficulty aggression).

## How it was driven

Playwright scripts (menu → wizard → spawn via canvas pixel scan → hotkey
battery with DOM probes → growth loop → builds with spacing awareness → trade
watch → boats → diplomacy), probing `#goldInfo`, `#statusMessage`,
`#selectionInfo`, `#leaderboard`, `#actionCards` and canvas pixels/hashes.
