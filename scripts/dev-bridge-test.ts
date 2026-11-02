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
import { addressedNames, classifyDevEvent, devEventMessage, isRepost } from "../lib/dev-bridge";
import {
  CHASE_PHRASE,
  devMentionTargets,
  chaseAllowed,
  isJettaContextPost,
  isJettaPost,
  isNeedsInfoDevStatus,
  itemActivity,
  ticketIdsOnItem,
  JETTA_POST_PREFIX,
} from "../lib/tools/monday";
import type { MondayWebhookEvent } from "../lib/activity";
import { countInlineImages } from "../lib/tools/freshdesk";

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

console.log("Chasing a quiet item (update_dev_item kind chase)");
{
  const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h)).toISOString();
  const chase = (h: number) => ({ text_body: `${JETTA_POST_PREFIX} The customer on ticket #1 ${CHASE_PHRASE}.`, created_at: at(h) });
  const dev = (h: number) => ({ text_body: "Looking into it", created_at: at(h) });
  const ctxPost = (h: number) => ({ text_body: "Product: getsign\nAccount: x", created_at: at(h) });
  const jettaInfo = (h: number) => ({ text_body: `${JETTA_POST_PREFIX} New from the customer on ticket #1:\nscreenshot`, created_at: at(h) });

  check("never chased → may chase", chaseAllowed(itemActivity([ctxPost(1)])));
  check("chased, nobody answered → may NOT chase again", !chaseAllowed(itemActivity([chase(5), ctxPost(1)])));
  check("chased, then a developer spoke → may chase again", chaseAllowed(itemActivity([dev(6), chase(5)])));
  check("a developer spoke BEFORE the chase only → no", !chaseAllowed(itemActivity([chase(5), dev(4)])));
  check(
    "a developer's reply inside an old thread counts as activity",
    chaseAllowed(itemActivity([chase(5), { ...dev(2), replies: [{ text_body: "fix is in review", created_at: at(7) }] }])),
  );
  check("Jetta's own relays are not developer activity", !chaseAllowed(itemActivity([jettaInfo(8), chase(5)])));
  check("her filing context is not developer activity", itemActivity([ctxPost(3)]).lastPersonActivityAt === null);
}

console.log("Needs-info statuses (shared by the bridge and the relay)");
{
  check("Need more info", isNeedsInfoDevStatus("Need more info"));
  check("Waiting Customer", isNeedsInfoDevStatus(" Waiting Customer "));
  check("Missing Info", isNeedsInfoDevStatus("Missing Info"));
  check("not Working on it", !isNeedsInfoDevStatus("Working on it"));
}

console.log("Question items still read as Jetta's filing");
{
  const q = "Product: getsign\nAccount: x\nFreshdesk ticket: https://x/a/tickets/14611\n\nQuestion from support (not a bug report): which webhook?";
  check("a question's context post is hers", isJettaContextPost(q));
  check("…and names the ticket it was filed for", ticketIdsOnItem({ updates: [{ text_body: q }] })[0] === "14611");
}

console.log("Signature icons are not screenshots (#14652)");
{
  const fd = (attrs = "") => `<img src="https://attachment.freshdesk.com/inline/attachment?token=abc"${attrs}>`;
  check("a pasted screenshot with no dimensions counts", countInlineImages(`<p>see this</p>${fd()}`) === 1);
  check("an Outlook signature icon inside a link does not", countInlineImages(`<table id="pbpsiglinktable"><tr><td><a href="https://bookings.cloud.microsoft/x"><img src="https://attachment.freshdesk.com/inline/attachment?token=abc"></a></td></tr></table>`) === 0);
  check("screenshot + linked icon → 1", countInlineImages(`${fd(' width="800" height="600"')}<a href="https://x">${fd()}</a>`) === 1);
  check("a small declared size is still dropped", countInlineImages(fd(' width="20" height="20"')) === 0);
}

console.log("The run sees a reply already drafted");
{
  const ev = { kind: "comment", itemId: "1", itemName: "x", itemUrl: "u", devStatus: "ToDo", author: "Swejal", text: "fix is on dev", developers: [], recent: [] } as Parameters<typeof devEventMessage>[0];
  check("no pending draft → no note", !devEventMessage(ev).includes("ALREADY DRAFTED"));
  const withDraft = devEventMessage({ ...ev, pendingReply: { at: "2026-10-28T08:44:00Z", body: "Hi Sneha, a fix has gone out." } });
  check("pending draft is shown to the run", withDraft.includes("ALREADY DRAFTED") && withDraft.includes("a fix has gone out"));
}

console.log("#14591: who she tags, hand-offs, reposts");
{
  // The item: Developer = Shreya. Swejal answered, addressed to Sujata (support).
  const users = new Map([
    ["82879261", "Suraj Malla"], // Jetta's own token
    ["76203847", "Shreya Shrestha"],
    ["78345437", "Swejal Shrestha"],
    ["53608181", "Sujata Shrestha"],
    ["64260832", "Gabriel Villegas"],
    ["99", "Shreya"], // a shorter name must not match inside a longer one
  ]);
  const answer =
    "1. Workflow Owner\nCurrently, we don't display the workflow owner alongside each workflow. However, we can retrieve this information from the database if needed.\n\n2. Workflow Ownership and Repair\nWorkflows are reassigned to the person clicking Repair only if they are a monday.com account admin.\n\n3. Once a workflow is deleted, its existing signing links will no longer work.\n\n@Sujata Shrestha You can reply these to the client. Please work closely with them so all their confusions are cleared . Let me know if I can help in any other way . Thanks";

  const to = addressedNames(answer, users, SELF, "78345437");
  check("a developer handing off to support is addressed to that person", to.length === 1 && to[0] === "Sujata Shrestha", to.join(","));
  check(
    "the file hand-off is too",
    addressedNames("@Sujata Shrestha \nanaliza-college-group-getsign-workflows.xlsx\nList of all the workflows with their owner", users, SELF, "78345437")[0] === "Sujata Shrestha",
  );
  check("@-ing Jetta's own account is talking to her, not a hand-off", addressedNames("@Suraj Malla which account is this?", users, SELF, "78345437").length === 0);
  check("no @ → addressed to nobody", addressedNames("Which account is this on?", users, SELF, "78345437").length === 0);
  check("a name without @ is not a mention", addressedNames("Sujata Shrestha asked about this", users, SELF, "78345437").length === 0);
  check("the longer name wins over a shorter user's name", addressedNames("@Shreya Shrestha can you check", users, SELF).join() === "Shreya Shrestha");
  check("an email is not a mention", addressedNames("mail nadav@analiza-college.co.il", users, SELF).length === 0);

  const ev = {
    kind: "comment" as const,
    itemId: "13414927936",
    itemName: "Question: GetSign workflow ownership",
    itemUrl: "u",
    devStatus: "Ready to start",
    author: "Swejal Shrestha",
    authorId: "78345437",
    text: answer,
    developers: [{ id: "76203847", name: "Shreya Shrestha" }],
    recent: [],
  };
  const t = devMentionTargets(ev);
  check("she tags the developer who wrote, not the Developer column", t.length === 1 && t[0].id === "78345437", JSON.stringify(t));
  check(
    "a status change (nobody wrote) still tags the Developer column",
    devMentionTargets({ ...ev, kind: "needs_info", authorId: undefined })[0].id === "76203847",
  );
  check("Suraj typing by hand (no authorId) falls back to the Developer column", devMentionTargets({ ...ev, authorId: undefined })[0].id === "76203847");

  const handoff = devEventMessage({ ...ev, addressedTo: ["Sujata Shrestha"] });
  check("a hand-off tells the run it is not hers to answer", handoff.includes("addressed to Sujata Shrestha") && handoff.includes("cannot post on the dev item"));
  check("a plain comment carries no hand-off note", !devEventMessage(ev).includes("addressed to"));

  check("the same answer posted again is a repost", isRepost(answer, answer.replace("Thanks", "Thanks!")));
  check("…even with the @mention added or changed", isRepost(answer.replace("@Sujata Shrestha ", ""), answer));
  check("a different comment on the same item is not", !isRepost(answer, "@Sujata Shrestha \nanaliza-college-group-getsign-workflows.xlsx\nList of all the workflows with their owner"));
  check("short comments never count as reposts (\"ok\" twice is two answers)", !isRepost("ok thanks", "ok thanks"));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
