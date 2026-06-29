import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { modifiersForPerks, IDENTITY_MODIFIERS } from "../src/Core/perks.js";
import { INCOME_PER_TILE_PER_TICK } from "../src/Core/rasterCombatConfig.js";
import { SIMULATION_TICK_RATE } from "../src/Server/simulationConfig.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

type Offer = Extract<RasterServerMessage, { type: "SERVER_PERK_OFFER" }>;
type Snap = Extract<RasterServerMessage, { type: "SERVER_RASTER_SNAPSHOT" }>;

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const firstOffer = (messages: RasterServerMessage[]): Offer | undefined =>
  messages.find((m): m is Offer => m.type === "SERVER_PERK_OFFER");

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  const snaps = messages.filter((m): m is Snap => m.type === "SERVER_RASTER_SNAPSHOT");
  return snaps[snaps.length - 1].payload;
};

test("a perk offer is broadcast on the interval and a valid pick applies its modifiers", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3, perkIntervalTicks: 2 });
  const messages = collect(session, "human");
  session.tick(); // tick 1 — no offer
  session.tick(); // tick 2 — offer round 1

  const offer = firstOffer(messages);
  assert.ok(offer, "an offer should be broadcast at the interval");
  assert.equal(offer!.payload.options.length, 3);
  assert.equal(offer!.payload.offerNumber, 1);

  const pick = offer!.payload.options[0];
  session.choosePerk("human", pick);
  assert.deepEqual(session.peekGrid().modifiersOf(1), modifiersForPerks([pick]));
});

test("choosing a perk that was not offered is ignored", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3, perkIntervalTicks: 2 });
  const messages = collect(session, "human");
  session.tick();
  session.tick();
  const offer = firstOffer(messages)!;

  // Pick a perk guaranteed not to be in this round's offer.
  const notOffered = (["swift-attacker", "fortress-wall", "sea-god", "growth-driver"] as const).find(
    (p) => !offer.payload.options.includes(p),
  )!;
  session.choosePerk("human", notOffered);
  assert.deepEqual(session.peekGrid().modifiersOf(1), IDENTITY_MODIFIERS);
});

test("a growth perk raises the troopsPerSecond reported in snapshots", () => {
  const session = new RasterGameSession({ width: 32, height: 24, seed: 3, perkIntervalTicks: 2 });
  const messages = collect(session, "human");
  // Round 2's offer (rotated window) includes growth-driver.
  session.tick();
  session.tick(); // offer round 1
  session.tick();
  session.tick(); // offer round 2 -> includes growth-driver

  const offers = messages.filter((m): m is Offer => m.type === "SERVER_PERK_OFFER");
  const growthOffer = offers.find((o) => o.payload.options.includes("growth-driver"));
  assert.ok(growthOffer, "a later round should offer growth-driver");

  session.choosePerk("human", "growth-driver");
  session.tick(); // broadcast a fresh snapshot reflecting the new modifier

  const snap = lastSnapshot(messages);
  const me = snap.players.find((p) => p.playerId === 1)!;
  const expected = me.tiles * INCOME_PER_TILE_PER_TICK * SIMULATION_TICK_RATE * 1.3;
  assert.ok(Math.abs(me.troopsPerSecond - expected) < 1e-9, "rate should include the +30% growth perk");
});
