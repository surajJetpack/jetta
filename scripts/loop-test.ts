/**
 * Phase 0 + Phase 1 end-to-end test (in-memory store, real Gemini for drafting).
 *   GOOGLE_GENERATIVE_AI_API_KEY=... LLM_PROVIDER=google npx tsx scripts/loop-test.ts
 */
import { recordOutcome, getOutcomes, addApprovedArticle, listApprovedArticles } from "../lib/kv";
import { draftKbArticle } from "../lib/knowledge-loop";
import { searchApprovedKb } from "../lib/knowledge/dynamic-kb";

const THREAD = `Jetta/bot: :rotating_light: Escalation — Ticket #13598. Issue: GetSign signed document completes but the monday item status stays "Pending Signature" instead of updating. Question: why isn't the signed-status callback firing?
team: Looked into it. The board was missing the Status column mapping in GetSign's Sign settings — the "signed" status update has nowhere to write. Fix: in the GetSign item view → Sign section, set the Status Column and pick the value to set on completion (e.g. "Signed"), then Save. After mapping, the status updates automatically when signing completes.`;

async function main() {
  console.log("=== Phase 0: record + read outcomes ===");
  await recordOutcome({
    ticketId: "13598", at: 1, channel: "freshdesk", product: "getsign",
    model: "google/gemini-2.5-pro", toolsUsed: ["search_knowledge_base", "reply_to_ticket", "send_escalation"],
    replied: true, resolutionSent: false, escalated: true, kind: "handled",
  });
  await recordOutcome({
    ticketId: "13599", at: 2, channel: "freshdesk", product: "getsign",
    model: "google/gemini-2.5-pro", toolsUsed: ["search_knowledge_base", "reply_to_ticket", "add_private_note"],
    replied: true, resolutionSent: true, escalated: false, kind: "handled",
  });
  const outcomes = await getOutcomes();
  console.log(`recorded ${outcomes.length}; escalated=${outcomes.filter((o) => o.escalated).length} resolved=${outcomes.filter((o) => o.resolutionSent).length}`);

  console.log("\n=== Phase 1: draft KB article from escalation thread (Gemini) ===");
  const draft = await draftKbArticle(THREAD);
  console.log("Title:", draft.title);
  console.log("Body:", draft.body.slice(0, 300));
  console.log("Keywords:", draft.keywords.join(", "));

  console.log("\n=== publish (approve) + verify search finds it ===");
  await addApprovedArticle({ title: draft.title, url: "", body: draft.body, keywords: draft.keywords, approvedBy: "U_TEST_ADMIN", at: 3 });
  console.log("approved articles:", (await listApprovedArticles()).length);
  const hits = await searchApprovedKb("signed document status not updating monday");
  console.log("search hits:", hits.map((h) => `${h.title} [${h.source}]`));
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
