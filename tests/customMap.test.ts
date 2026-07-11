import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCustomGameMap,
  CUSTOM_MAP_FORMAT,
  CUSTOM_MAP_MAX_FILE_CHARS,
  CUSTOM_MAP_MIN_EDGE,
  CUSTOM_MAP_MIN_LAND_TILES,
  decodeCustomMapFile,
  encodeCustomMapFile,
  type CustomMapData,
} from "../src/Core/customMap.js";
import { IMPASSABLE_MAGNITUDE } from "../src/Core/terrainCodec.js";
import { validateCommand } from "../src/Server/validateCommand.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";

/**
 * A hand-built valid editor map: a 96×64 ocean with a 30×30 continent, a
 * painted 2×2 inland lake, a 1-tile river channel across the continent, an
 * impassable ridge and a deliberate 1-tile offshore island.
 */
const makeMap = (): CustomMapData => {
  const width = 96;
  const height = 64;
  const cells = new Uint8Array(width * height);
  for (let y = 10; y < 40; y += 1) {
    for (let x = 20; x < 50; x += 1) cells[y * width + x] = 5;
  }
  // Painted lake (enclosed water) inside the continent.
  for (let y = 20; y < 22; y += 1) for (let x = 30; x < 32; x += 1) cells[y * width + x] = 0;
  // A 1-tile river from the west coast into the interior.
  for (let x = 20; x < 35; x += 1) cells[25 * width + x] = 0;
  // An impassable ridge.
  for (let y = 12; y < 18; y += 1) cells[y * width + 40] = IMPASSABLE_MAGNITUDE;
  // A deliberate 1-tile island offshore (no speckle cleanup may remove it).
  cells[5 * width + 70] = 5;
  return { name: "Test World", width, height, cells };
};

test("custom map files round-trip through encode/decode", () => {
  const original = makeMap();
  const decoded = decodeCustomMapFile(encodeCustomMapFile(original));
  assert.equal(decoded.name, original.name);
  assert.equal(decoded.width, original.width);
  assert.equal(decoded.height, original.height);
  assert.deepEqual([...decoded.cells], [...original.cells]);
});

test("decode rejects malformed or oversized files with descriptive errors", () => {
  const valid = makeMap();
  assert.throws(() => decodeCustomMapFile("not json"), /not valid JSON/);
  assert.throws(
    () => decodeCustomMapFile(JSON.stringify({ format: "ccmap-99" })),
    /Unknown custom map format/,
  );
  assert.throws(
    () => decodeCustomMapFile(encodeCustomMapFile({ ...valid, width: CUSTOM_MAP_MIN_EDGE - 1 })),
    /width must be/,
  );
  // Cell array length must match the declared dimensions.
  assert.throws(
    () => decodeCustomMapFile(encodeCustomMapFile({ ...valid, cells: valid.cells.subarray(0, 100) })),
    /does not match/,
  );
  // Cell values above impassable rock are invalid.
  const badCells = valid.cells.slice();
  badCells[0] = IMPASSABLE_MAGNITUDE + 1;
  assert.throws(
    () => decodeCustomMapFile(encodeCustomMapFile({ ...valid, cells: badCells })),
    /invalid value/,
  );
  // All-water (or nearly) maps are unplayable.
  const water = new Uint8Array(valid.width * valid.height);
  assert.throws(
    () => decodeCustomMapFile(encodeCustomMapFile({ ...valid, cells: water })),
    new RegExp(`at least ${CUSTOM_MAP_MIN_LAND_TILES}`),
  );
  // Impassable rock does not count toward the playability floor.
  const rockOnly = new Uint8Array(valid.width * valid.height).fill(IMPASSABLE_MAGNITUDE);
  assert.throws(
    () => decodeCustomMapFile(encodeCustomMapFile({ ...valid, cells: rockOnly })),
    new RegExp(`at least ${CUSTOM_MAP_MIN_LAND_TILES}`),
  );
  assert.throws(
    () => decodeCustomMapFile("x".repeat(CUSTOM_MAP_MAX_FILE_CHARS + 1)),
    /too large/,
  );
  // Garbage in the cells string must be rejected in every environment. Node's
  // Buffer.from silently skips invalid base64 characters, so without an
  // up-front charset check the server would accept a file that every browser
  // (atob throws) rejects — the same .ccmap must validate identically on both.
  const file = JSON.parse(encodeCustomMapFile(valid)) as Record<string, unknown>;
  assert.throws(
    () => decodeCustomMapFile(JSON.stringify({ ...file, cells: `!!!${file.cells as string}` })),
    /not valid base64/,
  );
});

test("buildCustomGameMap classifies painted water exactly as painted", () => {
  const data = makeMap();
  const map = buildCustomGameMap(data);
  assert.equal(map.width, data.width);
  assert.equal(map.height, data.height);

  const ref = (x: number, y: number): number => y * data.width + x;
  // Border water floods as open ocean.
  assert.ok(map.isOcean(ref(0, 0)), "border water is ocean");
  // The river channel touches the west-coast ocean, so it floods as ocean too —
  // a navigable corridor, same as carved rivers on the Earth maps.
  assert.ok(map.isWater(ref(30, 25)) && map.isOcean(ref(30, 25)), "river is ocean-connected");
  // The enclosed painted lake stays a lake.
  assert.ok(map.isWater(ref(30, 20)) && !map.isOcean(ref(30, 20)), "painted lake stays a lake");
  // No speckle cleanup: the deliberate 1-tile island survives.
  assert.ok(map.isLand(ref(70, 5)), "one-tile painted island survives");
  // Continent interior is land.
  assert.ok(map.isLand(ref(22, 12)), "painted land is land");
});

test("a session runs on a custom map delivered as a prebuilt GameMap", () => {
  const data = decodeCustomMapFile(encodeCustomMapFile(makeMap()));
  const session = new RasterGameSession({
    prebuiltMap: buildCustomGameMap(data),
    mapName: data.name,
    startingTroops: 500,
  });
  session.subscribe("human", () => {}, /*autoSpawn*/ false);
  session.selectSpawn("human", 22, 12);
  session.tick();
  assert.ok(session.peekGrid().tileCountOf(1) > 0, "player spawned and holds painted land");
});

test("join validation gates customMap shape and the lockstep combination", () => {
  const file = encodeCustomMapFile(makeMap());
  const ok = validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { customMap: file } });
  assert.equal(ok.type, "CLIENT_RASTER_JOIN");
  assert.equal((ok as { payload: { customMap?: string } }).payload.customMap, file);

  assert.throws(
    () => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { customMap: 42 } }),
    /customMap must be/,
  );
  assert.throws(
    () =>
      validateCommand({
        type: "CLIENT_RASTER_JOIN",
        payload: { customMap: "x".repeat(CUSTOM_MAP_MAX_FILE_CHARS + 1) },
      }),
    /too large/,
  );
  assert.throws(
    () => validateCommand({ type: "CLIENT_RASTER_JOIN", payload: { customMap: file, lockstep: true } }),
    /lockstep/,
  );
});

test("the format tag is stable — files name the format they carry", () => {
  const parsed = JSON.parse(encodeCustomMapFile(makeMap())) as { format: string };
  assert.equal(parsed.format, CUSTOM_MAP_FORMAT);
});
