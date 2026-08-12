/**
 * Live test for the monday.com client: searches the GetSign board, then
 * attempts to create one test item. The create is a no-op (logged only)
 * unless MONDAY_ALLOW_WRITES=true.
 *
 *   MONDAY_LIVE=true npx tsx scripts/monday-test.ts
 *
 * Pass a Freshdesk ticket id to also exercise screenshot forwarding — the
 * ticket's customer-sent images are downloaded and attached to the new item's
 * update. The download itself is live and reported even when writes are off,
 * so this is the way to verify the Freshdesk side before flipping the gate:
 *
 *   FRESHDESK_LIVE=true MONDAY_LIVE=true \
 *     npx tsx --env-file=.env.local scripts/monday-test.ts 13756
 */
import { searchDevBoard, createDevItem } from "../lib/tools/monday";
import { downloadTicketAttachments, getTicketDetails } from "../lib/tools/freshdesk";
import type { AttachmentFile } from "../lib/types";

async function main() {
  const ticketId = process.argv[2];

  console.log("--- search_dev_board('mapping') ---");
  console.log(JSON.stringify(await searchDevBoard("mapping", "getsign"), null, 2));

  let attachments: AttachmentFile[] = [];
  if (ticketId) {
    console.log(`\n--- attachments on ticket ${ticketId} ---`);
    const { attachments: all = [] } = await getTicketDetails(ticketId);
    for (const a of all) {
      console.log(`  [${a.author}] ${a.name} — ${a.contentType}, ${(a.size / 1024).toFixed(0)} KB`);
    }
    if (!all.length) console.log("  (none — pick a ticket with a customer screenshot to test this path)");

    attachments = await downloadTicketAttachments(ticketId);
    console.log(`\nforwardable (customer images, downloaded): ${attachments.length}`);
    for (const f of attachments) {
      console.log(`  ${f.name} — ${f.contentType}, ${(f.data.byteLength / 1024).toFixed(0)} KB`);
    }
  }

  console.log("\n--- create_dev_item ---");
  const item = await createDevItem({
    title: "[TEST] GetSign signed document not syncing status to monday board",
    product: "getsign",
    accountUrl: "https://app.fastspring.com/account/test-acct-123",
    errorDescription:
      "Signed document completes but the monday item status stays 'Pending Signature' instead of updating.",
    reproSteps:
      "1. Send a contract for signature from the board\n2. Client signs\n3. Observe the Status column does not update",
    freshdeskTicketUrl: ticketId
      ? `https://jetpackwork.freshdesk.com/a/tickets/${ticketId}`
      : "https://jetpackwork.freshdesk.com/a/tickets/13598",
    attachments,
  });
  console.log(JSON.stringify(item, null, 2));
  console.log(`\nfiles attached: ${item.filesAttached.length}/${attachments.length}`);
  console.log("Open it:", item.url);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
