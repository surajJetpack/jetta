/**
 * Customer-facing text carries no em dashes.
 *
 *   npx tsx scripts/human-text-test.ts
 */
import { humanizeText } from "../lib/human-text";

const cases: [string, string][] = [
  ["The free plan includes 10 packages — that's the limit.", "The free plan includes 10 packages, that's the limit."],
  ["Got it—that makes sense.", "Got it, that makes sense."],
  ["Your request is in — I'll confirm shortly.", "Your request is in, I'll confirm shortly."],
  ["It's being processed —.", "It's being processed."],
  ["Thanks! —", "Thanks!"],
  ["Upgrade to Basic (200 packages/month) — Pro — or Ultimate.", "Upgrade to Basic (200 packages/month), Pro, or Ultimate."],
  ["— first step\n— second step", "- first step\n- second step"],
  ["Pick one – the faster one.", "Pick one, the faster one."],
  ["Replies in 2–5 days.", "Replies in 2-5 days."],
  ["<p>Done &mdash; you're set.</p>", "<p>Done, you're set.</p>"],
  ["See https://jetpackapps.io/trackmy-pricing — it lists all plans.", "See https://jetpackapps.io/trackmy-pricing, it lists all plans."],
  ["No dashes here, and a well-known hyphen.", "No dashes here, and a well-known hyphen."],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = humanizeText(input);
  const ok = got === want && !/[—–]/.test(got);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${JSON.stringify(input)}${ok ? "" : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`);
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
