/**
 * Controlled live WRITE test: posts ONE internal private note (agent-only,
 * never customer-visible) to a ticket, then re-fetches to confirm it landed.
 * Posts no customer-facing reply.
 *
 *   STUB_MODE=false npx tsx scripts/fd-note.ts <ticketId>
 */
import { getTicketDetails, addPrivateNote } from "../lib/tools/freshdesk";

const NOTE =
  "[Jetta] Live write-path verification — internal note posted by the Jetta " +
  "integration to confirm Freshdesk write access. Agent-only; no customer action needed.";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: fd-note.ts <ticketId>");

  const before = await getTicketDetails(id);
  console.log(`Ticket #${before.id}: ${before.subject}`);
  console.log(`Private notes before: ${before.replies.filter((r) => r.isPrivate).length}`);

  console.log("Posting private note...");
  await addPrivateNote(id, NOTE);

  const after = await getTicketDetails(id);
  const privateNotes = after.replies.filter((r) => r.isPrivate);
  console.log(`Private notes after: ${privateNotes.length}`);
  const latest = privateNotes.at(-1);
  if (latest) console.log(`Latest private note: "${latest.body.slice(0, 140)}"`);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
