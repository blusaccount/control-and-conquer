import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The solo Web Worker runs the real simulation in the browser, so nothing in its
 * import graph may pull a Node built-in (`node:fs`, `node:zlib`, `node:http`, …)
 * — those don't exist in a worker and would crash it on load. This guards that
 * invariant at the source level so a stray import is caught in CI, not in a
 * browser.
 */
const workerEntries = [
  "src/Client/solo/soloWorker.ts",
  // The lockstep replica worker hosts the same sim off the relay-turn stream —
  // same browser constraints, same invariant.
  "src/Client/lockstep/lockstepWorker.ts",
];

test("the sim worker import graphs are free of Node built-ins", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));

  const seen = new Set<string>();
  const nodeHits: string[] = [];
  const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;

  const scan = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith("node:")) {
        nodeHits.push(`${file.replace(root, "")} -> ${spec}`);
      } else if (spec.startsWith(".")) {
        scan(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
  };

  for (const entry of workerEntries) scan(resolve(root, entry));

  assert.ok(seen.size > 1, "scanned the workers' transitive imports");
  assert.deepEqual(
    nodeHits,
    [],
    `a sim worker reaches Node built-ins (breaks in the browser):\n${nodeHits.join("\n")}`,
  );
});

/**
 * Every `CLIENT_RASTER_*` message the client can send must be handled by the
 * solo worker, or that action silently no-ops in offline play (exactly how the
 * nuke launch was dropped once). Guards against the networked path and the
 * worker path drifting: extract the message-type literals from the
 * `RasterClientMessage` union and assert the worker has a `case` for each.
 */
test("the solo worker handles every client message type", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Client message types live across types.ts (inline union members) and
  // messages.ts (the JOIN/SPAWN/ALLY payload messages).
  const declared =
    readFileSync(resolve(root, "src/Core/types.ts"), "utf8") +
    readFileSync(resolve(root, "src/Core/messages.ts"), "utf8");
  const worker = readFileSync(resolve(root, "src/Client/solo/soloWorker.ts"), "utf8");

  const wanted = new Set<string>();
  const re = /"(CLIENT_RASTER_[A-Z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(declared)) !== null) wanted.add(m[1]);
  assert.ok(wanted.size >= 6, "found the client message types to check");

  // The worker either dispatches a type in its action `switch` (`case "X"`) or
  // handles it inline at connection time (`message.type === "X"`, e.g. JOIN).
  const missing = [...wanted].filter(
    (t) => !worker.includes(`case "${t}"`) && !worker.includes(`=== "${t}"`),
  );
  assert.deepEqual(
    missing,
    [],
    `solo worker is missing a handler for: ${missing.join(", ")} — these actions no-op offline.`,
  );

  // The lockstep replica must re-apply every relayable command the same way,
  // or a relayed action silently no-ops locally and the replica desyncs. JOIN
  // is exempt: it never enters a live session's command stream.
  const replica = readFileSync(resolve(root, "src/Client/lockstep/replica.ts"), "utf8");
  const missingInReplica = [...wanted].filter(
    (t) => t !== "CLIENT_RASTER_JOIN" && !replica.includes(`case "${t}"`),
  );
  assert.deepEqual(
    missingInReplica,
    [],
    `lockstep replica is missing a handler for: ${missingInReplica.join(", ")} — these commands would desync it.`,
  );
});
