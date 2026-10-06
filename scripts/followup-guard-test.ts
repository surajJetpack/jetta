/**
 * The follow-up cron's close guard (lib/followup-guard.ts). Pure, no env:
 *
 *   npx tsx scripts/followup-guard-test.ts
 */
import assert from "node:assert/strict";
import { followUpCloseBlocker } from "../lib/followup-guard";

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

console.log("followup-guard-test: all assertions passed");
