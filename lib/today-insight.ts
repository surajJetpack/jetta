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
    .describe("One plain sentence: the shape of the last 24 hours. No emoji, no greeting."),
  startHere: z
    .string()
    .describe(
      "The single thing to do first, naming the specific ticket, topic or queue. One sentence, imperative.",
    ),
  highlights: z
    .array(z.string())
    .describe("2 to 4 further short observations worth a support person's attention."),
});

export interface TodayInsight extends z.infer<typeof TodayInsightSchema> {
  generatedAt: number;
  model: string;
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
7. Draft age matters: a suggestion that has been waiting days has usually gone stale, and the customer has been waiting exactly that long.
8. "startHere" must be one concrete action, not a summary. If genuinely nothing needs a human, say the queue is clear and say it plainly.
9. A quiet morning is a fine answer. Do not pad it into drama.`;

/** "3 days" reads; "714 hours" does not, and the model repeats whatever unit it is handed. */
function humanAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Lead with the real total, then the examples. Labelling the sample instead
 * ("showing 5 of 13") still had the model opening a bullet with "Five
 * escalations are live" — whatever number comes first is the one it repeats.
 */
function sample<T>(items: T[], total: number, limit: number, render: (x: T) => string): string {
  const shown = items.slice(0, limit);
  const head = `${total} total`;
  const tail = total > shown.length ? `, ${shown.length} examples` : "";
  return `(${head}${tail}): ${shown.map(render).join("; ")}`;
}

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

  const q = b.queue;
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
    "WAITING ON A HUMAN (whole open queue, not just 24h):",
    `  drafts to review: ${q.drafts.count}${
      q.drafts.oldestAgeHours != null ? ` (oldest has been waiting ${humanAge(q.drafts.oldestAgeHours)})` : ""
    }`,
    `  escalated to the team, last 72h: ${q.escalations.count}`,
    `  reopened this week: ${q.reopened.count}`,
    `  KB articles awaiting review: ${q.kbReview}`,
    `  billing approvals pending: ${q.billingApprovals}`,
    q.escalations.items.length
      ? `  escalations ${sample(q.escalations.items, q.escalations.count, 5, (e) => `${e.label} ${e.subject}`)}`
      : "",
    "",
    q.reopened.items.length
      ? `REOPENED (Jetta's answer didn't land) ${sample(q.reopened.items, q.reopened.count, 5, (r) => `${r.label} ${r.subject}`)}`
      : "",
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
    model: getModel("light"),
    schema: TodayInsightSchema,
    system: SYSTEM,
    prompt: `${renderBrief(brief, yesterday)}\n\nWrite the briefing.`,
  });
  return { ...object, generatedAt: Date.now(), model: modelLabel("light") };
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
    b.queue.drafts.count,
    b.queue.escalations.count,
    b.queue.reopened.count,
    b.queue.kbReview,
    b.queue.billingApprovals,
  ]);
}
