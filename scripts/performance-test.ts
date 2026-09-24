/**
 * Deterministic tests for the /performance numbers (lib/performance.ts).
 *   npx tsx scripts/performance-test.ts
 *
 * No network, no storage — synthetic Freshdesk tickets and threads.
 */
import { handoffEvidence } from "../lib/handoff-judge";
import {
  bucketOf,
  buildSummary,
  chatWeeks,
  detectHandoff,
  handoffSummary,
  isSettled,
  isJunkSubject,
  median,
  periodStats,
  suggestionBody,
  summarizeTicket,
  weekStart,
  withBoardHandoffs,
  type HandoffOutcome,
  type PerfConversation,
  type PerfListTicket,
} from "../lib/performance";

const JETTA = 1;
const AGENTS = new Map([
  [JETTA, "App Support"],
  [2, "Cherryl"],
  [3, "Solutions Team"],
]);

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`);
}

const ticket = (p: Partial<PerfListTicket> = {}): PerfListTicket => ({
  id: 100,
  subject: "Signer email not resolving",
  source: 1,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  stats: { resolved_at: "2026-09-03T10:00:00Z", reopened_at: null },
  ...p,
});
const msg = (p: Partial<PerfConversation>): PerfConversation => ({
  private: false,
  incoming: false,
  created_at: "2026-09-01T10:00:00Z",
  body_text: "",
  ...p,
});

const DRAFT = "Hi Sonia, thanks for the recording. Please map the signer role to the Email column in the view settings, then resend the document.";
const note = (body: string, at: string) =>
  msg({ private: true, user_id: JETTA, created_at: at, body_text: `Jetta — suggested reply (pending)   ${body}   To use it: copy into the reply editor, edit freely, and send as yourself.` });

// ── suggestionBody strips the note wrapper ──
check("suggestionBody strips header and footer", suggestionBody(note(DRAFT, "x").body_text!), DRAFT);

// ── a draft sent verbatim, then one ignored for a call ──
{
  const t = summarizeTicket(
    ticket(),
    [
      note(DRAFT, "2026-09-01T10:01:00Z"),
      msg({ user_id: 3, created_at: "2026-09-01T12:01:00Z", body_text: DRAFT }),
      msg({ incoming: true, user_id: 99, created_at: "2026-09-01T13:00:00Z", body_text: "Still broken." }),
      note("Could you share the automation ID so we can check the recipe?", "2026-09-01T13:01:00Z"),
      msg({ user_id: 2, created_at: "2026-09-01T15:01:00Z", body_text: "Let's jump on a call — here's my calendar https://cal.example/x" }),
      msg({ private: true, user_id: 2, created_at: "2026-09-01T15:02:00Z", body_text: "internal note" }),
    ],
    AGENTS,
    JETTA,
  );
  check("agent public replies counted (private notes excluded)", t.agentReplies, 2);
  check("customer messages = opening + 1 incoming", t.customerMsgs, 2);
  check("first reply time in hours", t.firstReplyH, 2.02);
  check("first reply by", t.firstReplyBy, "Solutions Team");
  check("resolved hours", t.resolvedH, 48);
  check("two suggestions", t.suggestions.length, 2);
  check("verbatim draft scores 1", t.suggestions[0].sim, 1);
  check("draft wait", t.suggestions[0].waitH, 2);
  check("second draft paired with Cherryl's call reply", t.suggestions[1].replyBy, "Cherryl");
  check("call reply is not a reuse", (t.suggestions[1].sim ?? 1) < 0.35, true);

  const s = periodStats([t]);
  check("period: 1 answered, full coverage", [s.answered, s.coverage], [1, 1]);
  check("period: as-is / edited / not used", [s.asIs, s.edited, s.notUsed], [1, 0, 1]);
  check("period: used rate", s.usedRate, 0.5);
  check("period: first reply link rate", s.linkRate, 0);
}

// ── a suggestion nobody answered is not judged ──
{
  const t = summarizeTicket(ticket({ id: 101 }), [note(DRAFT, "2026-09-01T10:01:00Z")], AGENTS, JETTA);
  check("unanswered suggestion has null sim", t.suggestions[0].sim, null);
  const s = periodStats([t]);
  check("unanswered ticket not counted as answered", [s.answered, s.judged, s.coverage], [0, 0, null]);
}

// ── ticket Jetta opened from chat: description is her summary, not the customer ──
{
  const t = summarizeTicket(
    ticket({ id: 102, source: 7 }),
    [msg({ private: true, user_id: JETTA, body_text: "Opened by Jetta from a live chat. Conversation: https://…" }),
     msg({ private: true, user_id: JETTA, body_text: "Created dev board item: https://monday…" })],
    AGENTS,
    JETTA,
  );
  check("fromChat + devWork flags", [t.fromChat, t.devWork], [true, true]);
  check("chat ticket has no opening customer message", t.customerMsgs, 0);
}

// ── Jetta's account posting publicly (pre-Jetta shared human account) counts as a reply ──
{
  const t = summarizeTicket(ticket({ id: 103 }), [msg({ user_id: JETTA, created_at: "2026-09-01T10:30:00Z", body_text: "Hi!" })], AGENTS, JETTA);
  check("App Support public reply counts", t.agentReplies, 1);
}

// ── helpers ──
check("junk: automatic reply", isJunkSubject("Automatic reply: Still editing"), true);
check("junk: OOO prefix", isJunkSubject("OOO - expect delayed response"), true);
check("junk: real subject", isJunkSubject("Pricing package"), false);
check("median odd", median([3, 1, 2]), 2);
check("median even, nulls skipped", median([1, null, 4]), 2.5);
check("median empty", median([]), null);
check("weekStart Wednesday → Monday", weekStart("2026-09-23T15:00:00Z"), "2026-09-21");
check("weekStart Monday stays", weekStart("2026-09-21T00:00:00Z"), "2026-09-21");
check("weekStart Sunday → previous Monday", weekStart("2026-09-27T23:59:00Z"), "2026-09-21");

// ── chat weeks ──
{
  const weeks = chatWeeks([
    { createdAt: "2026-09-22T10:00:00Z", status: "resolved", messages: [{ author: "visitor", text: "how do I map multiple signer roles?" }, { author: "agent", via: "jetta", text: "…" }] },
    { createdAt: "2026-09-22T11:00:00Z", status: "ticketed", ticketId: "14416", messages: [{ author: "visitor", text: "automations are greyed out in monday" }] },
    { createdAt: "2026-09-22T12:00:00Z", status: "resolved", messages: [{ author: "visitor", text: "hi" }] },
    { createdAt: "2026-09-22T13:00:00Z", status: "resolved", messages: [{ author: "visitor", text: "[TEST] widget health check, ignore" }] },
    { createdAt: "2026-09-23T13:00:00Z", status: "resolved", messages: [{ author: "visitor", text: "give me a human please now" }, { author: "agent", via: "human", text: "Suraj here" }] },
  ]);
  check("chat week: greeting and test excluded; alone vs handed off", weeks, [{ week: "2026-09-21", real: 3, alone: 1, handedOff: 2 }]);
}

// ── summary windows ──
{
  const now = Date.parse("2026-09-23T12:00:00Z");
  const mk = (id: number, created: string) =>
    summarizeTicket(ticket({ id, created_at: created }), [msg({ user_id: 2, created_at: created, body_text: "ok" })], AGENTS, JETTA);
  const sum = buildSummary(
    [mk(1, "2026-06-01T09:00:00Z"), mk(2, "2026-08-10T09:00:00Z"), mk(3, "2026-09-20T09:00:00Z")],
    now,
    null,
  );
  check("summary: baseline / previous / recent split", [sum.baseline.answered, sum.previous.answered, sum.recent.answered], [1, 1, 1]);
  check("summary: weeks sorted", sum.weeks.map((w) => w.week), ["2026-06-01", "2026-08-10", "2026-09-14"]);
  check("summary: since", sum.since, "2026-06-01");
  check("summary: agents from recent window only", sum.agents.map((a) => [a.agent, a.firstReplies]), [["Cherryl", 1]]);
}

// ── handoff detection: every wording her notes have used ──
{
  const n = (body: string, at = "2026-09-10T10:00:00Z") => msg({ private: true, user_id: JETTA, created_at: at, body_text: body });
  check("no handoff on a plain ticket", detectHandoff([n("Jetta — suggested reply (pending) Hi")]), null);
  check(
    "dev item + slack in one note, item id from URL",
    detectHandoff([n("Escalated to dev team via Slack (ts 1790). Created dev board item: https://jetpackteam.monday.com/boards/3713408976/pulses/13102329370")]),
    { kinds: ["dev_item", "slack"], at: "2026-09-10T10:00:00Z", itemIds: ["13102329370"] },
  );
  check(
    "matched existing item by id in prose; earliest note wins",
    detectHandoff([
      n("Strong match found on Dev board: item 13103351454 — GetSign cannot read email", "2026-09-12T10:00:00Z"),
      n("Opened by Jetta from a live chat. Conversation: https://jettajetpack.vercel.app/chats/x", "2026-09-11T10:00:00Z"),
    ]),
    { kinds: ["dev_item", "chat"], at: "2026-09-11T10:00:00Z", itemIds: ["13103351454"] },
  );
  check("'Escalated urgently to engineering' counts as Slack", detectHandoff([n("Escalated urgently to engineering via Slack.")])?.kinds, ["slack"]);
  const t = summarizeTicket(ticket({ id: 104 }), [n("Dev board item created: https://x.monday.com/boards/1/pulses/12345678")], AGENTS, JETTA);
  check("summarizeTicket carries handoff + subject + schema", [t.handoff?.kinds, t.subject, t.v], [["dev_item"], "Signer email not resolving", 2]);
}

// ── board-recorded handoffs fill what her notes missed ──
{
  const plain = summarizeTicket(ticket({ id: 200 }), [], AGENTS, JETTA);
  const noted = { ...plain, id: 201, handoff: { kinds: ["slack" as const], at: "2026-09-01T00:00:00Z", itemIds: [] } };
  const [a, b, c] = withBoardHandoffs([plain, noted, { ...plain, id: 202 }], {
    "200": { itemIds: ["111"], jettaFiledAt: "2026-09-02T00:00:00Z" },
    "201": { itemIds: ["222"], jettaFiledAt: "2026-09-03T00:00:00Z" },
  });
  check("board-only item becomes a dev_item handoff", a.handoff, { kinds: ["dev_item"], at: "2026-09-02T00:00:00Z", itemIds: ["111"] });
  check("noted handoff keeps its time, gains the item", b.handoff, { kinds: ["slack", "dev_item"], at: "2026-09-01T00:00:00Z", itemIds: ["222"] });
  check("untouched ticket stays untouched", c.handoff, null);
}

// ── settled + buckets ──
{
  const now = Date.parse("2026-09-24T00:00:00Z");
  check("resolved is settled", isSettled({ status: 4, updatedAt: "2026-09-23T00:00:00Z" }, now), true);
  check("open and recent is not settled", isSettled({ status: 2, updatedAt: "2026-09-22T00:00:00Z" }, now), false);
  check("open but quiet 8 days is settled", isSettled({ status: 2, updatedAt: "2026-09-15T00:00:00Z" }, now), true);
  const o = (category: HandoffOutcome["category"]) => ({ category }) as HandoffOutcome;
  check("buckets", [bucketOf(undefined), bucketOf(o("unresolved")), bucketOf(o("real_bug")), bucketOf(o("feature_request"))], ["awaiting", "awaiting", "real_bug", "other"]);
}

// ── handoff summary ──
{
  const now = Date.parse("2026-09-24T00:00:00Z");
  const mk = (id: number, at: string, kinds: ("dev_item" | "slack" | "chat")[]) => ({
    ...summarizeTicket(ticket({ id, created_at: at, subject: `S${id}` }), [], AGENTS, JETTA),
    handoff: { kinds, at, itemIds: [] },
  });
  const tickets = [mk(1, "2026-09-20T00:00:00Z", ["dev_item"]), mk(2, "2026-09-21T00:00:00Z", ["chat"]), mk(3, "2026-07-20T00:00:00Z", ["slack"]), mk(4, "2026-09-22T00:00:00Z", ["chat", "slack"])];
  const out = (ticketId: number, category: HandoffOutcome["category"], extra: Partial<HandoffOutcome> = {}): [number, HandoffOutcome] => [
    ticketId,
    { ticketId, category, confidence: "high", evidence: `e${ticketId}`, missingKnowledge: null, kbArticleTitle: null, kbCoverage: null, kbArticle: null, judgedAt: 0, basisUpdatedAt: "", model: "t", ...extra },
  ];
  const h = handoffSummary(tickets, new Map([out(1, "real_bug"), out(2, "knowledge_gap", { missingKnowledge: "IP is in the audit trail", kbCoverage: "not_covered" }), out(3, "account_action")]), now);
  check("all-time buckets", h.all, { total: 4, real_bug: 1, knowledge_gap: 1, other: 1, awaiting: 1 });
  check("recent excludes July", h.recent.total, 3);
  check("by kind (multi-route ticket counted in both)", h.byKind.map((k) => [k.kind, k.total]), [["dev_item", 1], ["slack", 2], ["chat", 2]]);
  check("gap list", h.gaps.map((g) => [g.ticketId, g.subject, g.kbCoverage]), [[2, "S2", "not_covered"]]);
  check("bugs + others lists", [h.bugs.map((b) => b.ticketId), h.others.map((o) => o.category)], [[1], ["account_action"]]);
}

// ── judge evidence: thread from the handoff on, Jetta's later notes excluded ──
{
  const text = handoffEvidence({
    ticket: { id: 7, subject: "Automations greyed out", status: 4 },
    description: "My GetSign automations are greyed out",
    thread: [
      msg({ user_id: 2, created_at: "2026-09-01T09:00:00Z", body_text: "BEFORE-HANDOFF reply" }),
      msg({ private: true, user_id: JETTA, created_at: "2026-09-01T10:00:00Z", body_text: "Escalated to dev team via Slack." }),
      msg({ private: true, user_id: JETTA, created_at: "2026-09-01T11:00:00Z", body_text: "Jetta — suggested reply (pending) DRAFT-TEXT" }),
      msg({ user_id: 3, created_at: "2026-09-02T10:00:00Z", body_text: "That's expected — set it up from the board view." }),
    ],
    jettaId: JETTA,
    agents: AGENTS,
    devItems: [{ id: "1", name: "Greyed out", group: "Done", devStatus: "Done", updates: [{ at: "2026-09-02T00:00:00Z", author: "Dev", text: "Not a bug", replies: [] }] }],
    kbCandidates: [{ title: "Board view setup", body: "Install the view first." }],
  });
  check("evidence: pre-handoff reply dropped", text.includes("BEFORE-HANDOFF"), false);
  check("evidence: Jetta's draft not treated as outcome", text.includes("DRAFT-TEXT"), false);
  check("evidence: agent reply after handoff kept", text.includes("[agent Solutions Team]: That's expected"), true);
  check("evidence: dev status + comment", text.includes("Dev Status: Done") && text.includes("Dev: Not a bug"), true);
  check("evidence: KB candidate included", text.includes("(1) Board view setup"), true);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
