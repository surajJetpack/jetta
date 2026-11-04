/**
 * Smoke test for the intake filter.
 *   npx tsx --env-file=.env.local scripts/intake-test.ts
 *
 * Part 1 (deterministic, always runs): obviousNonQuery on synthetic tickets.
 * Part 2 (needs FRESHDESK_LIVE + LLM keys): triageTicket intake classification.
 */
import { obviousNonQuery, newestRelayEntry } from "../lib/intake";
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
  // Replies: the newest customer message is judged, not the opener.
  {
    name: "real reply on an auto-reply opener",
    t: ticket({
      subject: "Automatic reply: Re: Template board",
      description: "I am out of office until Monday.",
      replies: [
        { author: "agent", authorEmail: null, body: "Hi, following up.", createdAt: "2026-11-01T00:00:00Z", isPrivate: false },
        { author: "customer", authorEmail: "b@ebsco.com", body: "I'll cancel today's call and reschedule.", createdAt: "2026-11-03T00:00:00Z", isPrivate: false },
      ],
    }),
    expect: null,
  },
  {
    name: "OOO reply on a real opener",
    t: ticket({
      subject: "GetSign field mapping",
      description: "My workflow sends to the wrong email.",
      replies: [
        { author: "agent", authorEmail: null, body: "Did the test run work?", createdAt: "2026-11-02T00:00:00Z", isPrivate: false },
        { author: "customer", authorEmail: "j@acme.com", body: "Thank you for your email. I am out of office for the winter season.", createdAt: "2026-11-03T00:00:00Z", isPrivate: false },
      ],
    }),
    expect: "auto_reply",
  },
  {
    name: "private note after customer reply is ignored",
    t: ticket({
      subject: "Refund",
      description: "Please refund.",
      replies: [
        { author: "customer", authorEmail: "k@acme.com", body: "Any update on the refund?", createdAt: "2026-11-03T00:00:00Z", isPrivate: false },
        { author: "agent", authorEmail: null, body: "Automatic reply note", createdAt: "2026-11-03T00:01:00Z", isPrivate: true },
      ],
    }),
    expect: null,
  },
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
{
  // monday.com Support relays (Zendesk): keep only the newest entry.
  const relay = "##- Please type your reply above this line -##\n\n----------------------------------------------\n\nKarla, Oct 25\n\nAny update on the refund?\n\n----------------------------------------------\n\nKarla, Oct 21\n\nThanks for looking into this.";
  const got = newestRelayEntry(relay);
  const ok = got === "Karla, Oct 25\n\nAny update on the refund?" && newestRelayEntry("plain reply") === "plain reply"
    && newestRelayEntry(relay.replace(/\n/g, "\r\n")) === "Karla, Oct 25\r\n\r\nAny update on the refund?".replace(/\r\n/g, "\n");
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} newestRelayEntry keeps the newest entry: got ${JSON.stringify(got)}`);
}
console.log(failed === 0 ? "\nAll deterministic cases passed." : `\n${failed} case(s) FAILED.`);

// Part 2 — LLM triage intake (only when live)
if (!config.freshdesk.live) {
  console.log("\n[skip] triageTicket intake test — FRESHDESK not live (stub mode).");
} else {
  console.log("\n── triageTicket.intake (light model) ──");
  const triageCases: { name: string; subject: string; body: string; reply?: string; expect: string }[] = [
    { name: "OOO", subject: "Out of Office AutoReply", body: "I will respond when I return on Monday.", expect: "auto_reply" },
    { name: "marketing", subject: "Boost your sales 3x this quarter", body: "Book a demo with our SDR team today. Limited slots!", expect: "marketing" },
    { name: "real query", subject: "TrackMy not syncing", body: "My parcel tracking column stopped updating yesterday. What's wrong?", expect: "customer_query" },
    // #14641 shape: a scheduling opener, then a human reply. Judged on the reply.
    { name: "human reply (14641)", subject: "Re: Template board integrations not copying (#5152770)", body: "Hi Jetpack Team,\n\nCan you please suggest a date or time that works best for you?\n\nBelinda Kennedy", reply: "Hi Prashant, Lidia didn't confirm she's available. I think I should cancel the call today and reschedule it. I'll recheck the calendars and send a new invite.", expect: "customer_query" },
    // #14583 shape: monday.com Support relaying a follow-up through Zendesk.
    { name: "relayed follow-up (14583)", subject: "Re: Refund request for cancelled app subscription (#5277075)", body: "Dear Jetpack Apps team, our mutual customer has asked for a refund.", reply: newestRelayEntry("##- Please type your reply above this line -##\n\n----------------------------------------------\n\nKarla, Oct 25, 2026, 6:00 AM EDT\n\nHello Jetpack team,\n\nI'm following up to check whether there are any updates regarding Alison's refund request for the Extract AI subscription.\n\nKind regards,\nKarla\n\n![monday.com](https://dapulse-res.cloudinary.com/monday-logo.png)\n\n----------------------------------------------\n\nKarla, Oct 21\n\nThanks."), expect: "customer_query" },
    // #14675 shape: a real opener, then an out-of-office. Judged on the reply.
    { name: "OOO reply (14675)", subject: "issue with the format of my sending workflow", body: "My workflow sends the document to the wrong email address.", reply: "Thank you for your email. I am now away for the winter season. This inbox will be checked intermittently.", expect: "auto_reply" },
  ];
  for (const c of triageCases) {
    const r = await triageTicket(c.subject, c.body, undefined, c.reply);
    const ok = r.intake === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${c.name}: intake=${r.intake} product=${r.product} (expected intake ${c.expect})`);
  }
}

process.exit(failed === 0 ? 0 : 1);
}

main();
