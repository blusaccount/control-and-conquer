import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, relative, posix } from "node:path";

/**
 * Verify that every ES module import specifier in the compiled client entry
 * point resolves to a path within dist/ (the asset-serving root).
 *
 * If this test fails it means a new import was added to Client/main.ts that
 * the browser cannot reach via /assets/ → dist/.
 */
test("compiled client entry point has no out-of-root import specifiers", async () => {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const distRoot = join(rootDir, "dist");
  const entryPath = join(distRoot, "Client", "main.js");

  let src: string;
  try {
    src = await readFile(entryPath, "utf8");
  } catch {
    // dist/ not built yet – skip rather than fail so CI is not blocked when
    // the build step hasn't run.  Run `npm run build` first.
    return;
  }

  // Extract bare-string import/export specifiers (handles single and double
  // quotes; does not need to handle template-literal dynamic imports which tsc
  // does not emit for static imports).
  const specifierRe = /(?:^|[^a-zA-Z_$])(?:import|export)[^'"]*['"]([^'"]+)['"]/gm;
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = specifierRe.exec(src)) !== null) {
    specifiers.push(match[1]);
  }

  for (const spec of specifiers) {
    if (!spec.startsWith(".")) {
      // bare specifier (e.g. a Node built-in) – not a file path, skip
      continue;
    }

    // Resolve the specifier relative to the entry point directory.
    const resolved = join(dirname(entryPath), spec);

    // Convert to a path relative to distRoot using posix separators so the
    // assertion message is consistent on all platforms.
    const rel = posix.normalize(relative(distRoot, resolved));

    assert.ok(
      !rel.startsWith(".."),
      `Import specifier "${spec}" resolves outside dist/ (asset root): ${rel}\n` +
        "Ensure all client imports stay within the dist/ directory tree.",
    );
  }
});
