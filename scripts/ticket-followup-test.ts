/**
 * Pins the follow-up cadence's pure rules (lib/ticket-followup.ts): business-day
 * timing, landing at the customer's hour, reading who has the next move, and
 * the checks that keep a templated or made-up touch from going out.
 *
 *   npx tsx scripts/ticket-followup-test.ts
 */
import assert from "node:assert/strict";
import {
  addBusinessDays,
  activeHourOf,
  firstNameOf,
  jitterFor,
  readThread,
  skipTicket,
  snapToActiveHour,
  touchBlock,
  touchDueAt,
  type PublicMessage,
} from "../lib/ticket-followup";

const iso = (s: string) => new Date(s).toISOString();
const at = (s: string) => Date.parse(s);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16);

// ── timing ──
// Thu 2026-10-15 → +2 business days = Mon 19th (skips the weekend).
assert.equal(day(addBusinessDays(at("2026-10-15T10:00:00Z"), 2)), "2026-10-19T10:00");
// Fri → +3 = Wed.
assert.equal(day(addBusinessDays(at("2026-10-16T10:00:00Z"), 3)), "2026-10-21T10:00");
// A reply sent on Saturday counts from Monday as day one.
assert.equal(day(addBusinessDays(at("2026-10-17T10:00:00Z"), 2)), "2026-10-20T10:00");

// The customer's hour on that day.
assert.equal(day(snapToActiveHour(at("2026-10-19T10:00:00Z"), 15, 7)), "2026-10-19T15:07");
// Same day even when the hour has passed: touches go out about an hour after
// it, and "tomorrow" would push every later touch a day late.
assert.equal(day(snapToActiveHour(at("2026-10-19T16:20:00Z"), 15, 0)), "2026-10-19T15:00");
// Never at the weekend.
assert.equal(day(snapToActiveHour(at("2026-10-17T20:00:00Z"), 15, 0)), "2026-10-19T15:00");
// The rhythm holds: touch sent Mon 16:20 → touch 2 Thursday at their hour, not Friday.
assert.equal(day(touchDueAt(at("2026-10-19T16:20:00Z"), 2, 15, 0)), "2026-10-22T15:00");

// Touch 1 from a Thursday reply: 2 business days → Monday, at their hour.
assert.equal(day(touchDueAt(at("2026-10-15T09:00:00Z"), 1, 14, 0)), "2026-10-19T14:00");
// Touch 2 from a Monday touch: 3 business days → Thursday.
assert.equal(day(touchDueAt(at("2026-10-19T14:00:00Z"), 2, 14, 0)), "2026-10-22T14:00");
// Touch 3 from Thursday: 3 business days → Tuesday.
assert.equal(day(touchDueAt(at("2026-10-22T14:00:00Z"), 3, 14, 0)), "2026-10-27T14:00");

assert.equal(activeHourOf("2026-10-15T17:42:00Z"), 17);
assert.equal(activeHourOf(null), 14);
assert.equal(jitterFor("14520", 1), jitterFor("14520", 1), "jitter is stable per ticket");
assert.ok(jitterFor("14520", 1) < 45);

// ── reading the thread ──
const msg = (when: string, direction: "customer" | "agent", author = direction === "customer" ? "customer" : "Cherryl"): PublicMessage => ({
  at: iso(when),
  direction,
  author,
  body: "…",
});

// Customer wrote last → nothing to follow up.
assert.deepEqual(readThread([msg("2026-10-10", "customer"), msg("2026-10-11", "agent"), msg("2026-10-12", "customer")], []), {
  kind: "customer_last",
});

// We wrote last → anchored on our reply, no touches yet.
let r = readThread([msg("2026-10-10T08:00:00Z", "customer"), msg("2026-10-11T09:00:00Z", "agent")], []);
assert.equal(r.kind, "waiting");
if (r.kind === "waiting") {
  assert.equal(r.anchor.at, iso("2026-10-11T09:00:00Z"));
  assert.equal(r.lastCustomerAt, iso("2026-10-10T08:00:00Z"));
  assert.equal(r.touchesSinceAnchor, 0);
}

// Her touch (matched by time, seconds after she sent it) does NOT move the anchor.
const touch1 = "2026-10-14T14:05:00Z";
r = readThread(
  [msg("2026-10-10T08:00:00Z", "customer"), msg("2026-10-11T09:00:00Z", "agent"), msg("2026-10-14T14:05:20Z", "agent", "App Support")],
  [iso(touch1)],
);
assert.equal(r.kind === "waiting" && r.anchor.at, iso("2026-10-11T09:00:00Z"));
assert.equal(r.kind === "waiting" && r.touchesSinceAnchor, 1);

// A colleague following up by hand after her touch becomes the new anchor —
// the count restarts and the two never pile on.
r = readThread(
  [
    msg("2026-10-10T08:00:00Z", "customer"),
    msg("2026-10-11T09:00:00Z", "agent"),
    msg("2026-10-14T14:05:20Z", "agent", "App Support"),
    msg("2026-10-16T10:00:00Z", "agent", "Cherryl"),
  ],
  [iso(touch1)],
);
assert.equal(r.kind === "waiting" && r.anchor.at, iso("2026-10-16T10:00:00Z"));
assert.equal(r.kind === "waiting" && r.anchor.author, "Cherryl");
assert.equal(r.kind === "waiting" && r.touchesSinceAnchor, 0);

// ── which tickets ──
assert.equal(skipTicket({ source: 10, subject: "Would you leave us a review?" }), "outbound");
assert.equal(skipTicket({ source: 1, subject: "x", tags: ["Jetta-Hold"] }), "hold_tag");
assert.equal(skipTicket({ source: 1, subject: "[TEST] signing link" }), "test");
assert.equal(skipTicket({ source: 1, subject: "x", requesterEmail: "niro@jetpackwork.com" }), "internal");
assert.equal(skipTicket({ source: 7, subject: "Chat with Mike" }), null, "chat-born tickets are followed up too");
assert.equal(skipTicket({ source: 1, subject: "Signing link expired" }), null);

assert.equal(firstNameOf("Elizabeth Toole <e@x.com>"), "Elizabeth");
assert.equal(firstNameOf("mike mcardle"), "Mike");
assert.equal(firstNameOf("VICTONICE <ops@victonice.com>"), null, "a company in caps is not a first name");
assert.equal(firstNameOf("Admin <admin@acme.com>"), null);
assert.equal(firstNameOf("support@acme.com"), null);
assert.equal(firstNameOf(null), null);

// ── checks on the text ──
const thread = "Agent: please share the item link and a Loom at https://www.loom.com/ or invite support@jetpackwork.com.";
const good =
  "Hi Mike,\n\nWere you able to invite support@jetpackwork.com to the board? Once we're in, we can trace why the status column stops updating.";
assert.equal(touchBlock(good, thread, []), null);
assert.equal(touchBlock("Hi Mike,\n\nFollowing up on my previous message! Were you able to invite us to the board yet?", thread, []), "stock_phrase");
assert.equal(touchBlock("Hi Mike,\n\nJust checking in to see whether the board invite went through on your side.", thread, []), "stock_phrase");
assert.equal(
  touchBlock("Hi Mike,\n\nYou can follow the steps at https://help.example.com/reset to reconnect it, then let me know.", thread, []),
  "new_link",
);
assert.equal(touchBlock("Hi Mike,\n\nA Loom is perfect: https://www.loom.com/ and the item link please.", thread, []), null, "a link from the thread is fine");
assert.equal(touchBlock(good, thread, [good]), "repeats_earlier_touch");
assert.equal(touchBlock("Hi Mike, any news?", thread, []), "too_short");
assert.equal(touchBlock("Hi Mike,\n\nI checked ticket #14535 again and we still need the board invite from you.", thread, []), "ticket_number");

console.log("ticket-followup-test: all assertions passed");
