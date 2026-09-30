/**
 * Deterministic tests for the /performance AI read's evidence (lib/performance-insight.ts).
 *   npx tsx scripts/performance-insight-test.ts
 *
 * No LLM, no storage. The reconciler itself is covered by health-insight-test.ts.
 */
import { buildSummary, perfDrillRows, perfRows, type HandoffOutcome, type PerfTicket } from "../lib/performance";
import { buildPerfEvidence, renderPerformance } from "../lib/performance-insight";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`);
}

const NOW = Date.parse("2026-09-28T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3.6e6).toISOString();
const t = (p: Partial<PerfTicket>): PerfTicket => ({
  v: 2, id: 1, subject: "Help", status: 4, createdAt: ago(48), updatedAt: ago(24), source: 1,
  agentReplies: 1, customerMsgs: 1, firstReplyH: 2, firstReplyBy: "Cherryl", firstReplyWords: 50,
  firstReplyHasLink: false, resolvedH: 20, reopened: false, suggestions: [], fromChat: false, devWork: false,
  handoff: null, ...p,
});
const sug = (sim: number | null, replyBy = "Cherryl") => ({ at: ago(47), sim, replyBy, waitH: 1 });
const tickets = [
  t({ id: 1, suggestions: [sug(0.95), sug(0.1)], reopened: true }),
  t({ id: 2, suggestions: [sug(0.1, "Dana")], firstReplyBy: "Dana" }),
  t({ id: 3, handoff: { kinds: ["slack"], at: ago(40), itemIds: [] }, subject: "Where is the export?" }),
  // prior window: no reopens, so the recent reopen rate is worse
  t({ id: 4, createdAt: ago(24 * 40) }),
];
const outcomes = new Map<number, HandoffOutcome>([
  [3, { ticketId: 3, category: "knowledge_gap", confidence: "high", evidence: "", missingKnowledge: "Exports live under Settings", kbArticleTitle: "Exporting your data", kbCoverage: "not_covered", kbArticle: "Getting started", judgedAt: 0, basisUpdatedAt: "", model: "" }],
]);
const s = buildSummary(tickets, NOW, null, outcomes);
const rows = perfRows(tickets, outcomes, NOW);
const ev = buildPerfEvidence(s, rows);

check("every entry's count = what its drill lists", ev.every((e) => e.count === perfDrillRows(rows, e.drill, NOW).length), true);
check("no empty entries", ev.some((e) => !e.count), false);
check("reopens rose vs prior → marked worse", ev.find((e) => e.drill.kind === "reopened")?.worse, true);
check("agent with < 5 judged drafts flagged too few", ev.some((e) => e.label.startsWith("Agent Dana: replied after 1") && e.label.includes("too few to judge")), true);
check("agents are named (admin page)", ev.some((e) => e.label.includes("Cherryl")), true);
const prompt = renderPerformance(s, rows, ev);
check("gap names the article to write", prompt.includes('article to WRITE (does not exist yet): "Exporting your data"'), true);
check("gap names the closest existing article", prompt.includes('closest EXISTING article: "Getting started"'), true);
check("unused-draft examples listed", prompt.includes("EXAMPLES of tickets whose drafts went unused"), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
