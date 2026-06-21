/**
 * Read-only smoke test for the live Freshdesk client. Fetches one ticket
 * through our own getTicketDetails (exercising HTML stripping, conversation
 * parsing, status mapping, and contact lookup). Performs NO writes.
 *
 *   STUB_MODE=false npx tsx scripts/fd-read.ts <ticketId>
 */
import { getTicketDetails, listOpenTickets } from "../lib/tools/freshdesk";

async function main() {
  const id = process.argv[2];
  if (id) {
    const ticket = await getTicketDetails(id);
    console.log("--- getTicketDetails ---");
    console.log(JSON.stringify({ ...ticket, replies: `${ticket.replies.length} replies` }, null, 2));
    console.log("first 2 replies:");
    for (const r of ticket.replies.slice(0, 2)) {
      console.log(`  [${r.author}${r.isPrivate ? " private" : ""}] ${r.body.slice(0, 120)}`);
    }
  }
  console.log("--- listOpenTickets ---");
  console.log(JSON.stringify(await listOpenTickets(), null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
