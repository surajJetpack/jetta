/**
 * The AI read on /performance — is Jetta helping? — for whoever runs her.
 *
 * Same grounding as /health (lib/grounded-insight.ts): the model narrates the
 * page's own payload, cites one EVIDENCE entry per point, and the reconciler
 * drops anything citing an entry that doesn't exist or stating a number that
 * isn't in the data.
 *
 * Admin page, so agents may be named — suraj chose coaching over team-level
 * only (2026-09-30). The rules keep it coaching: a question about the drafts
 * on that agent's tickets, never a ranking of people.
 */
import { generateObject } from "ai";
import { getModel, modelLabel } from "./llm";
import {
  JETTA_LIVE_DATE,
  perfDrillRows,
  weekStart,
  type PerfDrill,
  type PerfRow,
  type PerformanceSummary,
} from "./performance";
import { insightSchema, reconcileInsight, trend, type Evidence, type Insight } from "./grounded-insight";

export type PerfEvidence = Evidence<PerfDrill>;
export type PerformanceInsight = Insight<PerfDrill>;

export const PerformanceInsightSchema = insightSchema(
  "One plain sentence: is Jetta pulling her weight in support right now, and the single biggest reason why or why not.",
  "0 to 3 things worth attention, most important first: drafts going unused, handoffs that were really knowledge gaps, reply speed or reopens moving the wrong way.",
);

/** Fewer judged drafts than this, and an agent's use rate says nothing. */
const MIN_DRAFTS_FOR_A_RATE = 5;

const SYSTEM = `You write a short read of how an AI support assistant, Jetta, is doing, for the person who runs her. Jetta reads every support ticket and posts a suggested reply as a private note; a human agent reviews it and sends the actual reply. She also hands some tickets to people: a dev-board item, a Slack escalation, or a live chat she couldn't finish. A review judged each handoff afterwards: a real bug needed a developer; a knowledge gap only needed a fact she didn't have, which a knowledge-base article fixes.

The reader wants to know: are her drafts being used, where they are not and why that might be, which handoffs were avoidable and what article would have avoided them, and how reply speed and quality moved since she went live (${JETTA_LIVE_DATE}).

Rules:
1. Every point cites exactly one EVIDENCE entry by its id (e.g. "E4"). The reader clicks it to see the tickets behind the point, so the entry must be the number the point is actually about.
2. Use only figures that appear in the data below, written the same way. Never invent, round, or derive a number that is not printed below — no new percentages, sums or differences. A point with a number that is not in the data is deleted before anyone sees it.
2a. Write every count as digits ("12 drafts", never "twelve drafts").
3. Compare only against a prior figure that is actually given: "prior" is the 28 days before; "before Jetta" is everything before ${JETTA_LIVE_DATE}. State direction correctly; for reply times and reopens, lower is better.
4. "Drafts used" compares text: an agent who sends the same answer in their own words counts as "not used". Say "unused" is a signal to read the drafts, not proof they were wrong.
5. COACHING. You may name an agent, and should when one agent's pattern differs clearly from the rest — but frame it as a question about the drafts on their tickets ("Solutions Team built on 1 of 9 drafts: worth reading which of their tickets the drafts miss"), never as a judgement of the person. Never rank agents against each other and never use words like best, worst, top or underperforming. Do not draw a conclusion from an agent with fewer than ${MIN_DRAFTS_FOR_A_RATE} judged drafts.
6. Knowledge gaps are the most actionable thing on this page. When the KNOWLEDGE GAPS block names an article that would have let Jetta answer, recommend writing it by that title; when it says the KB already covers it, the problem is that Jetta or customers are not finding it — say that instead.
7. Name the specific app (GetSign, VLOOKUP Auto-Link, TrackMy…), never "Jetpack Apps".
8. Plain language, no praise of Jetta or the team, no marketing tone. A good month is a fine answer; empty sections beat padded ones.
9. No causal claims about team numbers. Reply time, reopens and links are shaped by the agents, the ticket mix and Jetta together; the data cannot say which. Write "reopens are 13%, down from 32% before Jetta", never "Jetta kept reopens low" or "Jetta's drafts cut reply time". Only draft use, coverage and handoffs are Jetta's own numbers.
10. Check a number against its target and its prior before calling it good: a figure that rose or sits above a target is not "going well" just because it beats the before-Jetta baseline. Say all three when they disagree. Targets: reopens under 10%.`;

const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) => (v == null ? "n/a" : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);
const weekLabel = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** Every number the model may cite, each with the drill that opens it. Counts are what the click lists. */
export function buildPerfEvidence(s: PerformanceSummary, rows: PerfRow[]): PerfEvidence[] {
  const out: PerfEvidence[] = [];
  const add = (label: string, title: string, description: string, drill: PerfDrill, worse = false) => {
    const count = perfDrillRows(rows, drill, s.computedAt).length;
    if (!count) return;
    out.push({ id: `E${out.length + 1}`, label, count, title, description, drill, worse });
  };
  const worse = (now: number | null, prior: number | null, better: "higher" | "lower") => trend(now, prior, better) === " worse";
  const r = s.recent, p = s.previous, b = s.baseline;
  /** "prior: 40% (now worse), before Jetta: 15% (now better)" */
  const vs = (now: number | null, prior: number | null, base: number | null, f: (v: number | null) => string, better: "higher" | "lower") =>
    `prior: ${f(prior)}${prior != null ? ` (now${trend(now, prior, better)})` : ""}` +
    (base !== undefined ? `, before Jetta: ${f(base)}${base != null ? ` (now${trend(now, base, better)})` : ""}` : "");
  add(`Jetta drafted on ${pct(r.coverage)} of ${r.answered} answered tickets, last 28 days (prior: ${pct(p.coverage)} (now${trend(r.coverage, p.coverage, "higher")}))`,
    "Jetta drafted on", "Tickets from the last 28 days an agent answered, the ones without a Jetta draft first.", { kind: "coverage" }, worse(r.coverage, p.coverage, "higher"));
  add(`Drafts used (as-is or edited): ${pct(r.usedRate)} of ${r.judged} judged drafts (prior: ${pct(p.usedRate)} (now${trend(r.usedRate, p.usedRate, "higher")})); ${r.asIs} as-is, ${r.edited} edited, ${r.notUsed} not used; a draft waited a median ${hrs(r.draftWaitH)} for an agent`,
    "Drafts used", "Tickets from the last 28 days with a draft an agent replied after, unused drafts first.", { kind: "used" }, worse(r.usedRate, p.usedRate, "higher"));
  add(`Median first reply: ${hrs(r.firstReplyH)} (${vs(r.firstReplyH, p.firstReplyH, b.firstReplyH, hrs, "lower")})`,
    "First reply times", "Answered tickets from the last 28 days, slowest first, with who sent the first reply.", { kind: "firstReply" }, worse(r.firstReplyH, p.firstReplyH, "lower"));
  add(`First reply links a doc: ${pct(r.linkRate)} (${vs(r.linkRate, p.linkRate, b.linkRate, pct, "higher")})`,
    "First reply links a doc", "Answered tickets from the last 28 days, the ones whose first reply linked a doc first.", { kind: "link" }, worse(r.linkRate, p.linkRate, "higher"));
  add(`Reopened: ${pct(r.reopenRate)} of answered (${vs(r.reopenRate, p.reopenRate, b.reopenRate, pct, "lower")}; target under 10%)`,
    "Reopened tickets", "Answered tickets from the last 28 days the customer came back on after they were resolved.", { kind: "reopened" }, worse(r.reopenRate, p.reopenRate, "lower"));

  const thisWeek = weekStart(new Date(s.computedAt).toISOString());
  for (const w of s.weeks.filter((x) => x.week >= weekStart(`${JETTA_LIVE_DATE}T00:00:00Z`) && x.week !== thisWeek).slice(-6)) {
    add(`Week of ${weekLabel(w.week)}: ${w.answered} answered, drafts ${w.asIs} as-is / ${w.edited} edited / ${w.notUsed} not used, median first reply ${hrs(w.firstReplyH)}`,
      `Drafts · week of ${weekLabel(w.week)}`, "This week's tickets with a draft an agent replied after, unused drafts first.",
      { kind: "week", week: w.week, metric: "drafts" });
  }

  for (const a of s.agents.slice(0, 8)) {
    add(`Agent ${a.agent}: ${a.firstReplies} first replies, median ${hrs(a.firstReplyH)}`, `${a.agent} · first replies`,
      "Tickets from the last 28 days where this agent sent the first reply, slowest first.",
      { kind: "agent", agent: a.agent, metric: "firstReplies" });
    add(`Agent ${a.agent}: replied after ${a.afterSuggestion} Jetta drafts, built on ${pct(a.usedRate)} of them${a.afterSuggestion < MIN_DRAFTS_FOR_A_RATE ? " (too few to judge)" : ""}`,
      `${a.agent} · replies after a Jetta draft`, "Tickets from the last 28 days where this agent replied after a Jetta draft, unused drafts first.",
      { kind: "agent", agent: a.agent, metric: "afterSuggestion" });
  }

  const h = s.handoffs;
  if (h) {
    const hr = h.recent;
    const judged = hr.total - hr.awaiting;
    add(`Handed to people, last 28 days: ${hr.total} (${h.all.total} since Jetta went live); ${judged} judged so far`,
      "Handed off, last 28 days", "Every ticket Jetta passed to people in the last 28 days, newest first.",
      { kind: "handoffs", bucket: "total", scope: "recent" });
    add(`Handoffs judged real bugs, last 28 days: ${hr.real_bug} of ${judged} judged`, "Real bugs",
      "Handoffs in the last 28 days that needed a developer.", { kind: "handoffs", bucket: "real_bug", scope: "recent" });
    add(`Handoffs judged knowledge gaps, last 28 days: ${hr.knowledge_gap} of ${judged} judged`, "Knowledge gaps",
      "Handoffs in the last 28 days that only needed a fact Jetta didn't have.", { kind: "handoffs", bucket: "knowledge_gap", scope: "recent" });
    add(`Handoffs judged something else (feature request, account work, platform), last 28 days: ${hr.other}`, "Other handoffs",
      "Feature requests, account work and platform issues from the last 28 days.", { kind: "handoffs", bucket: "other", scope: "recent" });
    for (const k of h.byKind) {
      add(`Route ${k.kind === "dev_item" ? "dev item" : k.kind === "slack" ? "Slack escalation" : "live chat she couldn't finish"}, since launch: ${k.total} handoffs, ${k.real_bug} real bugs, ${k.knowledge_gap} knowledge gaps`,
        `Handoffs by ${k.kind === "dev_item" ? "dev item" : k.kind === "slack" ? "Slack" : "live chat"}`,
        "Handoffs by this route since Jetta went live, newest first.",
        { kind: "handoffs", bucket: "total", scope: "all", route: k.kind });
    }
  }
  return out;
}

/** The prompt body: the evidence menu, the knowledge-gap work list, and a few subjects for concreteness. */
export function renderPerformance(s: PerformanceSummary, rows: PerfRow[], evidence: PerfEvidence[]): string {
  const gaps = (s.handoffs?.gaps ?? []).slice(0, 8).map((g) =>
    `  - "${g.subject}": needed "${g.missingKnowledge}"; article to WRITE (does not exist yet): ${g.kbArticleTitle ? `"${g.kbArticleTitle}"` : "none"}; KB ${g.kbCoverage === "covered" ? "already covers it" : g.kbCoverage === "partly_covered" ? "partly covers it" : "does not cover it"}${g.kbArticle ? `; closest EXISTING article: "${g.kbArticle}"` : ""}`,
  );
  const unused = perfDrillRows(rows, { kind: "used" }, s.computedAt)
    .filter((r) => r.uses.every((u) => !u.use || u.use === "not_used"))
    .slice(0, 5)
    .map((r) => `  - ${r.subject}`);
  const chat = (s.chat?.weeks ?? []).slice(-4).map((w) => `Week of ${weekLabel(w.week)}: ${w.real} real chats, ${w.alone} finished by Jetta alone`);
  return [
    "EVIDENCE (cite by id; the count is how many tickets a click on it lists):",
    ...evidence.map((e) => `[${e.id}] ${e.label} — ${e.count} tickets behind it`),
    "",
    "KNOWLEDGE GAPS, newest first (what Jetta needed to know to answer these herself):",
    ...(gaps.length ? gaps : ["  (none judged yet)"]),
    "",
    "EXAMPLES of tickets whose drafts went unused (subjects only — not counts):",
    ...(unused.length ? unused : ["  (none)"]),
    ...(chat.length ? ["", "LIVE CHAT (context only, no evidence id):", ...chat.map((c) => `  ${c}`)] : []),
  ].join("\n");
}

/** Write the read. Throws on LLM failure — the route turns that into "try again". */
export async function generatePerformanceInsight(s: PerformanceSummary, rows: PerfRow[]): Promise<PerformanceInsight> {
  const evidence = buildPerfEvidence(s, rows);
  const prompt = renderPerformance(s, rows, evidence);
  const { object } = await generateObject({
    // Standard tier, as on /health: cached against computedAt, so at most once per sync.
    model: getModel("standard"),
    schema: PerformanceInsightSchema,
    system: SYSTEM,
    prompt: `${prompt}\n\nWrite the read.`,
  });
  return {
    ...reconcileInsight(object, evidence, `${SYSTEM}\n${prompt}`),
    basedOn: s.computedAt,
    generatedAt: Date.now(),
    model: modelLabel("standard"),
  };
}
