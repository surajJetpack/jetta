/**
 * Guards a failure that shipped and went unnoticed for hours: features that
 * read GitHub or ask a model must not switch themselves off in stub mode.
 *
 * Production runs with STUB_MODE on and each integration made live by its own
 * `*_LIVE` flag. A `config.stubMode` check in a feature with no such flag
 * means it never runs in production, and because the test suite itself runs
 * in stub mode, every test still passes.
 *
 *   npx tsx scripts/stub-mode-gates-test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  let n = 0;
  const check = (name: string, ok: unknown) => {
    assert.ok(ok, name);
    n++;
  };

  // Stub mode ON, as in production, with a token present.
  process.env.STUB_MODE = "true";
  process.env.JETTA_GETSIGN_REFERENCE_TOKEN = "test-token-not-real";
  const { config } = await import("../lib/config");
  const { githubReady } = await import("../lib/github");
  check("this test runs in stub mode, like production", config.stubMode === true);
  check("GitHub is read when there is a token, stub mode or not", githubReady());
  (config as { getsignReferenceToken?: string }).getsignReferenceToken = undefined;
  check("and is not read without one", !githubReady());

  // The source of each feature that has no `*_LIVE` flag of its own.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
  for (const file of ["github.ts", "getsign-reference.ts", "release-watch.ts", "fix-lookup.ts", "fix-store.ts", "problems.ts", "problem-store.ts", "tools/getsign-app.ts", "compliance-nudge.ts"]) {
    const code = readFileSync(join(root, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    check(`${file} does not switch itself off in stub mode`, !/stubMode|STUB_MODE/.test(code));
  }

  console.log(`stub-mode-gates: all ${n} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
