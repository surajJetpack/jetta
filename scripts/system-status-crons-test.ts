/**
 * /system's scheduled-jobs list (and so the console assistant's) must name
 * every cron vercel.json runs — it had silently fallen three behind.
 *
 *   npx tsx scripts/system-status-crons-test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRONS } from "../lib/system-status";

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  crons: { path: string }[];
};
const scheduled = vercel.crons.map((c) => c.path).sort();
const listed = CRONS.map((c) => c.path).sort();
assert.deepEqual(listed, scheduled, "lib/system-status.ts CRONS is out of step with vercel.json");
console.log("system-status-crons-test: all assertions passed");
