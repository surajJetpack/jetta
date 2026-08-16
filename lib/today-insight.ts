/**
 * The AI read on the morning brief (/today).
 *
 * Deliberately NOT the same thing as lib/daily-insight.ts. That one writes a
 * daily operations digest for whoever owns the system — yesterday, closed out,
 * with cost and model spend in it. This one is written for a support person
 * opening the console at the start of their shift: what happened overnight,
 * what is on fire, and what to pick up first. No cost, no models, no tokens.
 *
 * It narrates the exact payload the page renders (lib/today.ts), so the words
 * and the numbers on screen can never disagree.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, modelLabel } from "./llm";
import { appName } from "./types";
import { displayTopic } from "./topics";
import type { TodayBrief } from "./today";
import type { DailyRollup } from "./kv";

// NB: no array min/max — the light tier's structured-output backend rejects
// minItems/maxItems other than 0/1. Counts are steered by the descriptions.
export const TodayInsightSchema = z.object({
  headline: z
    .string()
    .describe(
      "One plain sentence leading with how many people are waiting and the most urgent one. Arrival volume is not the headline. No emoji, no greeting.",
    ),
  ranking: z
    .array(
      z.object({
        id: z
          .string()
          .describe(
            'The id from inside the square brackets in the WORKLIST block, WITHOUT the brackets — for "[13945]" return "13945".',
          ),
        why: z
          .string()
          .describe(
            "One short clause saying why it sits here — what makes it more or less urgent than its neighbours. Not a restatement of the subject.",
          ),
      }),
    )
    .describe(
      "Every worklist item, most urgent first. Include all of them exactly once, using the given ids verbatim.",
    ),
  concerns: z
    .array(z.string())
    .describe(
      "0 to 3 things going wrong that are bigger than one ticket — a topic spiking, several customers hitting the same thing, a gap in the knowledge base behind live volume. Empty if nothing qualifies.",
    ),
  recommendations: z
    .array(z.string())
    .describe(
      "0 to 3 concrete actions beyond working the queue: an article to write, an existing article customers are not finding. Empty if nothing qualifies.",
    ),
});

export interface TodayInsight extends Omit<z.infer<typeof TodayInsightSchema>, "ranking"> {
  /**
   * The worklist in the model's order, reconciled against the real one — see
   * reconcileRanking. Ids here are always real and always complete.
   */
  ranking: { id: string; why: string | null }[];
  generatedAt: number;
  model: string;
}

/**
 * Force the model's ranking back onto reality.
 *
 * A ranked worklist is the one place a hallucination costs an agent real time,
 * so nothing the model says is taken on trust: ids it invented are dropped,
 * ids it repeated are collapsed, and anything it forgot is appended in the
 * deterministic order lib/today.ts already computed. The output is therefore
 * always exactly the real worklist — the model can only influence its order and
 * annotate it, never change what is on it.
 */
export function reconcileRanking(
  ranked: { id: string; why: string }[],
  actual: { id: string }[],
): { id: string; why: string | null }[] {
  const real = new Set(actual.map((i) => i.id));
  const seen = new Set<string>();
  const out: { id: string; why: string | null }[] = [];
  for (const r of ranked) {
    // The worklist renders ids as [13945] and the model reliably copies the
    // brackets back however the prompt is worded. Strip them rather than
    // discard an otherwise correct ranking over punctuation.
    const id = (r.id ?? "").trim().replace(/^\[|\]$/g, "");
    if (!real.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, why: r.why?.trim() || null });
  }
  for (const i of actual) if (!seen.has(i.id)) out.push({ id: i.id, why: null });
  return out;
}

const SYSTEM = `You brief a customer-support team at the start of their day. They are about to work a queue. Your job is to tell them where to point their attention first.

Rules:
1. Cite the real numbers you are given. Never invent a figure, a ticket id or a topic that is not in the data.
2. Name the specific app — GetSign, VLOOKUP Auto-Link, TrackMy and so on. Never say "Jetpack Apps": that is a portfolio of nine separate apps and it tells the reader nothing about where to look.
3. Plain language. No emoji, no marketing tone, no praising the team or the AI. Each bullet is one short clause.
4. Prefer the actionable over the impressive. "9 GetSign signing-link tickets overnight, nothing in the KB about it" beats "deflection rate held steady".
5. When a spiking topic already HAS a knowledge base article, say so and treat it as a discoverability problem — the answer exists and customers are not finding it. When it has none, treat it as something to write.
6. A ticket count means nothing on its own — compare it to the topic's normal rate when you are given one.
6a. Compare only against numbers actually present below. If no prior figure is given for something, describe today alone. Never write "up from", "down from", "vs. baseline" or "trending" for a quantity you were not given a prior value for — an invented comparison is worse than no comparison, because it will be believed and acted on.
6b. Where a list says "N total, K examples", N is the count to report. The examples are illustrations, not the population — never state the number of examples as if it were the total.
6c. State direction correctly and check it before writing: a smaller number than before is a fall, a larger one is a rise. Getting this backwards ("jumped from 7 to 4") is the single worst thing you can do here, because someone will act on the wrong one.
8. A quiet morning is a fine answer. Do not pad it into drama. If the worklist is empty, say the queue is clear and say it plainly.

RANKING THE WORKLIST — this is the main job.
10. Return every item in the WORKLIST block exactly once. Each item is written as [id] — return the id ONLY, without the square brackets. Do not invent an id, omit one, or merge two into a line.
11. Order by who is actually waiting on a person, not by how old the ticket is. An old id usually means a long conversation, not a neglected one — customers reply on the same thread for days.
    - "quiet Xh" is how long since anyone last said anything. That, not the age, is how long someone has been waiting.
    - "active" means the customer spoke recently and is likely still there. It outranks anything stalled.
    - "stalled" means nobody has touched it since it was escalated or reopened. Among those, the quietest has been forgotten longest and goes first.
11a. A freshdesk status of "waiting on customer" means we already replied and the ball is with them — rank it below anything actually waiting on us, and say so in its "why". Resolved and closed tickets never reach you; they are filtered out before this list is built.
12. A visitor waiting in live chat outranks everything. They are sitting in front of a chat window; a ticket customer is not.
13. "reopened" means Jetta answered and the customer came back unsatisfied. Treat it as worse than a first-time escalation of the same age — the failure is already proven.
14. "N exchanges" is how many times this has been worked. A high count on a stalled ticket means several attempts have not resolved it; say so rather than repeating the subject.
15. "why" names what distinguishes THIS item — the thing that is not true of the one above it. Use the exact figures given: "quiet 46h", "10 exchanges, still open", "reopened, so the first answer already failed", "customer replied an hour ago". Never restate the subject line; the reader can see it.
15a. Do not give two items the same "why". If several are genuinely alike, say what separates them anyway — the exact quiet hours, the exchange count, the app. A column of identical clauses tells the reader nothing and they will stop reading it.
15b. Never round a duration. 34h is "34h", not "a day and a half"; 46h is "46h", not "two days". The reader is deciding what to pick up and an approximation in either direction changes that decision.

CONCERNS AND RECOMMENDATIONS
16. A concern is bigger than one ticket: several customers hitting the same thing, a topic above its normal rate, a gap in the knowledge base behind live volume. If two or three worklist items share an app and a topic, that is one incident and worth saying so.
17. A recommendation is a concrete action beyond working the queue — usually an article to write, or an existing article customers are not finding.
18. Topics are auto-labelled, so near-duplicates are common — "trackmy blank pages" and "trackmy blank page" are one problem, not two. Merge them wherever they appear and never recommend two articles for what is plainly the same thing.
19. Both may be empty. Inventing a concern to fill the section is worse than leaving it out.`;

/** Render only the fields worth spending tokens on, in a compact readable block. */
function renderBrief(b: TodayBrief, yesterday: DailyRollup | null): string {
  const s = b.summary;
  const t = b.trends;

  const apps = b.byApp.map((a) => `${appName(a.app)}:${a.count}`).join(", ") || "none";

  const emerging = t.emerging.length
    ? t.emerging
        .map((e) => {
          const rate =
            e.baselinePerDay == null
              ? "no baseline yet"
              : e.isNew
                ? "never seen before"
                : `normally ~${e.baselinePerDay}/day`;
          const who = e.apps.filter((a) => a.app !== "unknown").map((a) => appName(a.app)).join("/");
          return `  - "${displayTopic(e.topic)}": ${e.recent} in last 24h, ${rate}${
            e.multiplier != null ? ` (${e.multiplier}x)` : ""
          }${who ? `, app: ${who}` : ""}, KB: ${e.kbArticle ? `covered by "${e.kbArticle}"` : "NOTHING WRITTEN"}`;
        })
        .join("\n")
    : "  (nothing above its normal rate)";

  const worklist = b.worklist.length
    ? b.worklist
        .map((w) => {
          const why = w.signals
            .map((g) => (g === "chat_waiting" ? "visitor waiting in live chat" : g))
            .join(" + ");
          const who = w.app && w.app !== "unknown" ? `, app: ${appName(w.app)}` : "";
          const topic = w.topic ? `, topic "${displayTopic(w.topic)}"` : "";
          const status = w.status ? `, freshdesk status "${w.status}"` : "";
          return `  [${w.id}] ${w.state}, ${why}, quiet ${w.quietHours}h, ${w.runs} exchange${
            w.runs === 1 ? "" : "s"
          }${status}${who}${topic} — "${w.subject}"`;
        })
        .join("\n")
    : "  (nothing is waiting on a person)";

  const documentNext = b.documentNext.length
    ? b.documentNext
        .map(
          (d) =>
            `  - "${displayTopic(d.topic)}": ${d.count} ticket${d.count === 1 ? "" : "s"}${
              d.reopened ? `, ${d.reopened} reopened` : ""
            }, KB: ${d.kbArticle ? `covered by "${d.kbArticle}"` : "NOTHING WRITTEN"}`,
        )
        .join("\n")
    : "  (nothing unresolved this week)";

  const lines = [
    `LAST ${b.windowHours}H (tickets Jetta handled — not all helpdesk traffic):`,
    `  came in: ${s.arrived}, Jetta answered: ${s.answered}, escalated: ${s.escalated}, reopened: ${s.reopened}`,
    `  by app: ${apps}`,
    t.partialHistory
      ? `  NOTE: only ${t.historyDaysCovered} days of labelled history — spikes below are not yet reliable.`
      : "",
    "",
    "EMERGING TOPICS:",
    emerging,
    "",
    "WORKLIST — rank every one of these, most urgent first, using the bracketed id:",
    worklist,
    "",
    "THEMES WITH NO ANSWER WRITTEN (the week's unresolved tickets, worst-covered first):",
    documentNext,
    "",
    yesterday
      ? [
          `\nYESTERDAY, THE ONLY PRIOR FIGURES YOU HAVE (${yesterday.date}). This is a full calendar day; the block above is a rolling ${b.windowHours}-hour window that partly overlaps it. They are different shapes, so use this for rough context only and never present it as a trend or a rate change:`,
          `  ${yesterday.outcomes.total} handled, ${yesterday.outcomes.escalated} escalated, ${yesterday.outcomes.reopened} reopened`,
          yesterday.byApp?.length
            ? `  by app: ${yesterday.byApp.map((a) => `${appName(a.app)}:${a.count}`).join(", ")}`
            : `  (no per-app breakdown recorded for yesterday — do NOT compare any app to it)`,
        ].join("\n")
      : "\n(no prior day on record — describe today alone, compare to nothing)",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Write the brief's narrative. Throws on LLM failure — the caller decides
 * whether a missing narrative is worth failing the page over (it isn't).
 */
export async function generateTodayInsight(
  brief: TodayBrief,
  yesterday: DailyRollup | null = null,
): Promise<TodayInsight> {
  const { object } = await generateObject({
    /*
     * Standard tier, not light. Ranking a queue and writing recommendations an
     * agent acts on is not a quality-insensitive call, which is the line the
     * tiering is drawn on. On the same brief the light tier gave seven items
     * for a three-item cap, recommended two separate articles for "trackmy
     * blank pages" and "trackmy blank page", and led the headline with arrival
     * volume while nine people were waiting. It is cached against the brief
     * fingerprint, so this runs when the queue changes, not per page load.
     */
    model: getModel("standard"),
    schema: TodayInsightSchema,
    system: SYSTEM,
    prompt: `${renderBrief(brief, yesterday)}\n\nWrite the briefing.`,
  });
  return {
    ...object,
    // Never trust the ranking as returned — see reconcileRanking.
    ranking: reconcileRanking(object.ranking, brief.worklist),
    // The light tier's structured-output backend rejects minItems/maxItems (see
    // the note above the schema), so the counts in the descriptions are a hint
    // it routinely overshoots — it returned seven recommendations for a
    // three-item cap. Bounded here instead, keeping the earliest, which the
    // model orders by importance.
    concerns: object.concerns.slice(0, 3),
    recommendations: object.recommendations.slice(0, 3),
    generatedAt: Date.now(),
    model: modelLabel("standard"),
  };
}

/**
 * Fingerprint of everything the narrative actually talks about.
 *
 * The insight is cached against this rather than on a timer: a spike that
 * appears at 09:15 must not be missing from a briefing generated at 09:05 and
 * held for the hour, while ten people opening the page on an unchanged morning
 * should share one generation.
 */
export function briefFingerprint(b: TodayBrief): string {
  const s = b.summary;
  return JSON.stringify([
    s.arrived,
    s.answered,
    s.escalated,
    s.reopened,
    s.waiting,
    b.byApp.map((a) => `${a.app}:${a.count}`),
    b.trends.emerging.map((e) => `${e.topic}:${e.recent}:${e.kbArticle ? 1 : 0}`),
    // Worklist identity AND order: a new arrival, or one going quiet enough to
    // change group, must invalidate the cached ranking.
    b.worklist.map((w) => `${w.id}:${w.state}:${w.quietHours}`),
    b.queue.learnings.count,
    b.queue.escalations.count,
    b.queue.reopened.count,
    b.queue.kbReview,
    b.queue.billingApprovals,
  ]);
}
