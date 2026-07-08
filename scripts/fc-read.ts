/**
 * Read-only smoke test for the live Freshchat client. Fetches one conversation
 * through getConversationAsTicket (exercising message pagination, part
 * flattening, user lookup, and status mapping) plus the assignment gate.
 * Performs NO writes.
 *
 *   FRESHCHAT_LIVE=true npx tsx --env-file=.env.local scripts/fc-read.ts <conversationId>
 */
import { getConversationAsTicket, isAssignedToJetta } from "../lib/tools/freshchat";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: fc-read.ts <conversationId>");

  const ticket = await getConversationAsTicket(id);
  console.log("--- getConversationAsTicket ---");
  console.log(JSON.stringify({ ...ticket, replies: `${ticket.replies.length} replies` }, null, 2));
  console.log("first 3 replies:");
  for (const r of ticket.replies.slice(0, 3)) {
    console.log(`  [${r.author}${r.isPrivate ? " private" : ""}] ${r.body.slice(0, 120)}`);
  }

  console.log("--- isAssignedToJetta ---");
  console.log(await isAssignedToJetta(id));
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
