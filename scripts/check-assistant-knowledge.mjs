/**
 * Does the console assistant know about everything this build can do?
 *
 *   node scripts/check-assistant-knowledge.mjs
 *
 * Runs before every `next build` (package.json "prebuild"), so on Vercel a
 * deploy fails rather than shipping a feature the assistant can't explain.
 * Its knowledge is exactly: /system's rows (lib/system-status.ts), the manual
 * (docs/manual), the overview and docs/changelog.md. It has gone stale before
 * every time a feature shipped without them (PR #132: 3 of 7 crons missing;
 * #157: it denied a live feature because the manual said otherwise).
 *
 * Checks, by reading the files as text (no imports, no TypeScript):
 *   1. Every behaviour switch lib/config.ts reads — JETTA_*, *_ALLOW_WRITES,
 *      *_LIVE — is named in /system, the manual or the overview.
 *   2. Every cron in vercel.json is listed in /system's CRONS.
 *   3. docs/changelog.md exists and its entries are well-formed.
 *
 * To fix a failure: add a /system row (lib/system-status.ts) for a switch,
 * or a manual paragraph that names it; add a CRONS row for a cron; add a
 * changelog entry. Plumbing (URLs, timezone, tuning numbers of a switch that
 * IS documented) goes in PLUMBING below, with the reason.
 */
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Not behaviour: where things live, or a tuning number for a documented switch. */
const PLUMBING = {
  JETTA_APP_URL: "the deployment's own URL",
  JETTA_CONSOLE_URL: "link target in notes",
  JETTA_TZ: "display timezone",
  JETTA_GETSIGN_ORIGINS: "chat embed origins, managed on the Chat settings page",
  JETTA_DRAFTS_SLACK_CHANNEL: "a channel id",
  JETTA_BOOKING_URL: "link offered by JETTA_FIRST_RESPONSE",
  JETTA_FIRST_RESPONSE_DELAY: "tuning for JETTA_FIRST_RESPONSE",
  JETTA_DEV_QUIET_WORKDAYS: "tuning for JETTA_DEV_FOLLOWUP (shown in its /system row)",
  JETTA_DEV_WEEKEND: "tuning for JETTA_DEV_FOLLOWUP",
};

const problems = [];

// 1. switches
const config = read("lib/config.ts");
const known = [read("lib/system-status.ts"), read("docs/manual/README.md"), read("docs/manual/general.md"), read("JETTA-OVERVIEW.md")].join("\n");
const switches = [...new Set([...config.matchAll(/env\("((?:JETTA_[A-Z0-9_]+)|(?:[A-Z0-9_]+_ALLOW_WRITES)|(?:[A-Z0-9_]+_LIVE))"\)/g)].map((m) => m[1]))];
for (const name of switches) {
  if (name in PLUMBING) continue;
  if (!new RegExp(`\\b${name}\\b`).test(known)) problems.push(`switch ${name} is read in lib/config.ts but named nowhere the assistant reads (add a /system row in lib/system-status.ts or a manual paragraph)`);
}
for (const name of Object.keys(PLUMBING)) {
  if (!switches.includes(name)) problems.push(`PLUMBING lists ${name}, which lib/config.ts no longer reads — remove it`);
}

// 2. crons
const status = read("lib/system-status.ts");
for (const { path } of JSON.parse(read("vercel.json")).crons ?? []) {
  if (!status.includes(`path: "${path}"`)) problems.push(`cron ${path} runs (vercel.json) but is not in CRONS in lib/system-status.ts`);
}

// 3. changelog
if (!existsSync(new URL("../docs/changelog.md", import.meta.url))) {
  problems.push("docs/changelog.md is missing");
} else {
  const entries = read("docs/changelog.md").split(/^(?=## )/m).filter((p) => p.startsWith("## "));
  if (!entries.length) problems.push("docs/changelog.md has no entries");
  for (const e of entries) {
    const head = e.split("\n")[0];
    if (!/^## \d{4}-\d{2}-\d{2}: .+/.test(head)) problems.push(`changelog heading "${head}" should read "## YYYY-MM-DD: title (#PR)"`);
  }
  const dates = entries.map((e) => e.slice(3, 13));
  if (dates.join() !== [...dates].sort().reverse().join()) problems.push("docs/changelog.md must be newest first");
}

if (problems.length) {
  console.error(`\nThe console assistant would not know about ${problems.length} thing(s) in this build:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nSee the rule in AGENTS.md (\"Keep the console assistant's knowledge current\").\n");
  process.exit(1);
}
console.log(`check-assistant-knowledge: ${switches.length} switches and the crons are all documented; changelog OK`);
