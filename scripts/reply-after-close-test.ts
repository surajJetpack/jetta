/**
 * A customer writing back on a closed ticket must wake Jetta, and the
 * follow-up cron must not re-answer a message the webhook already has
 * (ticket 14404). Pure helpers, no network:
 *
 *   STUB_MODE=true npx tsx scripts/reply-after-close-test.ts
 */
import assert from "node:assert/strict";
import { customerWroteAfterClose, customerMessageMarker } from "../lib/tools/freshdesk";
import type { TicketReply } from "../lib/types";

const r = (author: "customer" | "agent", createdAt: string, isPrivate = false) =>
  ({ author, createdAt, isPrivate, body: "x" }) as TicketReply;

// 14404, 10-01: our auto-close went out, then her new problem; FD still "resolved".
const replyAfterClose = [
  r("agent", "2026-09-29T17:17:00Z"),
  r("agent", "2026-10-01T09:00:00Z"),
  r("customer", "2026-10-01T13:33:00Z"),
];
assert.equal(customerWroteAfterClose({ status: "resolved", replies: replyAfterClose }), true);
assert.equal(customerWroteAfterClose({ status: "closed", replies: replyAfterClose }), true);

// Finished threads still skip: we spoke last, or a private note is all that follows.
const weSpokeLast = [r("customer", "2026-09-29T15:16:00Z"), r("agent", "2026-09-29T17:17:00Z")];
assert.equal(customerWroteAfterClose({ status: "resolved", replies: weSpokeLast }), false);
assert.equal(
  customerWroteAfterClose({
    status: "resolved",
    replies: [...weSpokeLast, r("agent", "2026-09-30T00:00:00Z", true)],
  }),
  false,
  "a private note is not a customer reply",
);
// Closed with no public conversation at all (spam, merged) — nothing to answer.
assert.equal(customerWroteAfterClose({ status: "closed", replies: [] }), false);
// Live statuses are not this helper's business.
assert.equal(customerWroteAfterClose({ status: "waiting on customer", replies: replyAfterClose }), false);

// The marker the webhook claims and the cron checks: newest public customer message.
assert.equal(customerMessageMarker("14404", { replies: replyAfterClose }), "customer-msg:14404:2026-10-01T13:33:00Z");
assert.equal(
  customerMessageMarker("14404", { replies: [...replyAfterClose, r("customer", "2026-10-02T00:00:00Z", true)] }),
  "customer-msg:14404:2026-10-01T13:33:00Z",
  "private entries never move the marker",
);
assert.equal(customerMessageMarker("9", { replies: [r("agent", "2026-10-01T00:00:00Z")] }), "customer-msg:9:initial");

console.log("reply-after-close-test: all assertions passed");
