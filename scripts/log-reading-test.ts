/**
 * Offline test for the log reading on dev items (lib/log-reading.ts): only the
 * failures that fit the report are kept, under a summary, and a failed read
 * falls back to the full list.
 *
 *   npx tsx scripts/log-reading-test.ts
 */
import assert from "node:assert/strict";
import { failureSection, type FailureRow } from "../lib/log-reading";
import { contextBody } from "../lib/tools/monday";

let n = 0;
const check = (name: string, ok: unknown) => {
  assert.ok(ok, name);
  n++;
};

const rows: FailureRow[] = [
  { at: "2026-11-18T22:37:42.844Z", group: "Triggerly", message: "Not authenticated :: failed query items (ids: [13587855738])", count: 2 },
  { at: "2026-11-17T10:09:23.895Z", group: "Triggerly", message: `CpqClientService 14 UNAVAILABLE: No connection established ${"x".repeat(400)}`, count: 9 },
  { at: "2026-11-17T08:00:00.000Z", group: "Triggerly", message: "Rate limit on board 18410814963", count: 1 },
];
const who = "a@b.com / board 18410814963";

const plain = failureSection(rows, null, who);
check("no reading: every row is listed, as before", plain.length === 4 && plain[0] === `Newest error/failure lines for ${who}:`);
check("…at the old length", plain[2].includes("x".repeat(200)));

const read = failureSection(rows, { related: [1], summary: "The QR job's item query was refused as not authenticated, twice, last on 18 Nov 22:37 UTC." }, who, () => "https://aws/line");
check("a reading leads with the summary, marked as Jetta's", read[0].startsWith("What the logs show for this report (Jetta's reading") && read[1].startsWith("The QR job's item query"));
check("only the related line is kept, with its link", read.filter((l) => l.startsWith("- ")).length === 1 && read[3].includes("Not authenticated") && read[3].endsWith("https://aws/line"));
check("the unrelated ones are counted, not shown", read[4] === "Also: 2 kinds of failure for this customer in that window do not look related to the report and are left out (ask Jetta in Slack or the console for the full list)." && !read.join("\n").includes("UNAVAILABLE"));

const long = failureSection(rows, { related: [2], summary: "s" }, who);
check("a kept line is shortened", long[3].includes("…") && !long[3].includes("x".repeat(200)));
check("one left out reads in the singular", failureSection(rows.slice(0, 2), { related: [1], summary: "s" }, who)[4].startsWith("Also: 1 kind of failure for this customer in that window does not"));
check("nothing left out, no line about it", failureSection(rows.slice(0, 1), { related: [1], summary: "s" }, who).length === 4);

const none = failureSection(rows, { related: [], summary: "" }, who);
check("nothing fits: said plainly, and no line is shown", none[0].startsWith("No failure in the logs matches what the customer reports") && none.length === 2 && none[1].startsWith("3 kinds of failure"));
check("positions outside the list are ignored", failureSection(rows, { related: [0, 7, 1, 1], summary: "s" }, who).filter((l) => l.startsWith("- ")).length === 1);
check("no failures at all", failureSection([], null, who)[0] === "No error or failure lines for this customer in that window.");

const body = contextBody({ title: "t", product: "getsign", accountUrl: "a", errorDescription: "e", reproSteps: "r", freshdeskTicketUrl: "f", logEvidence: read.join("\n") }, false);
check("the item still marks it as from the logs, unseen by the customer", body.includes("From the app logs (CloudWatch, added automatically by Jetta; the customer has not seen this):"));

console.log(`log-reading: all ${n} assertions passed`);
