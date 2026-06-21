/**
 * Live test for the monday.com client. Reads the board, then creates ONE test
 * item with structured columns. Run against the TEST board only.
 *
 *   MONDAY_LIVE=true npx tsx scripts/monday-test.ts
 */
import { searchDevBoard, createDevItem } from "../lib/tools/monday";

async function main() {
  console.log("--- search_dev_board('mapping') ---");
  console.log(JSON.stringify(await searchDevBoard("mapping"), null, 2));

  console.log("\n--- create_dev_item ---");
  const item = await createDevItem({
    title: "[TEST] GetSign signed document not syncing status to monday board",
    product: "getsign",
    accountUrl: "https://app.fastspring.com/account/test-acct-123",
    errorDescription:
      "Signed document completes but the monday item status stays 'Pending Signature' instead of updating.",
    reproSteps:
      "1. Send a contract for signature from the board\n2. Client signs\n3. Observe the Status column does not update",
    freshdeskTicketUrl: "https://jetpackwork.freshdesk.com/a/tickets/13598",
  });
  console.log(JSON.stringify(item, null, 2));
  console.log("\nOpen it:", item.url);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
