import test from "node:test";
import assert from "node:assert/strict";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { buildTerrainFromMask } from "../src/Core/terrainBuilder.js";
import { NEUTRAL_PLAYER } from "../src/Core/TerritoryGrid.js";
import type { RasterServerMessage, RasterSnapshot } from "../src/Core/types.js";

const collect = (session: RasterGameSession, clientId: string): RasterServerMessage[] => {
  const messages: RasterServerMessage[] = [];
  session.subscribe(clientId, (m) => messages.push(m));
  return messages;
};

const lastSnapshot = (messages: RasterServerMessage[]): RasterSnapshot => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.type === "SERVER_RASTER_SNAPSHOT") return m.payload;
  }
  throw new Error("no snapshot seen");
};

const mapFromRows = (rows: string[]) => {
  const height = rows.length;
  const width = rows[0].length;
  const land = new Uint8Array(width * height);
  const elevation = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (rows[y][x] !== ".") land[y * width + x] = 1;
  return buildTerrainFromMask({ width, height, land, elevation });
};

// Regression for the reported bug, now covered by OpenFront's routing model: an
// enemy nation wedged between two coasts of the SAME landmass. Under OpenFront's
// `canAttack`, a march onto a *player's* tile needs a shared border — which we
// don't have here — and the neutral-corridor march can't thread through a third
// party's ground, so both land tests fail and the click correctly becomes a
// transport ship across the bay instead of a rejection.
test("an enemy wedged between two coasts: a click across the bay sends a boat, not a rejection", () => {
  //   # . #      col0 = attacker, col2 = target, col1 = a bay (water)
  //   # . #      the bottom row joins the two arms into ONE landmass, but the
  //   # # #      join tile (1,2) is held by a third-party enemy, so no land front
  //              can pass between the attacker and the target.
  const map = mapFromRows(["#.#", "#.#", "###"]);
  const session = new RasterGameSession({ prebuiltMap: map, startingTroops: 200, spawnPhaseTicks: 0 });
  const messages = collect(session, "human"); // seats player 1 somewhere
  const grid = session.peekGrid();

  // Wipe the auto-spawn and hand-author the scenario deterministically.
  for (let ref = 0; ref < map.size; ref += 1) if (grid.ownerOf(ref) !== NEUTRAL_PLAYER) grid.claim(ref, NEUTRAL_PLAYER);
  if (!grid.hasPlayer(2)) grid.addPlayer(2, 50);
  if (!grid.hasPlayer(3)) grid.addPlayer(3, 50);
  for (let y = 0; y < 3; y += 1) grid.claim(map.ref(0, y), 1); // attacker's coast
  for (let y = 0; y < 3; y += 1) grid.claim(map.ref(2, y), 2); // target's coast across the bay
  grid.claim(map.ref(1, 2), 3); // enemy on the only land bridge between them

  // Sanity: the two coasts share a landmass but the attacker cannot border the
  // target by land — the enemy sits on the sole join.
  assert.equal(grid.landComponentId(map.ref(0, 0)), grid.landComponentId(map.ref(2, 0)), "one landmass");
  assert.equal(grid.hasLandBorderWith(1, 2), false, "no land border with the target");

  session.queueExpand("human", { targetX: 2, targetY: 0, percent: 100 });
  session.tick();

  assert.equal(
    messages.find((m) => m.type === "SERVER_RASTER_ACTION_REJECTED"),
    undefined,
    "the click across the bay must not be rejected",
  );
  const snap = lastSnapshot(messages);
  assert.equal(snap.ships.filter((s) => s.playerId === 1).length, 1, "a transport ship is dispatched across the bay");
});
