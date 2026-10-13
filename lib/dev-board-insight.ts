/**
 * The AI read on /dev-board — how client issues move between support and
 * engineering, and what keeps coming back.
 *
 * Same grounding as /health and /performance (lib/grounded-insight.ts): every
 * point cites one EVIDENCE entry, the click opens the items behind it, and the
 * reconciler drops a point that cites nothing real or states a number that
 * isn't in the data.
 *
 * Admin page, so people may be named — as a question about the items, the way
 * /performance coaches, never a ranking.
 */
import { generateObject } from "ai";
import { getModel, modelLabel } from "./llm";
import { insightSchema, reconcileInsight, trend, type Evidence, type Insight } from "./grounded-insight";
import {
  drillRows,
  FRICTION_LABEL,
  KIND_LABEL,
  STALE_DAYS,
  DORMANT_DAYS,
  type DevBoardSummary,
  type DevDrill,
  type DevRow,
  type Friction,
  type MinedKind,
} from "./dev-board";

export type DevEvidence = Evidence<DevDrill>;
export type DevBoardInsight = Insight<DevDrill>;

export const DevBoardInsightSchema = insightSchema(
  "One plain sentence: are client issues moving between support and engineering at a healthy pace, and the single biggest thing slowing them or coming back.",
  "0 to 3 things worth attention, most important first: items waiting longest and on whom, a problem area that keeps recurring, friction that keeps repeating (missing info, slow replies, fixes failing testing), lessons not yet in the knowledge base.",
);

/** Fewer answers than this and a person's median says nothing. */
const MIN_REPLIES = 5;

const SYSTEM = `You write a short read of the team's monday.com dev boards for the person who runs support. Support people and an AI agent (Jetta) file customer problems ("client issues") on the boards; engineering (developers, QA, leads) answers, fixes, and hands them back. Each item's conversation was also read to say what it turned out to be, why it happened, and what support could tell the next customer.

The reader wants to know: are client issues answered and resolved at a good pace, whose move are the open ones on, which problem areas keep recurring and why, what friction repeats, and which lessons should become help articles.

Rules:
1. Every point cites exactly one EVIDENCE entry by id (e.g. "E4"). The reader clicks it to see the items behind the point, so cite the entry the point is actually about.
2. Use only figures printed below, written the same way. Never invent, round, sum or derive a number. A point with a number not in the data is deleted.
2a. Write counts as digits.
3. Compare only against a prior figure that is given ("prior" = the 28 days before). For reply and resolve times, lower is better.
4. You may name a person when their items show a clear pattern, framed as a question about the items ("Sam's open client issues have mostly sat untouched for weeks: worth checking which are blocked"), never a judgement of the person. Never rank people; never use best, worst, top, slow or underperforming about a person. Ignore a reply median built on fewer than ${MIN_REPLIES} replies.
5. Recurring areas are the most useful thing on this page: name the app and the area, and the root cause when one is given.
6. Name the specific app (GetSign, VLOOKUP Auto-Link, TrackMy…), never "Jetpack Apps".
7. Plain language, no praise, no marketing tone. Empty sections beat padded ones.
8. No causal claims about people from timing alone: a long wait can be a hard bug.`;

const hrs = (v: number | null) => (v == null ? "n/a" : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);
const dys = (v: number | null) => (v == null ? "n/a" : `${v} days`);

export function buildDevEvidence(s: DevBoardSummary, rows: DevRow[]): DevEvidence[] {
  const out: DevEvidence[] = [];
  const add = (label: string, title: string, description: string, drill: DevDrill, worse = false) => {
    const count = drillRows(rows, drill, s.computedAt).length;
    if (!count) return;
    out.push({ id: `E${out.length + 1}`, label, count, title, description, drill, worse });
  };
  const r = s.recent, p = s.previous, n = s.now;
  const w = (a: number | null, b: number | null, better: "higher" | "lower") => trend(a, b, better) === " worse";

  add(`Client issues filed, last 28 days: ${r.filed} (${r.filedByJetta} by Jetta), prior ${p.filed}`,
    "Client issues filed", "Client issues filed in the last 28 days, newest first.", { kind: "filed" });
  add(`Resolved by engineering, last 28 days: ${r.resolved} (prior ${p.resolved}${trend(r.resolved, p.resolved, "higher") ? `, now${trend(r.resolved, p.resolved, "higher")}` : ""})`,
    "Resolved", "Client issues engineering finished in the last 28 days.", { kind: "resolved" }, w(r.resolved, p.resolved, "higher"));
  add(`Median first engineering response: ${hrs(r.firstEngH)} (prior ${hrs(p.firstEngH)}${trend(r.firstEngH, p.firstEngH, "lower") ? `, now${trend(r.firstEngH, p.firstEngH, "lower")}` : ""})`,
    "First engineering response", "Client issues filed in the last 28 days, slowest first response first.", { kind: "firstEng" }, w(r.firstEngH, p.firstEngH, "lower"));
  add(`Median filed-to-resolved: ${dys(r.cycleDays)} (prior ${dys(p.cycleDays)}${trend(r.cycleDays, p.cycleDays, "lower") ? `, now${trend(r.cycleDays, p.cycleDays, "lower")}` : ""})`,
    "Time to resolve", "Client issues resolved in the last 28 days, longest first.", { kind: "cycle" }, w(r.cycleDays, p.cycleDays, "lower"));
  add(`Fixes that failed testing or were reopened, last 28 days: ${r.bounced} items (prior ${p.bounced})`,
    "Fixes that came back", "Client issues whose fix failed testing or was reopened in the last 28 days.", { kind: "bounced" }, w(r.bounced, p.bounced, "lower"));
  add(`Support chasing engineering for an update, last 28 days: ${r.nudges} nudges (prior ${p.nudges})`,
    "Support chasing for updates", "Client issues where support asked engineering for an update in the last 28 days.", { kind: "nudges" }, w(r.nudges, p.nudges, "lower"));
  add(`Open client issues now: ${n.open}; ${n.stale} untouched ${STALE_DAYS}+ days; ${n.dormant} more untouched ${DORMANT_DAYS}+ days (dormant backlog, not counted as open)`,
    "Open client issues", "Open client issues, longest waiting first.", { kind: "open" });
  add(`Waiting on engineering: ${n.engineering}, median ${dys(n.engineeringWaitDays)}`,
    "Engineering's move", "Open client issues waiting on engineering, longest first.", { kind: "open", move: "engineering" });
  add(`Waiting on support: ${n.support}, median ${dys(n.supportWaitDays)}`,
    "Support's move", "Open client issues where engineering asked or handed back and support hasn't answered, longest first.", { kind: "open", move: "support" });
  add(`Waiting on the customer (Waiting Customer / Need more info): ${n.customer}`,
    "Waiting on the customer", "Open client issues waiting on the customer, longest first.", { kind: "open", move: "customer" });
  add(`Dormant: ${n.dormant} open client issues nobody has touched in ${DORMANT_DAYS}+ days`,
    "Dormant client issues", "Open client issues untouched for 90+ days — backlog to close or re-plan.", { kind: "dormant" });

  for (const d of s.developers.slice(0, 8)) {
    add(`Developer ${d.name}: ${d.openClient} open client issues (${d.open} open items in all, ${d.stale} untouched ${STALE_DAYS}+ days), ${d.resolvedClient} client issues resolved in 28 days, median reply to support ${hrs(d.replyH)} over ${d.replies} replies${d.replies < MIN_REPLIES ? " (too few to judge)" : ""}`,
      `${d.name} · open items`, "Open items assigned to this developer, longest waiting first.", { kind: "dev", person: d.name, metric: "open" });
  }
  for (const sp of s.supportTeam) {
    add(`Support ${sp.name}: filed ${sp.filed} in 28 days, median reply to engineering ${hrs(sp.replyH)} over ${sp.replies} replies${sp.replies < MIN_REPLIES ? " (too few to judge)" : ""}, ${sp.yourMove} open items on support's move, ${sp.nudges} nudges sent`,
      `${sp.name} · items on support's move`, "Open client issues this person is on that wait for support.", { kind: "support", person: sp.name, metric: "yourMove" });
  }
  for (const pt of s.patterns.slice(0, 8)) {
    add(`Recurring area ${pt.app} / "${pt.area}": ${pt.recent} client issues in the last 28 days, ${pt.prior} the 28 before, ${pt.total} in 120 days${pt.causes.length ? `; causes given: ${pt.causes.map((c) => `"${c}"`).join("; ")}` : ""}`,
      `${pt.app} · ${pt.area}`, "Client issues in this area, newest first.", { kind: "pattern", app: pt.app, area: pt.area });
  }
  for (const [k, v] of Object.entries(s.mined.kinds) as [MinedKind, number][]) {
    add(`Conversations read: ${v} turned out to be "${KIND_LABEL[k]}"`, KIND_LABEL[k], "Client issues whose conversation ended this way.", { kind: "mined", mined: k });
  }
  for (const [f, v] of Object.entries(s.mined.friction) as [Friction, number][]) {
    add(`Friction seen in ${v} conversations: ${FRICTION_LABEL[f]}`, FRICTION_LABEL[f], "Client issues whose conversation showed this.", { kind: "friction", friction: f });
  }
  add(`Lessons worth a help article: ${s.mined.lessons}; ${s.mined.lessonsNotInKb} not in the KB and no draft yet`,
    "Lessons not in the KB", "Lessons from dev conversations with no matching article or draft.", { kind: "mined", mined: "lessonsNotInKb" });
  return out;
}

export function renderDevBoard(s: DevBoardSummary, rows: DevRow[], evidence: DevEvidence[]): string {
  const lessons = drillRows(rows, { kind: "mined", mined: "lessonsNotInKb" }, s.computedAt)
    .slice(0, 6)
    .map((r) => `  - ${r.app}: "${r.kbTitle ?? r.lesson}"`);
  const waiting = drillRows(rows, { kind: "open", move: "engineering" }, s.computedAt)
    .slice(0, 5)
    .map((r) => `  - ${r.app}: ${r.name} (status ${r.status ?? "blank"})`);
  return [
    "EVIDENCE (cite by id; the count is how many items a click lists):",
    ...evidence.map((e) => `[${e.id}] ${e.label} — ${e.count} items behind it`),
    "",
    "LESSONS NOT YET IN THE KB (article titles to write — context, cite the lessons entry):",
    ...(lessons.length ? lessons : ["  (none)"]),
    "",
    "LONGEST WAITING ON ENGINEERING (subjects only — not counts):",
    ...(waiting.length ? waiting : ["  (none)"]),
    s.mined.pending ? `\nNote: ${s.mined.pending} conversations are still queued to be read; the kinds and patterns are partial.` : "",
  ].join("\n");
}

export async function generateDevBoardInsight(s: DevBoardSummary, rows: DevRow[]): Promise<DevBoardInsight> {
  const evidence = buildDevEvidence(s, rows);
  const prompt = renderDevBoard(s, rows, evidence);
  const { object } = await generateObject({
    model: getModel("standard"),
    schema: DevBoardInsightSchema,
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
