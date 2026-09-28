/**
 * Deterministic tests for the /health numbers (lib/support-health.ts).
 *   npx tsx scripts/support-health-test.ts
 *
 * No network, no storage — synthetic records.
 */
import { chatWindow, summarizeTicket, type HandoffOutcome, type PerfConversation, type PerfTicket } from "../lib/performance";
import {
  backlog,
  backlogBucket,
  buildHealth,
  healthPeriod,
  owesReply,
  percentile,
  toneAbove,
  toneBelow,
  type HealthTicket,
} from "../lib/support-health";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`);
}

const NOW = Date.parse("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3.6e6).toISOString();

const rec = (p: Partial<HealthTicket> = {}): HealthTicket => ({
  v: 2,
  id: 1,
  subject: "Help",
  status: 4,
  createdAt: hoursAgo(48),
  updatedAt: hoursAgo(24),
  source: 1,
  agentReplies: 1,
  customerMsgs: 1,
  firstReplyH: 2,
  firstReplyBy: "Cherryl",
  firstReplyWords: 50,
  firstReplyHasLink: false,
  resolvedH: 20,
  reopened: false,
  suggestions: [],
  fromChat: false,
  devWork: false,
  handoff: null,
  app: "getsign",
  topic: null,
  ...p,
});

// ── Whose turn is it? ──
{
  const agents = new Map([[1, "App Support"], [2, "Cherryl"]]);
  const list = { id: 9, subject: "x", source: 1, status: 6, created_at: hoursAgo(10), updated_at: hoursAgo(1) };
  const m = (p: Partial<PerfConversation>): PerfConversation => ({ private: false, incoming: false, created_at: hoursAgo(5), body_text: "", ...p });
  const customerLast = summarizeTicket(list, [
    m({ user_id: 2, created_at: hoursAgo(8) }),
    m({ incoming: true, user_id: 99, created_at: hoursAgo(3) }),
    // Jetta's private suggestion seconds later must not read as "we replied".
    m({ private: true, user_id: 1, created_at: hoursAgo(2.99), body_text: "Jetta — suggested reply (pending) hi" }),
  ], agents, 1);
  check("customer wrote last (private note ignored)", [customerLast.lastPublicFrom, customerLast.lastPublicAt], ["customer", hoursAgo(3)]);
  const agentLast = summarizeTicket(list, [m({ incoming: true, created_at: hoursAgo(8) }), m({ user_id: 2, created_at: hoursAgo(3) })], agents, 1);
  check("agent wrote last", agentLast.lastPublicFrom, "agent");
  const empty = summarizeTicket(list, [], agents, 1);
  check("no thread = the opening message is the customer's", [empty.lastPublicFrom, empty.lastPublicAt], ["customer", hoursAgo(10)]);
}

// ── Ball-in-court buckets ──
check("thread beats status: 'waiting on customer' but they wrote back", backlogBucket(rec({ status: 6, lastPublicFrom: "customer" })), "owes_reply");
check("agent last on status 6 = customer's turn", backlogBucket(rec({ status: 6, lastPublicFrom: "agent" })), "customer");
check("escalated to dev", backlogBucket(rec({ status: 8, lastPublicFrom: "agent" })), "engineering");
check("working on it", backlogBucket(rec({ status: 7, lastPublicFrom: "agent" })), "in_progress");
check("old record, never answered = owes", owesReply({ agentReplies: 0, status: 6 }), true);
check("old record, status open = owes", owesReply({ agentReplies: 2, status: 2 }), true);
check("old record, waiting on customer = not owed", owesReply({ agentReplies: 2, status: 6 }), false);

{
  const b = backlog(
    [
      rec({ id: 1, status: 6, lastPublicFrom: "customer", lastPublicAt: hoursAgo(30) }),
      rec({ id: 2, status: 2, lastPublicFrom: "customer", lastPublicAt: hoursAgo(3) }),
      rec({ id: 3, status: 8, lastPublicFrom: "agent" }),
      rec({ id: 4, status: 6, lastPublicFrom: "agent" }),
      rec({ id: 5, status: 4 }),
      rec({ id: 6, status: 5, lastPublicFrom: "customer" }),
    ],
    NOW,
  );
  check("backlog counts", [b.open, b.owesReply, b.engineering, b.inProgress, b.customer], [4, 2, 1, 0, 1]);
  check("overdue past 24h", b.overdue, 1);
  check("longest wait first", b.waiting.map((w) => w.ticketId), [1, 2]);
  check("waiting hours from the customer's last message", b.oldestOwedH, 30);
}

// ── Period numbers ──
check("percentile nearest-rank", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
check("percentile of nothing", percentile([null], 0.9), null);
{
  const p = healthPeriod(
    [
      rec({ id: 1, firstReplyH: 2 }),
      rec({ id: 2, firstReplyH: 30, reopened: true }),
      // Open, unanswered, 48h old: a miss for both bars, not a gap in the data.
      rec({ id: 3, status: 2, agentReplies: 0, firstReplyH: null, resolvedH: null, createdAt: hoursAgo(48) }),
      // Open, unanswered, 1h old: not due yet for either bar.
      rec({ id: 4, status: 2, agentReplies: 0, firstReplyH: null, resolvedH: null, createdAt: hoursAgo(1) }),
      // Closed without a reply: marketing, not a ticket.
      rec({ id: 5, status: 5, agentReplies: 0, firstReplyH: null }),
    ],
    NOW,
  );
  check("real tickets exclude closed-unanswered", [p.tickets, p.answered], [4, 2]);
  check("within 24h: 1 hit of 3 due", p.withinTarget, 0.333);
  check("within 4h: 1 hit of 3 due", p.withinFast, 0.333);
  check("reopen rate over answered", p.reopenRate, 0.5);
}

// ── The whole payload ──
{
  const outcomes = new Map<number, HandoffOutcome>([
    [10, { ticketId: 10, category: "real_bug", confidence: "high", evidence: "", missingKnowledge: null, kbArticleTitle: null, kbCoverage: null, kbArticle: null, judgedAt: 0, basisUpdatedAt: "", model: "" }],
  ]);
  const tickets: HealthTicket[] = [
    rec({ id: 10, app: "getsign", topic: "signer email", handoff: { kinds: ["dev_item"], at: hoursAgo(40), itemIds: [] }, devWork: true }),
    rec({ id: 11, app: "getsign", topic: "signer email", suggestions: [{ at: hoursAgo(47), sim: 0.9, replyBy: "x", waitH: 1 }] }),
    rec({ id: 12, app: "vlookup", topic: "sync not working", status: 6, lastPublicFrom: "customer", lastPublicAt: hoursAgo(5) }),
    rec({ id: 13, app: "vlookup", createdAt: hoursAgo(24 * 40) }), // previous window
    rec({ id: 14, app: "trackmy", createdAt: hoursAgo(1) }), // this (partial) week
  ];
  const h = buildHealth(tickets, outcomes, { recent: { real: 5, alone: 2 }, previous: { real: 3, alone: 1 } }, NOW);
  check("recent vs previous tickets", [h.recent.tickets, h.previous.tickets], [4, 1]);
  const gs = h.apps.find((a) => a.app === "getsign");
  check("getsign row: 2 tickets, 1 real bug", [gs?.tickets, gs?.bugs], [2, 1]);
  const vl = h.apps.find((a) => a.app === "vlookup");
  check("vlookup row: 1 recent, 1 previous, 1 owes", [vl?.tickets, vl?.previous, vl?.owesReply], [1, 1, 1]);
  check("apps sorted by recent volume", h.apps[0].app, "getsign");
  check("top topic", [h.topics[0].topic, h.topics[0].count, h.topics[0].apps], ["signer email", 2, ["getsign"]]);
  check("topic coverage", h.topicCoverage, 0.75);
  check("engineering share", h.recent.engineeringRate, 0.25);
  check("load: drafts + chats alone", [h.load.ticketsDrafted, h.load.chatsFinishedAlone], [1, 2]);
  check("current week flagged partial", h.weeks.at(-1)?.partial, true);
  check("nothing per agent in the payload", JSON.stringify(h).includes("Cherryl"), false);
}

// ── Chats ──
{
  const c = (createdAt: string, text: string, ticketId?: string) => ({
    createdAt,
    status: "closed",
    ticketId,
    messages: [{ author: "visitor", text }],
  });
  const w = chatWindow(
    [
      c(hoursAgo(5), "how do I add a second signer please"),
      c(hoursAgo(6), "my sync stopped working since yesterday", "14001"),
      c(hoursAgo(7), "hi"),
      c(hoursAgo(24 * 30), "an older question outside the window"),
    ],
    hoursAgo(24 * 28),
    hoursAgo(0),
  );
  check("chat window: 2 real, 1 alone", w, { real: 2, alone: 1 });
}

check("tone: share above target", [toneAbove(0.95, { good: 0.9, warn: 0.75 }), toneAbove(0.8, { good: 0.9, warn: 0.75 }), toneAbove(0.5, { good: 0.9, warn: 0.75 })], ["good", "warn", "bad"]);
check("tone: hours below target", [toneBelow(3, { good: 4, warn: 12 }), toneBelow(null, { good: 4, warn: 12 })], ["good", null]);

// Keep PerfTicket assignable to what the sync stores.
const _shape: PerfTicket = rec();
void _shape;

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
