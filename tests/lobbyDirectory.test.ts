import test from "node:test";
import assert from "node:assert/strict";
import { MatchRegistry } from "../src/Server/MatchRegistry.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { encodeCustomMapFile, decodeCustomMapFile, buildCustomGameMap } from "../src/Core/customMap.js";
import { CRESTS, isValidCrest, startsWithCrest, withCrest } from "../src/Core/identity.js";
import { IMPASSABLE_MAGNITUDE } from "../src/Core/terrainCodec.js";
import type { RasterServerMessage } from "../src/Core/types.js";
import type { RasterLockstepStartPayload } from "../src/Core/lockstep.js";

// ---------------------------------------------------------------------------
// The multiplayer homepage contract: a public lobby directory, player identity
// (name + crest) through the lobby flow, and player-made maps in lobbies
// delivered to replicas via a transient map token.
// ---------------------------------------------------------------------------

const makeClient = () => {
  const messages: RasterServerMessage[] = [];
  return { messages, send: (m: RasterServerMessage) => messages.push(m) };
};

/** A small, valid painted map (one solid continent with a coast on all sides). */
const paintedMap = (): string => {
  const width = 96;
  const height = 64;
  const cells = new Uint8Array(width * height);
  for (let y = 8; y < 56; y += 1) {
    for (let x = 12; x < 84; x += 1) cells[y * width + x] = 5;
  }
  return encodeCustomMapFile({ name: "Painted Isle", width, height, cells });
};

test("identity helpers: crest validation, composition, and detection", () => {
  assert.ok(CRESTS.length >= 32, "a decent crest selection");
  assert.ok(isValidCrest("🦁") && isValidCrest("🇩🇪"));
  assert.ok(!isValidCrest("💩") && !isValidCrest("") && !isValidCrest(42));
  assert.equal(withCrest("Lukas", "🇩🇪"), "🇩🇪 Lukas");
  assert.equal(withCrest("Lukas", "💩"), "Lukas", "unknown crests are dropped, not embedded");
  assert.ok(startsWithCrest("🇩🇪 Lukas"));
  assert.ok(!startsWithCrest("Lukas"), "plain names keep the auto emoji");
});

test("join/lobby validation accepts identity fields and rejects junk crests", () => {
  const join = validateCommand({
    type: "CLIENT_RASTER_JOIN",
    payload: { name: "Lukas", crest: "🇩🇪" },
  });
  assert.equal(join.type, "CLIENT_RASTER_JOIN");
  assert.deepEqual(
    (join as { payload: { name?: string; crest?: string } }).payload,
    { name: "Lukas", crest: "🇩🇪" },
  );
  assert.throws(
    () => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { crest: "💩" } }),
    /crest/,
  );
  assert.throws(
    () => validateCommand({ type: "CLIENT_RASTER_LOBBY_CREATE", payload: { lobbyName: "<script>" } }),
    /name must be/,
  );
});

test("the lobby directory lists open rooms with host identity and seats", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const guest = makeClient();

  assert.deepEqual(registry.listOpenLobbies(), [], "empty directory before any room opens");

  const code = registry.createLobby(
    "host-1",
    host.send,
    "earth-standard",
    "Earth — Standard",
    { realMapId: "earth", mapSize: 640 },
    "hard",
    40,
    "Kai",
    "🇩🇪",
    "Feierabendrunde",
  );
  registry.joinLobby("guest-1", guest.send, code, "Anna", "🦊");

  const entries = registry.listOpenLobbies();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.code, code);
  assert.equal(entry.lobbyName, "Feierabendrunde");
  assert.equal(entry.hostName, "Kai");
  assert.equal(entry.hostCrest, "🇩🇪");
  assert.equal(entry.mapName, "Earth — Standard");
  assert.equal(entry.customMap, false);
  assert.equal(entry.difficulty, "hard");
  assert.equal(entry.members, 2);
  assert.ok(entry.maxMembers >= entry.members);
  assert.equal(entry.fieldSize, 40);

  // The waiting room broadcast carries each member's crest and the room title.
  const state = host.messages.findLast((m) => m.type === "SERVER_RASTER_LOBBY_STATE");
  assert.ok(state && state.type === "SERVER_RASTER_LOBBY_STATE");
  assert.equal(state.payload.lobbyName, "Feierabendrunde");
  assert.deepEqual(
    state.payload.members.map((m) => `${m.crest ?? "?"} ${m.name}`),
    ["🇩🇪 Kai", "🦊 Anna"],
  );

  // A room without an explicit title gets a sensible default.
  const other = makeClient();
  registry.createLobby("host-2", other.send, "earth-large", "Earth — Large", {}, "medium", undefined, "Mika");
  const names = registry.listOpenLobbies().map((e) => e.lobbyName);
  assert.ok(names.includes("Mika's lobby"), `default room title, got ${names.join(", ")}`);

  // Leaving dissolves the room and the directory reflects it.
  registry.leaveLobby("host-2");
  assert.equal(registry.listOpenLobbies().length, 1);
});

test("a custom-map lobby starts a lockstep match whose map replicas fetch by token", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const guest = makeClient();
  const file = paintedMap();
  const data = decodeCustomMapFile(file);

  const code = registry.createLobby(
    "host-1",
    host.send,
    "earth-standard",
    "Earth — Standard",
    // Production passes the catalogue options along even for a custom-map
    // lobby — the prebuilt custom map must still win over this realMapId
    // (regression: the heightmap resolution used to override it).
    { realMapId: "earth", mapSize: 640 },
    "medium",
    3,
    "Kai",
    "🇩🇪",
    undefined,
    { map: buildCustomGameMap(data), name: data.name },
  );
  registry.joinLobby("guest-1", guest.send, code, "Anna", "🦊");

  // The directory flags the painted map and shows its name.
  const entry = registry.listOpenLobbies()[0];
  assert.equal(entry.customMap, true);
  assert.equal(entry.mapName, "Painted Isle");

  registry.startLobby("host-1");

  const setupMsg = host.messages.find((m) => m.type === "SERVER_RASTER_LOCKSTEP_START");
  assert.ok(setupMsg && setupMsg.type === "SERVER_RASTER_LOCKSTEP_START");
  const setup = setupMsg.payload as RasterLockstepStartPayload;
  assert.equal(setup.mapName, "Painted Isle");
  assert.ok(setup.mapToken, "the setup carries a transient map token");

  // The token resolves to the exact same terrain the referee session runs on —
  // byte-identical, which is what the replica's terrain hash check needs.
  const served = registry.getMapByToken(setup.mapToken!);
  assert.ok(served, "the token serves the map while the match runs");
  const expected = buildCustomGameMap(data);
  assert.equal(served!.width, expected.width);
  assert.equal(served!.height, expected.height);
  assert.deepEqual([...served!.terrain], [...expected.terrain]);
  // The decisive replica check: a session built from the served map must hash
  // to what the setup promises (i.e. the referee really ran the painted map).
  const replica = new RasterGameSession({ prebuiltMap: served! });
  assert.equal(replica.peekTerrainHash(), setup.terrainHash, "referee runs the painted map");

  // Seat names carry the members' crests into the match.
  const seatNames = setup.seats.filter((s) => s.kind === "human").map((s) => s.name);
  assert.deepEqual(seatNames, ["🇩🇪 Kai", "🦊 Anna"]);

  assert.equal(registry.getMapByToken("no-such-token"), undefined);
});

test("catalogue lobbies carry no map token", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  registry.createLobby("host-1", host.send, "earth-standard", "Earth — Standard", { realMapId: "earth", mapSize: 640 }, "easy", 2, "Kai");
  registry.startLobby("host-1");
  const setupMsg = host.messages.find((m) => m.type === "SERVER_RASTER_LOCKSTEP_START");
  assert.ok(setupMsg && setupMsg.type === "SERVER_RASTER_LOCKSTEP_START");
  assert.equal((setupMsg.payload as RasterLockstepStartPayload).mapToken, undefined);
});

test("a reaped custom-map match keeps its map token fetchable through a linger window", () => {
  const registry = new MatchRegistry();
  const host = makeClient();
  const data = decodeCustomMapFile(paintedMap());
  const code = registry.createLobby(
    "host-1",
    host.send,
    "earth-standard",
    "Earth — Standard",
    { maxDurationTicks: 20 },
    "easy",
    0,
    "Kai",
    undefined,
    undefined,
    { map: buildCustomGameMap(data), name: data.name },
  );
  assert.ok(code);
  registry.startLobby("host-1");
  const setupMsg = host.messages.find((m) => m.type === "SERVER_RASTER_LOCKSTEP_START");
  assert.ok(setupMsg && setupMsg.type === "SERVER_RASTER_LOCKSTEP_START");
  const setup = setupMsg.payload as RasterLockstepStartPayload;
  assert.ok(setup.mapToken, "the setup carries a transient map token");

  // Play past the time limit so the reaper sweeps the ended match.
  for (let i = 0; i < setup.spawnPhaseTicks + 25; i += 1) registry.tickAll();
  assert.equal(registry.getActiveRasterMatchCount(), 0, "the ended match was reaped");
  // A replica that resumed just before the end may still have its terrain
  // fetch in flight; the token must keep resolving briefly after the reap
  // instead of 404ing that fetch into a fatal boot error.
  assert.ok(registry.getMapByToken(setup.mapToken!), "the map token lingers past the reap");
});

test("crest cells cannot smuggle invalid values into a painted lobby map", () => {
  // (Guard the adjacent seam too: the custom map path in a lobby still runs
  // the full .ccmap validation, so a corrupt file never reaches a session.)
  const width = 96;
  const height = 64;
  const cells = new Uint8Array(width * height).fill(5);
  cells[0] = IMPASSABLE_MAGNITUDE + 7;
  const bad = encodeCustomMapFile({ name: "Bad", width, height, cells });
  assert.throws(() => decodeCustomMapFile(bad), /invalid value/);
});
