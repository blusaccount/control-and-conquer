import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { encodeOwnerDelta } from "../src/Server/rasterSerialization.js";
import { RasterGameSession } from "../src/Server/RasterGameSession.js";
import type { RasterServerMessage } from "../src/Core/types.js";

/** Apply a packed owner delta (6 bytes/record) onto a mirror array. */
const applyDelta = (mirror: Uint16Array, deltaBase64: string): void => {
  const bytes = Buffer.from(deltaBase64, "base64");
  const records = Math.floor(bytes.length / 6);
  for (let k = 0; k < records; k += 1) {
    mirror[bytes.readUInt32LE(k * 6)] = bytes.readUInt16LE(k * 6 + 4);
  }
};

test("encodeOwnerDelta encodes only changed tiles and advances the baseline", () => {
  const prev = new Uint16Array([0, 0, 0, 0, 0]);
  const curr = new Uint16Array([0, 5, 0, 7, 0]);
  const mirror = Uint16Array.from(prev);

  const { deltaBase64, changed } = encodeOwnerDelta(prev, curr);
  assert.equal(changed, 2, "two tiles changed");

  applyDelta(mirror, deltaBase64);
  assert.deepEqual(Array.from(mirror), Array.from(curr), "delta reconstructs curr");
  assert.deepEqual(Array.from(prev), Array.from(curr), "baseline advanced in place");
});

test("a stream of deltas keeps a mirror in sync with the source", () => {
  const source = new Uint16Array(20);
  const baseline = Uint16Array.from(source);
  const mirror = Uint16Array.from(source);

  for (const [i, v] of [[3, 1], [3, 2], [10, 4], [3, 4], [19, 9]] as [number, number][]) {
    source[i] = v;
    const { deltaBase64 } = encodeOwnerDelta(baseline, source);
    applyDelta(mirror, deltaBase64);
    assert.deepEqual(Array.from(mirror), Array.from(source));
  }
});

test("wire snapshots reconstruct the server's owner raster via full + deltas", () => {
  const session = new RasterGameSession({ width: 40, height: 28, seed: 7 });
  const messages: RasterServerMessage[] = [];
  session.subscribe("human", (m) => messages.push(m));

  // Drive expansion so ownership actually changes across ticks.
  let mirror: Uint16Array | null = null;
  let sawDelta = false;
  for (let t = 0; t < 12; t += 1) {
    session.queueExpand("human", { targetX: 1, targetY: 1, percent: 80 });
    session.tick();
  }

  for (const m of messages) {
    if (m.type !== "SERVER_RASTER_SNAPSHOT") continue;
    const snap = m.payload;
    if (snap.ownerBase64 !== undefined) {
      const bytes = Buffer.from(snap.ownerBase64, "base64");
      mirror = new Uint16Array(snap.width * snap.height);
      for (let i = 0; i < mirror.length; i += 1) mirror[i] = bytes.readUInt16LE(i * 2);
    } else if (snap.ownerDeltaBase64 !== undefined && mirror) {
      sawDelta = true;
      applyDelta(mirror, snap.ownerDeltaBase64);
    }
  }

  assert.ok(mirror, "client established an owner baseline");
  assert.ok(sawDelta, "later snapshots were sent as deltas");
  const grid = session.peekGrid();
  assert.deepEqual(Array.from(mirror!), Array.from(grid.owner), "reconstruction matches server state");
});
