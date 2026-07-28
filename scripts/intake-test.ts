/**
 * Smoke test for the intake filter.
 *   npx tsx --env-file=.env.local scripts/intake-test.ts
 *
 * Part 1 (deterministic, always runs): obviousNonQuery on synthetic tickets.
 * Part 2 (needs FRESHDESK_LIVE + LLM keys): triageTicket intake classification.
 */
import { obviousNonQuery } from "../lib/intake";
import { triageTicket } from "../lib/context";
import { config } from "../lib/config";
import type { Ticket } from "../lib/types";

function ticket(partial: Partial<Ticket>): Ticket {
  return {
    id: "test",
    subject: "",
    description: "",
    status: "open",
    requesterName: null,
    requesterEmail: null,
    replies: [],
    ...partial,
  };
}

const cases: { name: string; t: Ticket; expect: string | null }[] = [
  { name: "OOO subject", t: ticket({ subject: "Automatic reply: I am out of office" }), expect: "auto_reply" },
  { name: "OOO body", t: ticket({ subject: "Re: your ticket", description: "I am currently out of office until Monday." }), expect: "auto_reply" },
  { name: "bounce", t: ticket({ subject: "Undeliverable: Signature request" }), expect: "auto_reply" },
  { name: "no-reply sender", t: ticket({ subject: "Your invoice", requesterEmail: "no-reply@stripe.com" }), expect: "non_human_sender" },
  { name: "notifications sender", t: ticket({ subject: "New comment", requesterEmail: "notifications@github.com" }), expect: "non_human_sender" },
  { name: "marketing body", t: ticket({ subject: "Big news!", description: "Check our new features. Click here to unsubscribe from these emails." }), expect: "marketing" },
  { name: "real customer", t: ticket({ subject: "GetSign template not sending", description: "My signature request is stuck. Can you help?", requesterEmail: "jane@acme.com" }), expect: null },
  { name: "short real customer", t: ticket({ subject: "pricing?", description: "how much is the pro plan", requesterEmail: "bob@acme.com" }), expect: null },
];

async function main() {
let failed = 0;
console.log("── obviousNonQuery ──");
for (const c of cases) {
  const got = obviousNonQuery(c.t);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}: got ${JSON.stringify(got)} expected ${JSON.stringify(c.expect)}`);
}
console.log(failed === 0 ? "\nAll deterministic cases passed." : `\n${failed} case(s) FAILED.`);

// Part 2 — LLM triage intake (only when live)
if (!config.freshdesk.live) {
  console.log("\n[skip] triageTicket intake test — FRESHDESK not live (stub mode).");
} else {
  console.log("\n── triageTicket.intake (light model) ──");
  const triageCases: { name: string; subject: string; body: string; expect: string }[] = [
    { name: "OOO", subject: "Out of Office AutoReply", body: "I will respond when I return on Monday.", expect: "auto_reply" },
    { name: "marketing", subject: "Boost your sales 3x this quarter", body: "Book a demo with our SDR team today. Limited slots!", expect: "marketing" },
    { name: "real query", subject: "TrackMy not syncing", body: "My parcel tracking column stopped updating yesterday. What's wrong?", expect: "customer_query" },
  ];
  for (const c of triageCases) {
    const r = await triageTicket(c.subject, c.body);
    const ok = r.intake === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${c.name}: intake=${r.intake} product=${r.product} (expected intake ${c.expect})`);
  }
}

process.exit(failed === 0 ? 0 : 1);
}

main();
