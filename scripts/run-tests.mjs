/**
 * `npm test` — every test script that can run with no keys and no network.
 *
 *   npm test                 run them all
 *   npm test -- chat         only scripts whose name contains "chat"
 *
 * There are about fifty `scripts/*-test.ts` files and, until this, no way to
 * run them but one at a time by name — so in practice they ran when someone
 * remembered. This runs every one that is hermetic, in its own process (each
 * snapshots the environment on import), and fails if any does.
 *
 * HERMETIC is the point, in CI and locally: the environment handed to each
 * script has stub mode forced on and every credential removed, so nothing
 * here can reach Freshdesk, monday, Slack, a billing system or a model, even
 * when the shell that started it has a full .env loaded.
 *
 * A new `*-test` script runs automatically. One that genuinely needs a live
 * key goes in NEEDS_LIVE below, with the reason — an explicit list, so
 * "skipped" is a decision someone made and not a script nobody noticed.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** Scripts that call a live service or a model. Run by hand with --env-file=.env.local. */
const NEEDS_LIVE = {
  "dev-board-status-test.ts": "reads the live monday boards",
  "dev-comment-leak-test.ts": "runs the agent loop against a model",
  "distill-test.ts": "calls a model",
  "loop-test.ts": "calls a model",
  "slack-assistant-test.ts": "calls a model",
  "ticket-files-test.ts": "reads a live Freshdesk ticket",
  "ticket-thread-test.ts": "reads a live Freshdesk ticket",
};

/** Extra arguments a script needs to stay offline. */
const ARGS = {
  // The full suite adds an LLM triage layer; the keyword layer is the offline half.
  "app-attribution-test.ts": ["--keyword-only"],
};

/** What every script sees: stub mode, no credentials, and the few non-secret values tests expect. */
function hermeticEnv() {
  const secret = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_USERS|_URL|_DSN|_ID)$|^(KV_|UPSTASH_|DATABASE_|POSTGRES_|AWS_|VERCEL)/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k) && !/_LIVE$|_ALLOW_WRITES$|^JETTA_/.test(k)));
  return {
    ...env,
    STUB_MODE: "true",
    // Not a secret: it appears in every escalation link. The linkifier needs it
    // to tell our monday account from a customer's.
    MONDAY_ACCOUNT_URL: "https://jetpackteam.monday.com",
  };
}

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", join(SCRIPTS, file), ...(ARGS[file] ?? [])], {
      env: hermeticEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += "\n(timed out after 180s)";
      child.kill("SIGKILL");
    }, 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, out, ms: Date.now() - started });
    });
  });
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const all = readdirSync(SCRIPTS).filter((f) => /-test\.m?ts$/.test(f)).sort();
const stale = Object.keys(NEEDS_LIVE).filter((f) => !all.includes(f));
const wanted = all.filter((f) => !(f in NEEDS_LIVE) && (!only.length || only.some((o) => f.includes(o))));

const results = [];
// A few at a time: each is its own Node process and most take a second or two.
const queue = [...wanted];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const r = await run(queue.shift());
      results.push(r);
      console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.file}  (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }),
);

const failed = results.filter((r) => !r.ok).sort((a, b) => a.file.localeCompare(b.file));
for (const r of failed) {
  console.log(`\n──── ${r.file} ────\n${r.out.trim().split("\n").slice(-40).join("\n")}`);
}
console.log(
  `\n${results.length - failed.length} passed, ${failed.length} failed` +
    (only.length ? "" : `, ${Object.keys(NEEDS_LIVE).length} need a live service and were not run`),
);
if (stale.length) {
  console.log(`\nNEEDS_LIVE names scripts that no longer exist: ${stale.join(", ")}`);
}
process.exit(failed.length || stale.length ? 1 : 0);
