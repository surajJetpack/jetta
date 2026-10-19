/**
 * Read-only preview of the follow-up sweep against real Freshdesk: what it
 * would do on each waiting ticket, with the text she would write for the due
 * ones. Sends nothing, writes nothing (it runs the cron as `?dry=1&preview=1`).
 *
 *   LLM_PROVIDER=openrouter npx tsx --env-file=.env.local scripts/ticket-followup-preview.ts [reads] [asOf ISO]
 */
import { NextRequest } from "next/server";
import { GET } from "../app/api/cron/ticket-followup/route";

async function main() {
const reads = process.argv[2] ?? "12";
const asOf = process.argv[3] ? `&asOf=${process.argv[3]}` : "";
const res = await GET(
  new NextRequest(`http://local/api/cron/ticket-followup?dry=1&preview=1&reads=${reads}${asOf}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }),
);
const out = (await res.json()) as { handled?: { ticketId: string; action: string; detail?: string; text?: string }[] };
for (const h of out.handled ?? []) {
  console.log(`\n#${h.ticketId}  ${h.action}${h.detail ? `  (${h.detail})` : ""}`);
  if (h.text) console.log(h.text.replace(/^/gm, "    "));
}
console.log("\n", JSON.stringify({ ...out, handled: undefined }, null, 1));
}
main();
