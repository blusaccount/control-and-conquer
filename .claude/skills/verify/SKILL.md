---
name: verify
description: Build, launch, and drive Control & Conquer end-to-end to verify a change at its real surface (the browser game), instead of only running tests.
---

# Verifying Control & Conquer changes

The surface is the browser game at http://localhost:3000 (Canvas 2D + HTML HUD).
Tests/typecheck are CI's job — verification means driving the running game.

## Build + launch

```bash
npm run build            # REQUIRED: client JS is served from dist/, tsx only runs the server
npm run dev              # serves http://localhost:3000 (background it; logs show map prebuild)
```

Forgetting `npm run build` gives a page stuck on "Connecting…" with 404s on
`/assets/...` — the HUD renders but the client never boots.

## Drive it (Playwright)

Chromium is preinstalled: `chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })`.
Install playwright into a scratch dir, not the repo. Useful handles:

- Menu: `[data-map="earth-standard"]`, `[data-difficulty="easy"]`, `#startButton`.
  Pick Earth Standard + easy for fast, readable runs.
- Spawn: click open land on `#mapCanvas`. Find land/coast by reading canvas
  pixels (`getImageData`; water ≈ blue-dominant, land ≈ green-dominant) and
  loop candidates until `#selectionInfo` stops saying "Choose a starting location".
- State probes: `#selectionInfo` (orders/ally count/ships at sea), `#statusMessage`
  (last action result), `#leaderboard`, `#actionCards` (alliance cards), `#events`.
- Keys: `q`/`e` zoom, `c` center home, `y` raise attack ratio, `b` TOGGLES boat
  mode (don't spam it — check `#statusMessage` for "Boat attack armed"), `k`
  proposes an alliance to the player under the *cursor* (mouse.move first),
  digits 1–0 arm build/weapon ghosts (3 = port, 7 = warship).
- Transports: arm boat mode, click far coastal land; success shows
  "Expanding toward (x, y) by boat" and `Ships at sea: 1 / 3`.
- Alliances: on easy, bots accept `k` proposals within seconds; the expiring-pact
  card appears in `#actionCards` when a pact enters its renewal window
  (pact = 3000 ticks, window = 300 ticks ≈ last 30s).
- Gold accrues ~1K/s at game start; ports/warships cost 125K+ — budget minutes
  of sim time (or grow territory) before buying.

## Gotchas

- The sim keeps running while Playwright thinks; screenshots are moving targets.
- `renderFrame` gets the rAF timestamp; entity `start` stamps use
  `performance.now()` — keep transient-effect `t` clamped at 0.
- Two browser instances against one dev server is fine (each runs its own
  solo worker match).
