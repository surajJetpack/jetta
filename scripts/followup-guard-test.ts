/**
 * The follow-up cron's close guard (lib/followup-guard.ts). Pure, no env,
 * no Freshdesk, no monday:
 *
 *   npx tsx scripts/followup-guard-test.ts
 */
import assert from "node:assert/strict";
import { describeFollowUpBlock, followUpCloseBlocker } from "../lib/followup-guard";

// Waiting on the customer, nothing escalated → close.
for (const s of ["open", "pending", "waiting on customer"]) {
  assert.equal(followUpCloseBlocker(s, false), null, `${s} should be closeable`);
}

// Ticket 14453: escalated to dev, our turn to reply → never close.
assert.deepEqual(followUpCloseBlocker("escalated to dev", true), {
  reason: "status",
  status: "escalated to dev",
  retry: false,
});

// Every status where the team owes the next move, or the thread is done.
for (const s of [
  "working on it",
  "escalated to dev",
  "hold - account access",
  "validating",
  "customer responded",
  "reopened",
  "assigned to AI agent",
  "resolved",
  "closed",
  "42",
]) {
  assert.equal(followUpCloseBlocker(s, false)?.reason, "status", `${s} must block`);
}

// Status says waiting on customer, but engineering holds an open escalation.
assert.deepEqual(followUpCloseBlocker("pending", true), { reason: "open_escalation", retry: false });

// Freshdesk unreachable → don't close blind, keep the job for the next run.
assert.deepEqual(followUpCloseBlocker(null, false), { reason: "status_unknown", retry: true });

// ── The dev board has the last word ──────────────────────────────
//
// Ticket 14453 again, after the fact: by the time its escalation key had
// expired (or if a person had filed the item by hand), the only thing still
// saying "engineering has this" was the board itself.
const item = { id: "13168376207", title: "Status column not listed in Generate trigger dropdown", status: "Ready to start" };

// Waiting on the customer, no escalation key, but an item still in flight → hold, and say which.
assert.deepEqual(followUpCloseBlocker("pending", false, [item]), {
  reason: "open_dev_item",
  items: [item],
  retry: false,
});
assert.equal(
  describeFollowUpBlock(followUpCloseBlocker("open", false, [item])!),
  'open dev item: "Status column not listed in Generate trigger dropdown" (Ready to start)',
);

// Extra fields on the item never leak into the event payload.
assert.deepEqual(
  followUpCloseBlocker("open", false, [{ ...item, url: "https://x/pulses/1", group: "Bugs" } as typeof item]),
  { reason: "open_dev_item", items: [item], retry: false },
);

// Engineering finished (the caller filters to in-flight items) → close as before.
assert.equal(followUpCloseBlocker("pending", false, []), null);
// Omitted = "nothing in flight" for callers that have not looked (older call shape).
assert.equal(followUpCloseBlocker("pending", false), null);

// monday unreachable → don't close on "couldn't check"; keep the job.
assert.deepEqual(followUpCloseBlocker("pending", false, null), { reason: "dev_board_unknown", retry: true });

// Order: a Freshdesk answer wins before the board is consulted, so a held
// ticket names what a person would look at first.
assert.equal(followUpCloseBlocker("escalated to dev", false, [item])?.reason, "status");
assert.equal(followUpCloseBlocker("pending", true, [item])?.reason, "open_escalation");
assert.equal(followUpCloseBlocker(null, false, null)?.reason, "status_unknown");

console.log("followup-guard-test: all assertions passed");
