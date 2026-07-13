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
  - Medium: bots, nuked, retaliate, assist, betray, hated, afk, traitor, weakest, island
  - Hard: bots, retaliate, assist, betray, nuked, traitor, afk, hated, veryWeak, victim, weakest, island
  - Impossible: retaliate, bots, veryWeak, assist, traitor, afk, betray, victim, nuked, hated, weakest, island
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
  under 1.2× our troops; `hated` = worst-relation player (≤3× our troops);
  `afk` = a disconnected human seat (the session tracks socket state per seat,
  so a player who went dark is easy prey); `island` = when no enemy borders us,
  boat the nearest rival by territory-centroid Manhattan distance (1-in-3 the
  second-nearest), falling through the sorted list until a landing sticks.
- Nations pre-gate `bots`: a bordering tribe that owns structures (captured
  ground) is attacked before the ordinary strategy walk, structure-holders
  sorted first — OpenFront's steal-back priority.

### Tribes (OpenFront `TribeExecution`)
Accept every alliance offer and second every extension request; punish a
bordering traitor at 1-in-3 odds (1-in-6 for a traitor *ally*, pact broken
first); blanket bordering neutral land until none remains (then latch that
scan off for good); once boxed in, bank to the trigger ratio, retaliate
against the largest incoming attack, then poke a random neighbour — nations
and humans skipped half the time. A tribe that captures a structure deletes
it (one per decision beat) — passive fillers keep no economy, exactly
OpenFront's tribe-structure rule.

### Capture semantics (engine-level, OpenFront's conquest rules)
A structure whose tile changes hands **transfers to the conqueror intact**
(level and upgrade-ramp books move with it). Upstream's exceptions match:
Defense Posts are razed on capture, and ground falling to *neutral* keeps
nothing. Tribe deletion of captured structures rides the lockstep wire as
its own command (`CLIENT_RASTER_DELETE`) so replays stay bit-identical.

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

**Aiming is OpenFront's scored search.** Candidates are random samples of the
victim's territory (10, Impossible 30) plus their structure tiles; a candidate
survives only if the whole blast box is legitimate ground (Easy/Medium:
strictly the target's own land; Hard/Impossible also allow neutral), then
scores by the structures the blast erases — city 25K, silo 50K, port/factory
15K, fort 5K, each ×level. Medium rejects any aim with a SAM inside 50 tiles;
Impossible hydro-nations add +100K for a SAM the blast outranges (hydro outer
100 vs `SAM_RANGE` 70). Distance from the launching silo costs ×30 per tile
(floored at 20% of the score), a fresh own crater is −1M for 600 ticks, and
Hard/Impossible sample the straight-line flight path and drop aims a SAM would
intercept (nuke flight here is linear, so the check is exact). Impossible
fires only at strictly positive value.

### MIRV programme (OpenFront `NationMIRVBehavior`)
Checked at the top of every decision beat, gated on a ready silo, the full
MIRV price (25M + 15M per owned silo) and a hesitation roll (chance 1-in-2 /
4 / 8 / 16 by difficulty). Three triggers, top first: **counter-MIRV** (the
largest rival with a MIRV inbound on our land), **victory denial** (a rival's
land share past 0.75 / 0.65 / 0.55 / 0.4 by difficulty), **steamroll stop**
(the city leader once ahead of second place by ×2 / 1.5 / 1.25 / 1.15 with at
least 20 / 10 / 10 / 8 cities). Never a tribe, never an ally; a shared
300-tick per-victim cooldown stops pile-ons; the aim is the victim's
territory centroid; the launch is announced with a broadcast 💀.

### Warships (OpenFront `NationWarshipBehavior`)
Beyond the 1-in-50 patrol roll, non-Easy nations with a port run naval
awareness **every tick** (not just decision beats): a trade ship lost to
capture answers with a retaliation warship at 15 / 50 / 80% odds by
difficulty (fleet-capped at 10, an angry 😡 to the offender), and ship losses
feed relations (−7.5 trade, −15 transport). Incoming enemy transports at
least 20 tiles out with no own warship within 90 of the landing point get the
same retaliation roll — the interceptor spawns on the transport's track.

### Emoji chatter (OpenFront `NationEmojiBehavior`)
Mapped onto this engine's 8-emoji set. Targeted emoji go to humans only, one
per recipient per 300 ticks (upstream's limiter); broadcasts float over own
land. Per decision beat: 💀 broadcast when incoming ≥3× own troops (1-in-16),
😂 at an attacker under 10% of our pool (1-in-8), 🔥 broadcast as land-share
leader (1-in-300), 👍/🤝 to a random ally (1-in-250), 😂 at a freshly nuked
rival (1-in-40), 👎 to a long-match rival (after tick 6000, 1-in-10000), 👍
to a human in the opening minute (1-in-250). Launching an attack sends 🔥 at
1-in-2 odds against a neutral-or-better relation (an unprovoked strike) or 😡
at 1-in-4 when the grudge already exists; the biggest surviving nation
salutes (🫡) a human winner once, and alliance/betrayal reactions ride the
relations ledger (±15 / −10).

### Field composition (unchanged, already calibrated)
~16% Nations / 84% Tribes (OpenFront World: 75 nations + 400 bots), seat
density anchored to OpenFront World's ~1,370 land tiles per seat.

## Deliberate divergences (documented, not silent)

- **No team games**, so team-only behaviour (the `donate` strategy, team
  assists, the 95% team win) has no counterpart here.
- **Structures still under construction are razed on capture** (upstream
  transfers the construction site with the ground).
- **Emoji are mapped** onto this engine's 8-emoji set (👍🤝🫡 = +15,
  👎😡💀 = −10 in relations) rather than OpenFront's larger table — the
  chatter *triggers* match, the glyphs differ.
- **Counter-warship-infestation is not ported** (upstream floods a rival's
  home waters with warships when its patrol keeps getting sunk there;
  this engine's answer stops at the per-loss retaliation roll).
- **Impossible's destroy-enemy-SAM fallback is not ported** (upstream's
  Impossible tier may upgrade a silo specifically to out-range a blocking
  SAM; here the +100K outranged-SAM aim bonus covers the same instinct).
