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
test("the solo worker import graph is free of Node built-ins", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = resolve(root, "src/Client/solo/soloWorker.ts");

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

  scan(entry);

  assert.ok(seen.size > 1, "scanned the worker's transitive imports");
  assert.deepEqual(
    nodeHits,
    [],
    `solo worker reaches Node built-ins (breaks in the browser):\n${nodeHits.join("\n")}`,
  );
});
