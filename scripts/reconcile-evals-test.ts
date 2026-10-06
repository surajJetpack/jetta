/**
 * Reconciliation → /evals: a draft the agent SENT (as-is or edited) records an
 * evaluation; a draft they did NOT use records none.
 *
 * Runs fully in-memory — no env file, stub Freshdesk, no Redis:
 *
 *   STUB_MODE=true npx tsx scripts/reconcile-evals-test.ts
 */
import assert from "node:assert/strict";
import { addReplyDraft, getFollowUp, type ReplyDraft } from "../lib/kv";
import { reconcileTicketDraft } from "../lib/reconcile";
import { getEvaluation, getUndistilledEvaluations } from "../lib/evals";

const DRAFT_TEXT =
  "Hi Amber, thanks for the screenshot. Signing links stay active until you disable them, so a link " +
  "expiring after one day is not expected. I've logged this with our engineering team and will update " +
  "you as soon as we hear back.";

function draft(id: string, ticketId: string, resolutionSent = false): ReplyDraft {
  return {
    id,
    ticketId,
    subject: `test ${id}`,
    channel: "freshdesk",
    product: "getsign",
    suggestedReply: DRAFT_TEXT,
    wantsClose: false,
    resolutionSent,
    escalated: false,
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    state: "pending",
    feedbackTags: ["tone", "not-a-real-tag"],
    feedbackNote: "  a bit long  ",
  } as ReplyDraft;
}

async function run(id: string, ticketId: string, body: string, resolutionSent = false) {
  await addReplyDraft(draft(id, ticketId, resolutionSent));
  return reconcileTicketDraft(ticketId, { source: "cron", stubReply: { body, userId: 42 } });
}

async function main() {
  // Sent as-is → good.
  const asIs = await run("d-asis", "9001", DRAFT_TEXT);
  assert.equal(asIs.usage, "used_as_is");
  const good = await getEvaluation("d-asis");
  assert.ok(good, "as-is draft must record an evaluation");
  assert.equal(good.rating, "good");
  assert.equal(good.source, "reconcile");
  assert.equal(good.action, "approve");
  assert.equal(good.finalBody, DRAFT_TEXT);
  assert.deepEqual(good.tags, ["tone"], "unknown feedback tags are dropped");
  assert.equal(good.note, "a bit long");
  assert.equal(good.decidedBy, "Stub Agent via freshdesk");

  // Edited → partial, with the human's reply kept for the distiller's diff.
  const editedBody =
    "Hi Amber Johnson, I looked into this. Signing links stay active until you disable them, so a link " +
    "expiring after one day is not expected. I've logged this with our engineering team. In the meantime, " +
    "resend the document from the Send section and the new link will work.";
  const edited = await run("d-edit", "9002", editedBody);
  assert.equal(edited.usage, "edited", `expected edited, got ${edited.usage} (${edited.score})`);
  const partial = await getEvaluation("d-edit");
  assert.equal(partial?.rating, "partial");
  assert.equal(partial?.finalBody, editedBody);

  // Not used → no evaluation at all.
  const unused = await run(
    "d-unused",
    "9003",
    "Hi, please grant Board Owner access to support@jetpackwork.com and send a Loom of the issue.",
  );
  assert.equal(unused.usage, "not_used");
  assert.equal(await getEvaluation("d-unused"), null, "unused draft must not record an evaluation");

  // Both recorded rows are queued for the distiller.
  const queued = (await getUndistilledEvaluations()).map((e) => e.id).sort();
  assert.deepEqual(queued, ["d-asis", "d-edit"]);

  // Follow-up scheduling follows what the customer RECEIVED. A resolution
  // draft the agent sent → 24h check-and-close. One they replaced with their
  // own words (ticket 14453: "escalated to dev, we'll follow up") → nothing,
  // or the cron tells a waiting customer "I'll assume this is resolved".
  await run("d-res-sent", "9004", DRAFT_TEXT, true);
  assert.ok(await getFollowUp("9004"), "a sent resolution must schedule the follow-up");
  const replaced = await run(
    "d-res-unused",
    "9005",
    "Hi Constance, I have escalated this issue directly to our development team and will follow up.",
    true,
  );
  assert.equal(replaced.usage, "not_used");
  assert.equal(await getFollowUp("9005"), null, "an unused resolution draft must not schedule a follow-up");
  assert.equal(await getFollowUp("9001"), null, "a non-resolution draft never schedules one");

  console.log("reconcile-evals-test: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
