/** Read-only: show Jetta's draft next to the agent reply it was scored against. */
import { listReplyDrafts } from "../lib/kv";
import { getAgentReplyAfter } from "../lib/tools/freshdesk";
import { normalizeReplyText, replySimilarity } from "../lib/reply-similarity";

async function main() {
  const ids = process.argv.slice(2);
  const drafts = (await listReplyDrafts()).filter((d) => ids.includes(d.ticketId));
  for (const d of drafts) {
    const since = new Date(d.createdAt * 1000).toISOString();
    const reply = await getAgentReplyAfter(d.ticketId, since);
    console.log(`\n${"=".repeat(78)}\nticket ${d.ticketId}  draft created ${since}  state=${d.state}`);
    console.log(`\n--- JETTA SUGGESTED (${d.suggestedReply.length} chars)\n${d.suggestedReply.slice(0, 700)}`);
    if (!reply) { console.log("\n--- NO AGENT REPLY FOUND AFTER DRAFT"); continue; }
    console.log(`\n--- AGENT ACTUALLY SENT (${reply.createdAt}, user ${reply.userId}, ${reply.body.length} chars)\n${reply.body.slice(0, 700)}`);
    console.log(`\n--- similarity: ${replySimilarity(normalizeReplyText(d.suggestedReply), normalizeReplyText(reply.body)).toFixed(3)}`);
  }
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(1); });
