/**
 * The AI read on /health — support health in words, for the business owner.
 *
 * It narrates the exact payload the page renders (lib/support-health.ts), so
 * the words and the numbers can never disagree, and every point it makes
 * cites one entry from an EVIDENCE list built here: a number on the page and
 * the drill-down that opens the tickets behind it. The page renders each
 * point with that list one click away. Nothing the model says is taken on
 * trust — see reconcileInsight().
 *
 * Team-level only, like the page: no agent names reach the prompt.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, modelLabel } from "./llm";
import { appName } from "./types";
import {
  TARGETS,
  drillRows,
  type Drill,
  type HealthRow,
  type SupportHealth,
} from "./support-health";

/** A number on the page, and the tickets behind it. `title`/`description` are what the drill sheet shows. */
export interface HealthEvidence {
  id: string;
  label: string;
  count: number;
  title: string;
  description: string;
  drill: Drill;
}

export interface HealthInsightPoint {
  text: string;
  /** The drill this point opens. Null only for an action that stands on no single number. */
  evidence: Pick<HealthEvidence, "title" | "description" | "drill" | "count"> | null;
}

export interface HealthInsight {
  headline: string;
  goingWell: HealthInsightPoint[];
  watch: HealthInsightPoint[];
  actions: HealthInsightPoint[];
  /** The payload's computedAt this was written from — the cache key. */
  basedOn: number;
  generatedAt: number;
  model: string;
  /** Points the reconciler dropped (bad citation or a number not in the data). Logged, never shown. */
  dropped: number;
}

// NB: no array min/max — the structured-output backends reject minItems/maxItems
// other than 0/1. Counts are steered by the descriptions and bounded after.
const Point = z.object({
  text: z.string().describe("One short plain sentence. Use the exact figures from the data. No emoji."),
  evidence: z
    .string()
    .describe('The id of the ONE evidence entry this point rests on, e.g. "E4" — from the EVIDENCE block, without brackets.'),
});

export const HealthInsightSchema = z.object({
  headline: z
    .string()
    .describe("One plain sentence: is support in good shape right now, and the single biggest reason why or why not."),
  goingWell: z.array(Point).describe("0 to 3 things that are genuinely going well, biggest first. Empty if nothing is."),
  watch: z
    .array(Point)
    .describe("0 to 3 things worth the owner's attention, most serious first: slipping speed, customers waiting, an app or topic driving pain."),
  actions: z
    .array(Point)
    .describe('0 to 3 concrete next steps a support lead could take this week. evidence may be "" when an action rests on no single number.'),
});

const SYSTEM = `You write a short read of a customer-support operation for the business owner the support team reports to. They are not a support person. They want to know: is support in good shape, what changed versus last month, what should worry them, and which app is driving it.

Rules:
1. Every point cites exactly one EVIDENCE entry by its id (e.g. "E4"). The reader clicks it to see the tickets behind the point, so the entry must be the number the point is actually about.
2. Use only figures that appear in the data below, written the same way (93%, 2.0 h, 81.5 days). Never invent, round, or derive a number that is not printed below — no new percentages, no sums, no differences you computed. A point with a number that is not in the data is deleted before anyone sees it.
2a. Write every count as digits ("2 customers", never "two customers").
3. Compare only against a prior figure that is actually given. The headline numbers come with the prior 28 days; use them. State direction correctly: a smaller number is a fall, a larger one is a rise; for reply times and reopens, lower is better. When a number still meets its target but got worse than the prior 28 days, say both — "94% answered within 24h, above the 90% target but down from 98%" — and don't list it as going well without the fall.
4. Name the specific app (GetSign, VLOOKUP Auto-Link, TrackMy…). Never say "Jetpack Apps" — it is a portfolio of separate apps. "Unattributed" means the app is not known; do not treat it as an app with problems of its own.
5. No agent names — this is a team-level read. Jetta is the AI assistant that drafts replies; mention her at most once, and only if the load numbers matter to the point.
6. Plain language, no praise, no marketing tone, no hedging filler. A good month is a fine answer; do not invent drama. Empty sections are better than padded ones.
7. Hours are calendar hours, weekends included. Targets: first reply within ${TARGETS.firstReplyH}h for ${Math.round(TARGETS.firstReplyShare.good * 100)}% of tickets, median first reply under ${TARGETS.medianFirstReplyH.good}h, reopens under ${Math.round(TARGETS.reopenRate.good * 100)}%.
8. "Sent to engineering" counts dev items and escalations — the team sent them, which is not the same as needing a developer. The by-app "real bugs" and "knowledge gaps" columns say which they turned out to be.
9. There is no satisfaction score on this Freshdesk plan. Do not mention CSAT.`;

const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) =>
  v == null ? "n/a" : v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} days`;
const weekLabel = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Every number the model may cite, each with the drill that opens it. Counts
 * come from drillRows — the same selection the sheet will show — so "E4: 6
 * tickets" is exactly what a click on E4 lists.
 */
export function buildEvidence(h: SupportHealth, rows: HealthRow[]): HealthEvidence[] {
  const out: HealthEvidence[] = [];
  const add = (label: string, title: string, description: string, drill: Drill) => {
    const count = drillRows(rows, drill, h.computedAt).length;
    if (!count) return;
    out.push({ id: `E${out.length + 1}`, label, count, title, description, drill });
  };
  const r = h.recent;
  add(`Tickets, last 28 days: ${r.tickets} (prior 28 days: ${h.previous.tickets})`, "Tickets, last 28 days",
    "Every ticket that arrived in the last 28 days and that a person answered or is still open.", { kind: "tickets" });
  add(`Answered within ${TARGETS.firstReplyH}h: ${pct(r.withinTarget)} (prior: ${pct(h.previous.withinTarget)})`,
    `Answered within ${TARGETS.firstReplyH}h`, "Tickets from the last 28 days, misses first.",
    { kind: "within", hours: TARGETS.firstReplyH });
  add(`Answered within ${TARGETS.fastReplyH}h: ${pct(r.withinFast)} (prior: ${pct(h.previous.withinFast)})`,
    `Answered within ${TARGETS.fastReplyH}h`, "Tickets from the last 28 days, misses first.",
    { kind: "within", hours: TARGETS.fastReplyH });
  add(`Median first reply: ${hrs(r.firstReplyH)} (prior: ${hrs(h.previous.firstReplyH)}); slowest 10% over ${hrs(r.firstReplyP90H)}`,
    "First reply times", "Answered tickets from the last 28 days, slowest first.", { kind: "firstReply" });
  add(`Reopened: ${pct(r.reopenRate)} of answered (prior: ${pct(h.previous.reopenRate)})`, "Reopened tickets",
    "Answered tickets from the last 28 days the customer came back on after they were resolved.", { kind: "reopened" });
  add(`Median time to resolve: ${hrs(r.resolvedH)} (prior: ${hrs(h.previous.resolvedH)})`, "Time to resolve",
    "Answered tickets from the last 28 days that have been resolved, longest first.", { kind: "resolved" });
  add(`Customer messages per ticket: ${r.customerMsgsPerTicket?.toFixed(1) ?? "n/a"} (prior: ${h.previous.customerMsgsPerTicket?.toFixed(1) ?? "n/a"})`,
    "Back-and-forth", "Answered tickets from the last 28 days, most customer messages first.", { kind: "backAndForth" });
  add(`Sent to engineering: ${pct(r.engineeringRate)} (prior: ${pct(h.previous.engineeringRate)})`, "Sent to engineering",
    "Tickets from the last 28 days that got a dev-board item or a Slack escalation.", { kind: "engineering" });
  const b = h.backlog;
  add(`Waiting on us right now: ${b.owesReply} (${b.overdue} over ${TARGETS.firstReplyH}h, longest ${hrs(b.oldestOwedH)})`,
    "Customers waiting on us", "Open tickets where the customer wrote the newest message, longest wait first.",
    { kind: "bucket", bucket: "owes_reply" });
  add(`With engineering right now: ${b.engineering}`, "With engineering", "Open tickets where status is Escalated to dev.",
    { kind: "bucket", bucket: "engineering" });
  add(`Waiting on the customer right now: ${b.customer}`, "Waiting on the customer",
    "Open tickets where we wrote the newest message.", { kind: "bucket", bucket: "customer" });
  add(`Tickets with a Jetta draft: ${h.load.ticketsDrafted} of ${r.tickets}`, "Tickets with a Jetta draft",
    "Tickets from the last 28 days where Jetta suggested at least one reply for an agent to review.", { kind: "drafted" });

  for (const a of h.apps.slice(0, 8)) {
    const name = appName(a.app);
    add(`${name}: ${a.tickets} tickets (prior ${a.previous}), median first reply ${hrs(a.firstReplyH)}, reopened ${pct(a.reopenRate)}`,
      `${name} · tickets`, "Tickets from the last 28 days.", { kind: "app", app: a.app, metric: "tickets" });
    if (a.owesReply)
      add(`${name}: ${a.owesReply} waiting on us now (${a.open} open)`, `${name} · waiting on us`,
        "Open tickets where the customer wrote the newest message.", { kind: "app", app: a.app, metric: "owesReply" });
    if (a.bugs)
      add(`${name}: ${a.bugs} handoffs judged real bugs`, `${name} · real bugs`,
        "Handoffs in the last 28 days the review judged a real product bug.", { kind: "app", app: a.app, metric: "bugs" });
    if (a.gaps)
      add(`${name}: ${a.gaps} handoffs judged knowledge gaps`, `${name} · knowledge gaps`,
        "Handoffs in the last 28 days that only needed an answer Jetta didn't have.", { kind: "app", app: a.app, metric: "gaps" });
  }
  for (const t of h.topics.slice(0, 6)) {
    add(`Theme "${t.topic}": ${t.count} tickets (prior 28 days: ${t.previous})${t.apps.length ? `, apps: ${t.apps.map(appName).join(", ")}` : ""}`,
      t.topic.charAt(0).toUpperCase() + t.topic.slice(1), "Tickets from the last 28 days Jetta labelled with this theme.",
      { kind: "topic", topic: t.topic });
  }
  for (const w of h.weeks.filter((x) => !x.partial).slice(-6)) {
    add(`Week of ${weekLabel(w.week)}: ${w.tickets} tickets, ${pct(w.withinTarget)} answered within ${TARGETS.firstReplyH}h, median first reply ${hrs(w.firstReplyH)}`,
      `Tickets · week of ${weekLabel(w.week)}`, "Tickets that arrived this week and that a person answered or is still open.",
      { kind: "week", week: w.week, metric: "tickets" });
  }
  return out;
}

/** The prompt body: the evidence menu, plus a few ticket subjects so points can be concrete. */
export function renderHealth(h: SupportHealth, rows: HealthRow[], evidence: HealthEvidence[]): string {
  const subjects = (d: Drill, n: number) =>
    drillRows(rows, d, h.computedAt)
      .slice(0, n)
      .map((r) => `    - ${appName(r.app)}: ${r.subject}`)
      .join("\n");
  return [
    "EVIDENCE (cite by id; the count is how many tickets a click on it lists):",
    ...evidence.map((e) => `[${e.id}] ${e.label} — ${e.count} tickets behind it`),
    "",
    h.chat ? `Live chats, last 28 days: ${h.chat.recent.real} (prior: ${h.chat.previous.real}); ${h.chat.recent.alone} finished by Jetta with no ticket and no person.` : "",
    "",
    "EXAMPLES (subjects only, for concreteness — not counts):",
    "  Longest-waiting customers:",
    subjects({ kind: "bucket", bucket: "owes_reply" }, 5) || "    (none)",
    `  Missed the ${TARGETS.firstReplyH}h first reply:`,
    subjects({ kind: "within", hours: TARGETS.firstReplyH }, 5) || "    (none)",
    "  Reopened:",
    subjects({ kind: "reopened" }, 5) || "    (none)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
};
/**
 * Numbers as written in text: 93, 2.0, 81.5 — "93%" and "2.0 h" contribute 93
 * and 2.0. Spelled-out counts count too ("two customers" is 2): the prompt
 * asks for digits, and a word is how a wrong count would slip past the check.
 * "a/an/single" are left alone — "a customer" is not a claim of exactly 1.
 */
export function numbers(s: string): string[] {
  const digits = s.match(/\d+(?:\.\d+)?/g) ?? [];
  const words = (s.toLowerCase().match(/\b[a-z]+\b/g) ?? []).filter((w) => w in WORDS).map((w) => WORDS[w]);
  return [...digits, ...words];
}

/**
 * Force the model's output back onto the data. A point is dropped when it
 * cites an evidence id that does not exist, or states a number that appears
 * nowhere in what the model was shown — the one mistake that would be believed
 * and repeated. Actions may cite nothing. Each list keeps its first three.
 */
export function reconcileInsight(
  raw: z.infer<typeof HealthInsightSchema>,
  evidence: HealthEvidence[],
  prompt: string,
): Pick<HealthInsight, "headline" | "goingWell" | "watch" | "actions" | "dropped"> {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const known = new Set(numbers(prompt));
  let dropped = 0;
  const fix = (points: { text: string; evidence: string }[], mayStandAlone: boolean) => {
    const out: HealthInsightPoint[] = [];
    for (const p of points) {
      const text = p.text?.trim();
      const id = (p.evidence ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
      const e = id ? byId.get(id) : undefined;
      const inventedNumber = numbers(text ?? "").some((n) => !known.has(n));
      if (!text || (id && !e) || (!e && !mayStandAlone) || inventedNumber) {
        dropped++;
        continue;
      }
      out.push({ text, evidence: e ? { title: e.title, description: e.description, drill: e.drill, count: e.count } : null });
    }
    dropped += Math.max(0, out.length - 3);
    return out.slice(0, 3);
  };
  const headline = raw.headline?.trim() ?? "";
  // A headline with an invented number is replaced, not shown.
  const badHeadline = numbers(headline).some((n) => !known.has(n));
  return {
    headline: badHeadline || !headline ? "" : headline,
    goingWell: fix(raw.goingWell ?? [], false),
    watch: fix(raw.watch ?? [], false),
    actions: fix(raw.actions ?? [], true),
    dropped: dropped + (badHeadline ? 1 : 0),
  };
}

/** Write the read. Throws on LLM failure — the route turns that into "try again". */
export async function generateHealthInsight(h: SupportHealth, rows: HealthRow[]): Promise<HealthInsight> {
  const evidence = buildEvidence(h, rows);
  const prompt = renderHealth(h, rows, evidence);
  const { object } = await generateObject({
    // Standard tier: this is read by the person the team reports to, and it
    // runs at most once per hourly sync (cached against computedAt).
    model: getModel("standard"),
    schema: HealthInsightSchema,
    system: SYSTEM,
    prompt: `${prompt}\n\nWrite the read.`,
  });
  return {
    ...reconcileInsight(object, evidence, `${SYSTEM}\n${prompt}`),
    basedOn: h.computedAt,
    generatedAt: Date.now(),
    model: modelLabel("standard"),
  };
}
