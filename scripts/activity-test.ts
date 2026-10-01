/**
 * Deterministic tests for /activity (lib/activity.ts).
 *   npx tsx scripts/activity-test.ts
 *
 * No network, no storage — synthetic events, threads, Slack and monday rows.
 */
import {
  activitiesFromSlackThread,
  activitiesFromThread,
  activityFromEvent,
  activityFromKbAudit,
  activityFromMondayLog,
  activityFromMondayUpdate,
  activityFromMondayWebhook,
  activityFromSlackEvent,
  sameMondayAction,
  buildScorecard,
  filterTimeline,
  isMachineActor,
  parseAliases,
  resolvePerson,
  slackText,
  type Activity,
} from "../lib/activity";
import type { OpsEvent } from "../lib/events";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`}`);
}

const ev = (over: Partial<OpsEvent>): OpsEvent => ({
  id: "evt-1",
  at: Date.parse("2026-09-30T10:00:00Z"),
  level: "info",
  event: "x",
  source: "console",
  ...over,
});

// ── Identity ────────────────────────────────────────────────────────
const aliases = parseAliases("Cherryl=Cherryl B,U07CHER; Solutions=Solutions Team,ana");
check("alias: full Freshdesk name", resolvePerson("Cherryl B", aliases).name, "Cherryl");
check("alias: Slack id via alias", resolvePerson("slack:U07CHER", aliases).key, "cherryl");
check("alias: console login", resolvePerson("ana", aliases).name, "Solutions");
check("first name merges FD + console", resolvePerson("Sujata Rai", aliases).key, resolvePerson("sujata", aliases).key);
check("via-freshdesk suffix stripped", resolvePerson("Cherryl via freshdesk", aliases).name, "Cherryl");
check("Slack id resolved by name map", resolvePerson("slack:U09XYZ123", new Map(), { U09XYZ123: "Sujata Rai" }).name, "Sujata");
check("unresolved Slack id stays whole", resolvePerson("slack:U09XYZ123", new Map()).name, "U09XYZ123");
check("machine actors", ["dev", "console", "kb-sync", "review-outreach-script", undefined].map(isMachineActor), [true, true, true, true, true]);
check("a person is not a machine", isMachineActor("suraj"), false);

// ── Ops events ──────────────────────────────────────────────────────
check("machine event → null", activityFromEvent(ev({ event: "webhook.received" })), null);
check("no actor → null", activityFromEvent(ev({ event: "chat.human_joined", ticketId: "c1" })), null);
const joined = activityFromEvent(ev({ event: "chat.human_joined", actor: "cherryl", ticketId: "c1", data: { waitedMs: 120_000 } }));
check("chat join", [joined?.place, joined?.action, joined?.ref, joined?.waitMs, joined?.ticketId, joined?.url], [
  "chat",
  "chat.joined",
  "c1",
  120_000,
  undefined,
  "/chats/c1",
]);
const ticketed = activityFromEvent(ev({ event: "chat.ticketed_by_human", actor: "cherryl", ticketId: "c1", data: { freshdeskTicket: 14464 } }));
check("chat → ticket carries the FD id", ticketed?.ticketId, "14464");
const rec = activityFromEvent(ev({ event: "draft.reconciled", actor: "Cherryl B via freshdesk", data: { usage: "edited" } }));
check("reconciled draft → FD draft_edited", [rec?.place, rec?.action], ["freshdesk", "fd.draft_edited"]);
const cmd = activityFromEvent(ev({ event: "slack.privileged_action", source: "slack", actor: "U07CHER", data: { action: "extend_trial" } }));
check("slack command keeps the id for read-time naming", [cmd?.who, cmd?.detail], ["slack:U07CHER", "extend trial"]);
check("Slack DM to Jetta", activityFromEvent(ev({ event: "slack.dm_answered", source: "slack", actor: "U1", data: { chars: 9 } }))?.action, "slack.asked_jetta");
check("api key named", activityFromEvent(ev({ event: "draft.approved", actor: "api" }))?.who, "API key");

// ── Freshdesk thread ────────────────────────────────────────────────
const agents = new Map([
  [1, "App Support"],
  [2, "Cherryl B"],
]);
const thread = [
  { private: false, incoming: true, user_id: 99, created_at: "2026-09-30T08:00:00Z" },
  { private: true, incoming: false, user_id: 1, created_at: "2026-09-30T08:05:00Z" },
  { private: false, incoming: false, user_id: 2, created_at: "2026-09-30T09:00:00Z" },
  { private: true, incoming: false, user_id: 2, created_at: "2026-09-30T09:01:00Z" },
];
check(
  "FD: a Jetta-shaped note is dropped even without her id",
  activitiesFromThread(1, "s", [{ private: true, incoming: false, user_id: 1, created_at: "2026-09-30T08:05:00Z", body_text: "Jetta — suggested reply (pending)" }], agents, null).length,
  0,
);
const fd = activitiesFromThread(14464, "Docs not generating", thread, agents, 1, "https://x.freshdesk.com/a/tickets/");
check("FD: customer + Jetta skipped, reply + note kept", fd.map((a) => a.action), ["fd.reply", "fd.note"]);
check("FD: deterministic id", fd[0].id, `fd:14464:2:${Date.parse("2026-09-30T09:00:00Z")}`);
check("FD: link", fd[0].url, "https://x.freshdesk.com/a/tickets/14464");

// ── KB audit ────────────────────────────────────────────────────────
check("KB: sync actor dropped", activityFromKbAudit({ at: 1, actor: "kb-sync", articleId: "a", action: "update" }), null);
const kb = activityFromKbAudit({ at: 1_790_000_000, actor: "slack:U07CHER", articleId: "a1", title: "Pricing", action: "state_change", toState: "published" });
check("KB: publish, seconds → ms", [kb?.at, kb?.detail, kb?.who], [1_790_000_000_000, "published: Pricing", "slack:U07CHER"]);

// ── Slack ───────────────────────────────────────────────────────────
const parent = { ts: "1790000000.000100", bot_id: "B1", text: "*Escalation* <https://x.freshdesk.com/a/tickets/14464|#14464> broken" };
const replies = [
  parent,
  { ts: "1790000600.000200", user: "U07CHER", text: "on it" },
  { ts: "1790000900.000300", user: "U02DEV", text: "fixed" },
  { ts: "1790001000.000400", bot_id: "B1", text: "Jetta update" },
  { ts: "1790001100.000500", user: "U02DEV", subtype: "channel_join" },
];
const sl = activitiesFromSlackThread("C1", "jetta-escalations", parent, replies);
check("Slack: two human replies, bot + join skipped", sl.map((a) => a.who), ["slack:U07CHER", "slack:U02DEV"]);
check("Slack: only the first reply carries a response time", sl.map((a) => a.waitMs), [600_000, undefined]);
check("Slack: ticket id from Jetta's link", sl[0].ticketId, "14464");
check("Slack: mrkdwn to text", slackText(parent.text), "Escalation #14464 broken");
const humanParent = activitiesFromSlackThread("C1", "ops", { ts: "1790000000.1", user: "U1", text: "hi" }, []);
check("Slack: a person's own post counts as a message", humanParent.map((a) => a.action), ["slack.message"]);

// ── monday ──────────────────────────────────────────────────────────
const users = new Map([
  ["64260832", "Gabriel Villegas"],
  ["100086751", "Cherryl B"],
]);
const statusLog = {
  id: "l1",
  event: "update_column_value",
  user_id: "64260832",
  created_at: "17907019029483822",
  data: JSON.stringify({ pulse_id: 13162444300, pulse_name: "Credit usage restarted", column_title: "Dev Status", column_type: "color", value: { label: { text: "Ready to start" } } }),
};
const st = activityFromMondayLog(statusLog, "2978633042", "Dev Tasks", users, "https://m.monday.com");
check("monday: status change", [st?.action, st?.detail, st?.at], ["monday.status", "Dev Status → Ready to start — Credit usage restarted", 1790701902948]);
const textLog = { ...statusLog, id: "l2", data: JSON.stringify({ pulse_id: 1, column_type: "text", value: "x" }) };
check("monday: non-status column ignored", activityFromMondayLog(textLog, "b", "B", users, ""), null);
const owner = {
  ...statusLog,
  id: "l3",
  user_id: "100086751",
  data: JSON.stringify({ pulse_id: 1, pulse_name: "X", column_title: "Developer  ↗️", column_type: "multiple-person", textual_value: "Prashant Uprety" }),
};
check("monday: assignee change", activityFromMondayLog(owner, "b", "B", users, "")?.detail, "Developer → Prashant Uprety — X");
check("monday: unknown user dropped", activityFromMondayLog({ ...statusLog, user_id: "1" }, "b", "B", users, ""), null);
const upd = activityFromMondayUpdate(
  { id: "u1", created_at: "2026-09-29T17:14:03.000Z", creator_id: "64260832", item_id: "13162444300", text_body: "Hi\nTicket: https://jetpackwork.freshdesk.com/a/tickets/14436 please reset" },
  "2978633042",
  users,
  "https://m.monday.com",
  new Map([["13162444300", "Credit usage restarted"]]),
);
check("monday: comment with ticket", [upd?.action, upd?.ticketId, upd?.who], ["monday.comment", "14436", "Gabriel Villegas"]);

// ── Scorecard + timeline ────────────────────────────────────────────
const at = (h: number) => Date.parse(`2026-09-30T${String(h).padStart(2, "0")}:00:00Z`);
const acts: Activity[] = [
  { id: "1", at: at(9), place: "freshdesk", who: "Cherryl B", action: "fd.reply" },
  { id: "2", at: at(9), place: "freshdesk", who: "Cherryl B", action: "fd.note" },
  { id: "3", at: at(10), place: "chat", who: "cherryl", action: "chat.joined", waitMs: 4 * 60_000 },
  { id: "4", at: at(11), place: "chat", who: "cherryl", action: "chat.joined", waitMs: 10 * 60_000 },
  { id: "5", at: at(12), place: "slack", who: "slack:U07CHER", action: "slack.reply", waitMs: 30 * 60_000 },
  { id: "6", at: at(13), place: "console", who: "suraj", action: "console.login" },
  { id: "7", at: at(14), place: "freshdesk", who: "Cherryl via freshdesk", action: "fd.draft_used" },
];
const sc = buildScorecard(acts, { aliases, tz: "UTC" });
const cher = sc.people.find((p) => p.key === "cherryl")!;
check("scorecard: one Cherryl across four identities", sc.people.map((p) => p.key), ["cherryl", "suraj"]);
check("scorecard: counts by column", [cher.counts.fdReplies, cher.counts.fdNotes, cher.counts.chats, cher.counts.slack, cher.counts.console], [1, 1, 2, 1, 1]);
check("scorecard: medians", [cher.chatPickupMin, cher.slackResponseMin], [7, 30]);
check("scorecard: places + days + hours", [cher.places, cher.activeDays, cher.hours[9]], [["freshdesk", "chat", "slack"], 1, 2]);
const suraj = sc.people.find((p) => p.key === "suraj")!;
check("scorecard: sign-in is last-seen, not work", [suraj.total, suraj.lastAt], [0, at(13)]);
check("scorecard: totals", [sc.total, sc.byPlace.freshdesk], [6, 3]);
check(
  "timeline: person + column, newest first",
  filterTimeline(acts, { person: "cherryl", column: "chats" }, { aliases }).map((a) => a.id),
  ["4", "3"],
);
check("timeline: logins hidden by default", filterTimeline(acts, {}, { aliases }).some((a) => a.action === "console.login"), false);
check("timeline: place filter", filterTimeline(acts, { place: "freshdesk" }, { aliases }).map((a) => a.id), ["7", "1", "2"]); // equal times keep their order

// ── Pushed events ───────────────────────────────────────────────────
const reply = { channel: "C1", channel_type: "group", ts: "1790000600.000200", thread_ts: "1790000000.000100", user: "U07CHER", text: "on it" };
const jettaParent = { topic: "Escalation #14464", ticketId: "14464" };
const r1 = activityFromSlackEvent(reply, "jetta-escalations", jettaParent, true);
check("Slack push: first reply under Jetta's post is timed", [r1?.action, r1?.waitMs, r1?.ticketId, r1?.id], ["slack.reply", 600_000, "14464", "slack:C1:1790000600.000200"]);
check("Slack push: same id as the polled row", r1?.id, sl[0].id);
check("Slack push: later reply not timed", activityFromSlackEvent(reply, "x", jettaParent, false)?.waitMs, undefined);
check("Slack push: reply in a person's thread not timed", activityFromSlackEvent(reply, "x", null, true)?.waitMs, undefined);
check("Slack push: bot ignored", activityFromSlackEvent({ ...reply, bot_id: "B1" }, "x", null, true), null);
check("Slack push: edit ignored", activityFromSlackEvent({ ...reply, subtype: "message_changed" }, "x", null, true), null);
check("Slack push: top-level post", activityFromSlackEvent({ channel: "C1", ts: "1790000000.1", user: "U1", text: "hi" }, "ops", null, false)?.action, "slack.message");

const mu = new Map([["64260832", "Gabriel Villegas"], ["82879261", "Suraj Malla"], ["63706225", "Prashant Uprety"]]);
const wStatus = activityFromMondayWebhook(
  { type: "update_column_value", userId: 64260832, boardId: 2978633042, pulseId: 13162444300, pulseName: "Credit usage restarted", columnTitle: "Dev Status", columnType: "color", value: { label: { text: "Ready to start" } }, triggerTime: "2026-09-30T07:55:04.610Z", triggerUuid: "u1" },
  mu, "https://m.monday.com", "Dev Tasks", "82879261",
);
check("monday push: status", [wStatus?.action, wStatus?.detail, wStatus?.who], ["monday.status", "Dev Status → Ready to start — Credit usage restarted", "Gabriel Villegas"]);
check("monday push: matches the log row for the same change", sameMondayAction(wStatus!, { ...st!, at: wStatus!.at + 400 }), true);
check("monday push: a different value is a different action", sameMondayAction(wStatus!, { ...st!, at: wStatus!.at + 400, detail: "Dev Status → Done — Credit usage restarted" }), false);
check("monday push: assignee names from ids",
  activityFromMondayWebhook({ type: "update_column_value", userId: 64260832, pulseId: 1, pulseName: "X", columnTitle: "Developer  ↗️", columnType: "multiple-person", value: { personsAndTeams: [{ id: 63706225, kind: "person" }] }, triggerUuid: "u2" }, mu, "", "B", null)?.detail,
  "Developer → Prashant Uprety — X");
check("monday push: Jetta's context post dropped",
  activityFromMondayWebhook({ type: "create_update", userId: 82879261, pulseId: 1, textBody: "Product: getsign\nAccount: …", updateId: 9 }, mu, "", "B", "82879261"), null);
const myComment = activityFromMondayWebhook({ type: "create_update", userId: 82879261, pulseId: 1, pulseName: "X", textBody: "checked with the dev", updateId: 9 }, mu, "", "B", "82879261");
check("monday push: the token owner's own comment counts", [myComment?.who, myComment?.id], ["Suraj Malla", "monu:9"]);
check("monday push: Jetta-created item dropped", activityFromMondayWebhook({ type: "create_pulse", userId: 82879261, pulseId: 1 }, mu, "", "B", "82879261"), null);
check("monday push: unknown user dropped", activityFromMondayWebhook({ type: "create_update", userId: 5, updateId: 1 }, mu, "", "B", null), null);
check("monday push: move", activityFromMondayWebhook({ type: "move_pulse_into_group", userId: 64260832, pulseId: 1, pulseName: "X", destGroup: { title: "Done" }, triggerUuid: "u3" }, mu, "", "B", null)?.detail, "to Done — X");

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
