# AI balancing & behaviour: OpenFront parity

The AI opponents (Nations and the passive Bot/Tribe fillers) are balanced and
behave per openfront.io's current implementation. OpenFront is AGPL-3.0, so
its code is **not** copied — its behaviour constants and decision rules (facts,
not expression) were extracted from a reading of upstream `main` and
reimplemented natively against this engine's grid/session APIs. This file is
the parity ledger: what matches exactly, and where this engine deliberately
diverges.

## What matches OpenFront exactly

### Seat handicaps (already matched before this rewrite)
- Start manpower: Bot 10,000 flat; Nation 12,500 / 18,750 / 25,000 / 31,250 by
  difficulty (Hard = a human's 25,000).
- Troop ceiling: `2·(tiles^0.6·1000 + 50,000) + 250,000·cityLevels`, then Bot ÷3;
  Nation ×0.5 / ×0.75 / ×1 / ×1.25 by difficulty.
- Growth: bell curve `(10 + troops^0.73/4)·(1 − troops/max)`; Bot ×0.5;
  Nation ×0.9 / ×0.95 / ×1 / ×1.05.
- Gold: 100/tick base (Bot 50/tick).

### The per-seat dice (`src/Server/RasterBotController.ts`)
Every AI seat owns a seeded PRNG (sfc32, the same public-domain generator
OpenFront uses) and rolls once at seating:
- attack cadence — Nation `nextInt(65,100)/(55,70)/(45,60)/(30,50)` ticks by
  difficulty, Tribe `nextInt(40,80)`; plus a phase offset inside the cycle;
- `triggerRatio` 50–59%, `reserveRatio` 30–39%, `expandRatio` 10–19% of the
  troop ceiling;
- "hydro nation" flag at 1-in-3 (that seat throws only hydrogen bombs unless
  fighting for its life).

### The shared attack brain (OpenFront `AiAttackBehavior`)
- Opening move: half the pool at neutral land the moment the seat goes live.
- Neutral land is always taken first (fallout ground excluded; the dedicated
  `nuked` strategy walks into the glow when nothing clean remains).
- Random boat probes: 1-in-5 odds when no enemies border us, 1-in-10 when they
  do; target scan ±150 tiles around a random own shore tile, preferring unowned
  or tribe coast; boats carry `troops/5`; never at a bordering player or (in
  FFA) someone stronger; engine cap of 3 transports.
- Gates: bank to the reserve ratio, then to the trigger ratio — with
  OpenFront's 1-in-10 early-strike roll.
- Strategy order by difficulty (Easy dumbest → Impossible sharpest):
  - Easy: nuked, bots, retaliate, assist, betray, hated, weakest
  - Medium: bots, nuked, retaliate, assist, betray, hated, traitor, weakest, island
  - Hard: bots, retaliate, assist, betray, nuked, traitor, hated, veryWeak, victim, weakest, island
  - Impossible: retaliate, bots, veryWeak, assist, traitor, betray, victim, nuked, hated, weakest, island
- **Anti-human throttle** (`shouldAttack`): Easy nations follow through on only
  1-in-4 attack decisions against a human, Medium 3-in-4, Hard/Impossible
  always. Neutral land, tribes and traitors are always fair game; tribes never
  hold back; retaliation bypasses the throttle.
- Hard/Impossible home guard (`troopSendCap`): never drop the pool below 75% /
  90% of the strongest non-allied, non-tribe neighbour's troops — except a
  nation under attack may answer with at least the incoming force. Both tiers
  also skip attacks under 20% of the target's troops.
- Tribe farming: a nation strikes a bordering tribe with 4× the tribe's pool,
  skipping when its budget can't spare 2× (Easy dumps the whole budget);
  parallelism 1 / 1–2 / 3 / all by difficulty, weakest density first.
- Retaliation reads **live** incoming attacks (largest first); nations ignore
  tribe raids when choosing whom to retaliate against, tribes answer anyone.
- Strategy details: `victim` = a rival with >50% of their troops already under
  incoming attack; `veryWeak` = under 15% of their ceiling; `weakest` = the
  weakest bordering enemy, only if weaker than us; `traitor` = a marked traitor
  under 1.2× our troops; `hated` = worst-relation player (≤3× our troops).

### Tribes (OpenFront `TribeExecution`)
Accept every alliance offer and second every extension request; punish a
bordering traitor at 1-in-3 odds (1-in-6 for a traitor *ally*, pact broken
first); blanket bordering neutral land until none remains (then latch that
scan off for good); once boxed in, bank to the trigger ratio, retaliate
against the largest incoming attack, then poke a random neighbour — nations
and humans skipped half the time.

### Relations (`src/Core/relations.ts`)
Attitude per player pair in [-100, 100], decaying 0.05/tick toward 0; tiers at
−50 (hostile) / 0 (distrustful) / 50 (friendly). Deltas: being attacked
−60/−70/−80/−100 by difficulty; alliance sealed +100 both ways; betrayal −100
for the victim and −40 for every onlooking neighbour; troop donation +50; gold
donation +5 per difficulty-scaled chunk (2.5K/5K/12.5K/25K, inflating with
match age); embargo −20 (returned when lifted); target request −40; friendly
emoji +15, hostile emoji −10. Relations drive the `hated` strategy, alliance
decisions, nuke grudges, and embargo automation (hostile → embargo; lifted at
neutral, but Hard holds until friendly and Impossible never forgives).

### Alliance judgement (OpenFront `NationAllianceBehavior`)
In gate order: coin-flip confusion (Easy 1/10, Medium 1/20, Hard 1/40,
Impossible never) → 90% traitor refusal → over-allied caps (Hard: ally count ≥
50% of non-tribe players; Impossible: 25%) → per-difficulty threat appraisal
(a real threat is appeased) → grudges refuse → friendly relations accept
(Hard 83%, Impossible 67%) → enough-allies caps (Medium 4–6; Hard 3–5 and
Impossible 2–4 with the keep-one-free-neighbour rule) → earlygame honeymoon
(Easy: 90% accept in the first 5 min; Medium 70%/3 min; Hard 50%/3 min;
Impossible 30%/1 min) → similar-strength bands. Requests go out at 1-in-30 per
bordering enemy (only Easy courts tribes). Betrayal: Hard+ eat an ally under
20% of their ceiling who is weaker; Easy/Medium use the blunt 10× rule (but an
Easy nation never betrays a human); non-Easy tiers punish traitor allies under
1.2× and eat a sole neighbour 3× weaker.

### Structures (OpenFront `NationStructureBehavior`)
Cities are the default sink; other structures follow per-city ratios — ports
0.75, factories 0.75 (×0.33 once the coast trades), SAMs 0.15/0.2/0.25/0.3 by
difficulty, silos 0.2 (first at 0.4, hard cap 3). Perceived costs inflate per
owned structure (city/port/factory/silo ×(1+owned), SAM ×(1+0.3·owned)) while
the treasury is short of the MIRV+hydrogen stockpile target, so nations save
organically. Past 1 structure per 1,500 tiles they upgrade instead of building.
Defense posts are purely reactive: never on Easy; Medium one post at 50% odds;
Hard/Impossible one per 40% of the incoming-to-own-troops ratio, placed by the
pressed border, triggered at a 35% incoming ratio — and other spending holds
while the wall is due. Structure placement also runs at 1/3 and 2/3 of the
attack interval so a rich economy never outruns its spending. Warships: at most
one patrol ship, rolled at 1-in-50 per decision.

### Nukes (OpenFront `NationNukeBehavior`)
Target priority: endgame duel (Hard+ with two players left) → retaliation →
ally target requests → most-hated (skipped when we're twice their size) → FFA
crown once its land-share lead exceeds 0.4/0.3/0.2/0.1 by difficulty
(Impossible-as-crown targets second place). Never a tribe, never an ally, and
the anti-human throttle applies. Hydrogen preferred when affordable; atom only
for non-hydro nations or anyone under heavy attack (incoming ≥ own troops).
Perceived warhead costs rise ×1.5 (atom) / ×1.25 (hydrogen) per launch until
the MIRV+hydrogen stockpile is banked — OpenFront's simulated saving that
stops atom spam.

### Field composition (unchanged, already calibrated)
~16% Nations / 84% Tribes (OpenFront World: 75 nations + 400 bots), seat
density anchored to OpenFront World's ~1,370 land tiles per seat.

## Deliberate divergences (documented, not silent)

- **No MIRV launches.** Nations save toward the MIRV+hydrogen stockpile
  (which is what shapes their spending) but never fire one.
- **Simplified nuke aiming.** Deep-territory sampling away from our shared
  border; OpenFront additionally scores structure clusters and (Hard+) avoids
  SAM-interceptable trajectories.
- **`island` strategy approximation.** Weakest reachable enemy globally
  (1-in-3 the second-weakest) instead of bounding-box distance sorting.
- **No `afk` or team-game strategies** (no disconnect tracking; no teams).
- **Stolen-structure branches are moot**: this engine demolishes buildings on
  capture, so tribes can never own structures and nations never need the
  recapture-priority path or tribe structure deletion.
- **Emoji relations are mapped** onto this engine's 8-emoji set (👍🤝🫡 = +15,
  👎😡💀 = −10) rather than OpenFront's larger table; nation emoji chatter is
  limited to alliance responses and betrayals.
- **No warship retaliation ships** (OpenFront spawns extra warships at
  15/50/80% odds when its ships are sunk; this engine keeps the single patrol).
