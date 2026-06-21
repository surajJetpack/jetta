/**
 * Live test for the Slack escalation post.
 *   SLACK_LIVE=true npx tsx scripts/slack-test.ts
 */
import { sendEscalation } from "../lib/tools/slack";

async function main() {
  const r = await sendEscalation({
    freshdeskTicketUrl: "https://jetpackwork.freshdesk.com/a/tickets/13598",
    userAccountUrl: "https://jetpackteam.monday.com/boards/18418635724/pulses/12327026152",
    summary:
      "GetSign signed document completes but the monday item status stays 'Pending Signature' instead of updating (request #GS-4471).",
    alreadyTried:
      "Searched KB (no matching article), confirmed the account, and asked the user for the board URL and Status/Files column names.",
    question:
      "Can someone check the webhook delivery logs for this account/board to see why the signed-status callback isn't firing?",
  });
  console.log("Posted to Slack. ts =", r.ts);
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
