/**
 * Does the dev bridge start a run only when a developer did something support
 * should act on — and never on its own echo?
 *
 *   npx tsx scripts/dev-bridge-test.ts
 *
 * No network, no model, no board: `classifyDevEvent`, `ticketIdsOnItem` and
 * `isJettaPost` are pure. The cases that matter most are the skips. Jetta's
 * monday token is a person's, so every comment she posts comes back through
 * the webhook looking like that person typing; answering it would be a loop
 * that posts on a real board until the rate limit stops it.
 */
import { classifyDevEvent, devEventMessage } from "../lib/dev-bridge";
import { isJettaContextPost, isJettaPost, ticketIdsOnItem, JETTA_POST_PREFIX } from "../lib/tools/monday";
import type { MondayWebhookEvent } from "../lib/activity";

export {};

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

const BOARDS = ["2978633042", "3713408976"];
const SELF = "82879261";
const DEV = "55501234";

const comment = (textBody: string, extra: Partial<MondayWebhookEvent> = {}): MondayWebhookEvent => ({
  type: "create_update",
  userId: DEV,
  boardId: 3713408976,
  pulseId: 13354642598,
  textBody,
  updateId: 900,
  ...extra,
});
const status = (label: string, columnTitle = "Dev Status", extra: Partial<MondayWebhookEvent> = {}): MondayWebhookEvent => ({
  type: "change_column_value",
  userId: DEV,
  boardId: 2978633042,
  pulseId: 1,
  columnType: "color",
  columnTitle,
  value: { label: { text: label } },
  ...extra,
});
const kind = (e: MondayWebhookEvent) => {
  const t = classifyDevEvent(e, BOARDS, SELF);
  return "skip" in t ? `skip:${t.skip}` : t.kind;
};

console.log("Comments");
{
  check("a developer's question starts a run", kind(comment("Which account is this on? Can't reproduce.")) === "comment");
  check("Jetta's own comment is skipped", kind(comment(`${JETTA_POST_PREFIX} Asked the customer for a recording.`, { userId: SELF })) === "skip:own post");
  check("…even with leading whitespace", kind(comment(`  ${JETTA_POST_PREFIX} hi`, { userId: SELF })) === "skip:own post");
  check(
    "Jetta's filing context post is skipped",
    kind(comment("Product: getsign\nAccount: x\nFreshdesk ticket: https://x/a/tickets/14611", { userId: SELF })) === "skip:own post",
  );
  check(
    "…and its same-ticket follow-up variant",
    kind(comment("Follow-up from the SAME Freshdesk ticket — added here.\n\nProduct: getsign", { userId: SELF })) === "skip:own post",
  );
  check("Suraj typing by hand (same token, no prefix) is a person", kind(comment("Customer called, it's urgent", { userId: SELF })) === "comment");
  check("monday automations are not people", kind(comment("Status changed", { userId: -4 })) === "skip:automation");
  check("a board that is not a dev board is ignored", kind(comment("hello", { boardId: 111 })) === "skip:not a dev board");
  check("an empty comment (image only) is skipped", kind(comment("   ")) === "skip:empty comment");

  const reply = classifyDevEvent(comment("Need the board id", { updateId: 900, replyId: 901 }), BOARDS, SELF);
  check(
    "a reply answers in its thread, and is remembered by its own id",
    "kind" in reply && reply.kind === "comment" && reply.threadUpdateId === "900" && reply.postId === "901",
    JSON.stringify(reply),
  );
}

console.log("Status changes");
{
  check("Need more info → needs_info", kind(status("Need more info")) === "needs_info");
  check("Waiting Customer → needs_info", kind(status("Waiting Customer")) === "needs_info");
  check("Dev Tasks' support Status 'Missing Info' → needs_info", kind(status("Missing Info", "Status")) === "needs_info");
  check("Deployed to Prod → finished", kind(status("Deployed to Prod")) === "finished");
  check("Could not Replicate → finished (the prompt asks for repro steps)", kind(status("Could not Replicate")) === "finished");
  check("Not a Bug on the support Status → finished", kind(status("Not a Bug", "Status")) === "finished");
  check("Working on it is progress, not an event", kind(status("Working on it")).startsWith("skip"));
  check("GetSign 'Done' is NOT finished (not deployed yet)", kind(status("Done")).startsWith("skip"));
  check("Priority is not the progress column", kind(status("Critical", "Priority")).startsWith("skip"));
  check("the Type column is not the progress column", kind(status("Question", "Type")).startsWith("skip"));
  check("a decorated title still matches", kind(status("Waiting Customer", "Dev Status ↗️")) === "needs_info");
  check("a people column change is not a status", kind(status("x", "Dev Status", { columnType: "multiple-person" })).startsWith("skip"));
}

console.log("Own posts");
{
  check("prefix detected", isJettaPost(`${JETTA_POST_PREFIX} anything`));
  check("a developer quoting Jetta mid-sentence is not her post", !isJettaPost(`Re ${JETTA_POST_PREFIX} — ok`));
  check("context post detected", isJettaContextPost("Product: jetpackapps\nAccount: …"));
  check("a developer's text is not a context post", !isJettaContextPost("The Product: column is wrong"));
}

console.log("Which ticket an item belongs to");
{
  // updates arrive newest first, as monday returns them
  const item = {
    column_values: [{ text: null }],
    updates: [
      { text_body: "Looks the same as https://jetpackwork.freshdesk.com/a/tickets/14400" },
      { text_body: "Product: getsign\nFreshdesk ticket: https://jetpackwork.freshdesk.com/a/tickets/14611" },
    ],
  };
  const ids = ticketIdsOnItem(item);
  check("the filed-for ticket outranks one a developer mentions later", ids[0] === "14611" && ids[1] === "14400", ids.join(","));
  check(
    "a ticket link column counts as filed-for",
    ticketIdsOnItem({ column_values: [{ text: "https://x.freshdesk.com/a/tickets/14331" }], updates: [] })[0] === "14331",
  );
  check("1433 is not 14331", !ticketIdsOnItem({ updates: [{ text_body: "/tickets/14331" }] }).includes("1433"));
  check("no link, no ticket", ticketIdsOnItem({ updates: [{ text_body: "fixed in 2.3" }] }).length === 0);
}

console.log("The message the run sees");
{
  const msg = devEventMessage({
    kind: "needs_info",
    itemId: "1",
    itemName: "Webhooks after owner transfer",
    itemUrl: "u",
    devStatus: "Need more info",
    author: "Dev A",
    developers: [],
    recent: [{ at: "2026-10-22", author: "Dev A", text: "Need the automation ids" }],
  });
  check("a status event carries the latest comments", msg.includes("Need the automation ids") && msg.includes("Need more info"));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
