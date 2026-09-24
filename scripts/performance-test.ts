/**
 * Deterministic tests for the /performance numbers (lib/performance.ts).
 *   npx tsx scripts/performance-test.ts
 *
 * No network, no storage — synthetic Freshdesk tickets and threads.
 */
import {
  buildSummary,
  chatWeeks,
  isJunkSubject,
  median,
  periodStats,
  suggestionBody,
  summarizeTicket,
  weekStart,
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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
