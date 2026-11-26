/**
 * /today decides "needs you" from the thread, not the Freshdesk status.
 * These pin the two readings that decision rests on.
 *
 *   npx tsx scripts/reply-owed-test.ts
 */
import assert from "node:assert/strict";
import { isAcknowledgement, customerMessageNeedsNoReply, statusDisagreement, closedTicketStillOwed } from "../lib/reply-owed";

// ── A closing "thanks" is not our turn ──
for (const msg of [
  "Thanks!",
  "Thank you so much",
  "ok thanks",
  "Perfect, that worked. Cheers",
  "Hi Cherryl, thanks a lot!",
  "Got it, thank you.",
  "It works now, appreciated",
]) {
  assert.ok(isAcknowledgement(msg), `acknowledgement: ${msg}`);
}

// ── Anything that carries a problem or a question still is ──
for (const msg of [
  "Thanks, but it still doesn't work",
  "Thanks! One more question about templates",
  "ok, how do I add a CC?",
  "Thank you. However the PDF is blank.",
  "So… I have some good news bad news. The good news is that it's working! The bad news is the sub-items stop after the first run",
  "Great, can you also check the other board?",
  "Thanks for the quick reply. I tried the steps and the recipe is still failing on the second board.",
  "",
]) {
  assert.ok(!isAcknowledgement(msg), `not an acknowledgement: ${msg}`);
}
// Long messages are never waved through, whatever they open with.
assert.ok(!isAcknowledgement("Thanks " + "x".repeat(200)));

// ── Away notices are not a customer waiting either ──
assert.ok(customerMessageNeedsNoReply("Automatic reply: I am out of office until Monday."));
assert.ok(!customerMessageNeedsNoReply("I was out of office last week, the signing link still fails."));

// ── An Outlook reaction is not a message ──
assert.ok(customerMessageNeedsNoReply("[like] Haridini Simson reacted to your message: ________________________________"));
assert.ok(customerMessageNeedsNoReply("Kelsey reacted to your message"));
assert.ok(!customerMessageNeedsNoReply("You said I reacted to your message wrongly, the board still shows nothing"));

// ── Status vs thread ──
assert.equal(statusDisagreement("resolved", true), "marked resolved, but the customer wrote last");
assert.equal(statusDisagreement("waiting on customer", true), "marked waiting on customer, but the customer wrote last");
assert.equal(statusDisagreement("open", false), "marked open, but we replied last");
assert.equal(statusDisagreement("open", true), null);
assert.equal(statusDisagreement("waiting on customer", false), null);
// Statuses that make no claim about whose turn it is never disagree.
assert.equal(statusDisagreement("escalated to dev", true), null);
assert.equal(statusDisagreement("working on it", false), null);
assert.equal(statusDisagreement(null, true), null);

async function closedChecks() {
  // ── Closed ticket, customer wrote last: asked once, then cached ──
  const store = new Map<string, string>();
  let asks = 0;
  const deps = {
    ask: async (t: string) => (asks++, /still|\?/.test(t)),
    cacheGet: async (k: string) => store.get(k) ?? null,
    cacheSet: async (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(await closedTicketStillOwed("14753", 100, "This is resolved", deps), false);
  assert.equal(await closedTicketStillOwed("14753", 100, "This is resolved", deps), false);
  assert.equal(asks, 1, "the same message is never asked about twice");
  assert.equal(await closedTicketStillOwed("14753", 200, "It still sends to the old address?", deps), true, "a new message is asked again");
  assert.equal(asks, 2);
  // No text, nothing to ask.
  assert.equal(await closedTicketStillOwed("1", 1, "  ", deps), false);
  // A model failure leaves the status standing and is not cached.
  const failing = { ...deps, ask: async () => { throw new Error("rate limited"); } };
  assert.equal(await closedTicketStillOwed("2", 1, "Why is this closed? It is broken.", failing), false);
  assert.equal(store.has("today:closed-owed:2:1"), false);
}

closedChecks().then(() => console.log("reply-owed: ok"));
