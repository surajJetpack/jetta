/**
 * Deterministic tests for the /health AI read's guard rails (lib/health-insight.ts).
 *   npx tsx scripts/health-insight-test.ts
 *
 * No LLM, no storage — the model's output is hand-written here.
 */
import { buildEvidence, numbers, reconcileInsight, renderHealth } from "../lib/health-insight";
import { trend } from "../lib/grounded-insight";
import { buildHealth, drillRows, healthRows, type HealthTicket } from "../lib/support-health";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`);
}

const NOW = Date.parse("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3.6e6).toISOString();
const rec = (p: Partial<HealthTicket> = {}): HealthTicket => ({
  v: 2, id: 1, subject: "Help", status: 4, createdAt: hoursAgo(48), updatedAt: hoursAgo(24), source: 1,
  agentReplies: 1, customerMsgs: 1, firstReplyH: 2, firstReplyBy: "Cherryl", firstReplyWords: 50,
  firstReplyHasLink: false, resolvedH: 20, reopened: false, suggestions: [], fromChat: false, devWork: false,
  handoff: null, app: "getsign", topic: null, ...p,
});
const tickets = [
  rec({ id: 1, topic: "signer email" }),
  rec({ id: 2, firstReplyH: 30, reopened: true, topic: "signer email" }),
  rec({ id: 3, app: "vlookup", status: 6, lastPublicFrom: "customer", lastPublicAt: hoursAgo(30), subject: "Sync broke" }),
];
const h = buildHealth(tickets, new Map(), null, NOW);
const rows = healthRows(tickets, new Map(), NOW);
const evidence = buildEvidence(h, rows);

// ── The evidence menu ──
check("every entry's count = what its drill lists", evidence.every((e) => e.count === drillRows(rows, e.drill, NOW).length), true);
check("entries with nothing behind them are left out", evidence.some((e) => e.count === 0), false);
check("ids are E1..En in order", evidence.map((e) => e.id).slice(0, 3), ["E1", "E2", "E3"]);
const prompt = renderHealth(h, rows, evidence);
check("no agent name reaches the prompt", prompt.includes("Cherryl"), false);
check("the prompt carries the waiting customer's subject", prompt.includes("Sync broke"), true);

// ── Numbers ──
check("digits and decimals", numbers("94% within 24h, 2.0 h median"), ["94", "24", "2.0"]);
check("spelled-out counts count", numbers("two customers waiting"), ["2"]);
check("'a customer' is not a count", numbers("a customer is waiting"), []);

// ── Reconciling the model's output ──
const waiting = evidence.find((e) => e.drill.kind === "bucket")!;
const r = reconcileInsight(
  {
    headline: "Support is steady; 1 customer is waiting on us.",
    goingWell: [
      { text: "Fine point citing a real entry.", evidence: `[${evidence[0].id}]` }, // brackets stripped
      { text: "Cites an entry that does not exist.", evidence: "E999" },
      { text: "Cites nothing.", evidence: "" }, // not allowed outside actions
    ],
    watch: [
      { text: "1 customer waiting on us.", evidence: waiting.id },
      { text: "Reopens hit 57%, an invented figure.", evidence: evidence[0].id },
      { text: "Seventeen customers are angry.", evidence: evidence[0].id }, // 17 as a word, not in the data
    ],
    actions: [
      { text: "Write the missing article.", evidence: "" }, // actions may stand alone
      { text: "a", evidence: "" },
      { text: "b", evidence: "" },
      { text: "c", evidence: "" },
    ],
  },
  evidence,
  prompt,
);
check("valid citation kept, brackets stripped", r.goingWell.map((p) => p.evidence?.title), [evidence[0].title]);
check("watch: invented numbers dropped (digits and words)", r.watch.map((p) => p.text), ["1 customer waiting on us."]);
check("citation resolves to its drill", r.watch[0].evidence?.drill, waiting.drill);
check("actions may cite nothing; capped at 3", [r.actions.length, r.actions[0].evidence], [3, null]);
check("dropped count", r.dropped, 2 + 2 + 1);
check("headline with real numbers kept", r.headline, "Support is steady; 1 customer is waiting on us.");
const bad = reconcileInsight({ headline: "Reopens doubled to 44%.", goingWell: [], watch: [], actions: [] }, evidence, prompt);
check("headline with an invented number blanked", [bad.headline, bad.dropped], ["", 1]);

// ── "Going well" can't rest on a figure that got worse ──
check("trend: lower is better", [trend(1.9, 2.0, "lower"), trend(0.13, 0.11, "lower"), trend(5, 5, "higher"), trend(null, 1, "higher")], [" better", " worse", " unchanged", ""]);
{
  const ev = [{ ...evidence[0], id: "E1", worse: true }, { ...evidence[0], id: "E2", worse: false }];
  const out = reconcileInsight(
    {
      headline: "",
      goingWell: [{ text: "Worse figure called good.", evidence: "E1" }, { text: "Better figure called good.", evidence: "E2" }],
      watch: [{ text: "Worse figure worth watching.", evidence: "E1" }],
      actions: [],
    },
    ev,
    prompt,
  );
  check("going well citing a worsened figure is dropped", out.goingWell.map((p) => p.text), ["Better figure called good."]);
  check("…but it may still be worth watching", out.watch.length, 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
