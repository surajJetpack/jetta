/**
 * Distiller smoke test — synthetic evaluations through the real LLM.
 *
 *   npx tsx --env-file=.env.local scripts/distill-test.ts
 *
 * Pure: distillEvaluations takes data in / proposals out, so this makes NO
 * Redis writes and touches nothing but the LLM (needs OPENROUTER_API_KEY).
 *
 * Expectations (eyeball the output):
 *   - a NEW rule about not offering refunds proactively (from the edit diff)
 *   - a NEW rule about linking the SSO doc (from the discarded draft)
 *   - a REINFORCE of lrn-existing-tone (the tone edit confirms it)
 *   - nothing proposed from the good eval
 *   - no duplicate of lrn-rejected-emoji (it was rejected)
 */
import { distillEvaluations } from "../lib/distill";
import type { Learning, ReplyEvaluation } from "../lib/evals";

const now = Math.floor(Date.now() / 1000);

const EXISTING: Learning[] = [
  {
    id: "lrn-existing-tone",
    text: "Keep replies under three short paragraphs; lead with the fix, not an apology.",
    category: "conciseness",
    product: "all",
    state: "approved",
    createdAt: now - 86400 * 10,
    updatedAt: now - 86400 * 10,
    sourceEvalIds: [],
    reinforcedCount: 1,
  },
  {
    id: "lrn-rejected-emoji",
    text: "Use emojis to sound friendly.",
    category: "tone",
    product: "all",
    state: "rejected",
    createdAt: now - 86400 * 5,
    updatedAt: now - 86400 * 5,
    sourceEvalIds: [],
    reinforcedCount: 0,
  },
];

const base = {
  channel: "freshdesk" as const,
  decidedBy: "suraj",
  distilled: false,
};

const EVALS: ReplyEvaluation[] = [
  {
    ...base,
    id: "ev-refund-edit",
    ticketId: "101",
    subject: "GetSign not generating document",
    product: "getsign",
    at: now - 3600,
    action: "approve",
    rating: "partial",
    tags: ["policy"],
    note: "Never offer refunds unless the customer explicitly asks and policy allows.",
    suggestedReply:
      "Hi Maria,\n\nSorry about the trouble! The document generation failure is caused by an unsupported column type in your board. Please remove the Mirror column from the template and retry.\n\nIf this caused you any inconvenience, we'd be happy to refund your last month's subscription.\n\nBest,\nJetta",
    finalBody:
      "Hi Maria,\n\nSorry about the trouble! The document generation failure is caused by an unsupported column type in your board. Please remove the Mirror column from the template and retry.\n\nBest,\nJetta",
  },
  {
    ...base,
    id: "ev-sso-discard",
    ticketId: "102",
    subject: "Can't log in with company account",
    product: "jetpackapps",
    at: now - 3000,
    action: "discard",
    rating: "bad",
    tags: ["product-knowledge-gap"],
    note: "This is an SSO setup issue — should have linked the SSO setup doc instead of generic password-reset steps.",
    suggestedReply:
      "Hi Tom,\n\nPlease try resetting your password using the Forgot Password link on the login page. If that doesn't work, clear your browser cache and try again.\n\nBest,\nJetta",
  },
  {
    ...base,
    id: "ev-tone-edit",
    ticketId: "103",
    subject: "Sync delay question",
    product: "jetpackapps",
    at: now - 2400,
    action: "approve",
    rating: "partial",
    tags: ["conciseness"],
    suggestedReply:
      "Hi Ana,\n\nThank you so much for reaching out, and I sincerely apologize for any confusion this may have caused you. I completely understand how frustrating sync delays can be.\n\nSyncs run every 15 minutes on the free plan. You can trigger a manual sync from Settings → Sync → Run now.\n\nPlease don't hesitate to reach out if there is anything else at all I can help you with!\n\nBest,\nJetta",
    finalBody:
      "Hi Ana,\n\nSyncs run every 15 minutes on the free plan. You can trigger a manual sync from Settings → Sync → Run now.\n\nBest,\nJetta",
  },
  {
    ...base,
    id: "ev-good",
    ticketId: "104",
    subject: "How to duplicate a template",
    product: "getsign",
    at: now - 1800,
    action: "approve",
    rating: "good",
    tags: [],
    suggestedReply:
      "Hi Lee,\n\nYou can duplicate a template from Templates → ⋯ menu → Duplicate. The copy keeps all field mappings.\n\nBest,\nJetta",
    finalBody:
      "Hi Lee,\n\nYou can duplicate a template from Templates → ⋯ menu → Duplicate. The copy keeps all field mappings.\n\nBest,\nJetta",
  },
];

async function main() {
  console.log(`Distilling ${EVALS.length} synthetic evals against ${EXISTING.length} existing learnings…\n`);
  const proposals = await distillEvaluations(EVALS, EXISTING);
  if (!proposals.length) {
    console.log("No proposals returned — unexpected, check the prompt/model.");
    process.exitCode = 1;
    return;
  }
  for (const p of proposals) {
    console.log(`— ${p.kind.toUpperCase()}${p.learningId ? ` → ${p.learningId}` : ""} [${p.category}/${p.product}]`);
    console.log(`  ${p.text}`);
    console.log(`  why: ${p.rationale}`);
    console.log(`  from: ${p.sourceEvalIds.join(", ")}\n`);
  }
  const kinds = proposals.map((p) => p.kind);
  console.log(
    `Summary: ${kinds.filter((k) => k === "new").length} new, ${kinds.filter((k) => k === "reinforce").length} reinforce, ${kinds.filter((k) => k === "revise").length} revise`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
