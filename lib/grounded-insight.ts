/**
 * The grounding both AI reads share (/health, /performance).
 *
 * A read is only as good as its worst sentence, so the model never gets to
 * assert on its own: it is handed a numbered EVIDENCE list — each number on
 * the page with the drill-down that opens the tickets behind it — and every
 * point must cite one. reconcileInsight() then drops any point that cites an
 * entry that doesn't exist, or states a number that appears nowhere in what
 * the model was shown, and any "going well" point resting on a figure that got
 * worse than the prior period. Pages decide the evidence and the voice; this decides
 * what survives.
 */
import { z } from "zod";

/** A number on the page, and the tickets behind it. `title`/`description` are what the drill sheet shows. */
export interface Evidence<D> {
  id: string;
  label: string;
  count: number;
  title: string;
  description: string;
  drill: D;
  /**
   * The figure got worse than the prior 28 days. Such an entry can't back a
   * "going well" point, however it compares to an older baseline — the model
   * kept listing a rising reopen rate as good because it beat pre-launch.
   */
  worse?: boolean;
}

export interface InsightPoint<D> {
  text: string;
  /** The drill this point opens. Null only for an action that stands on no single number. */
  evidence: Pick<Evidence<D>, "title" | "description" | "drill" | "count"> | null;
}

export interface Insight<D> {
  headline: string;
  goingWell: InsightPoint<D>[];
  watch: InsightPoint<D>[];
  actions: InsightPoint<D>[];
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

/** The shape both reads share. `headline` is described per page by `headlineHint`. */
export const insightSchema = (headlineHint: string, watchHint: string) =>
  z.object({
    headline: z.string().describe(headlineHint),
    goingWell: z.array(Point).describe("0 to 3 things that are genuinely going well, biggest first. Empty if nothing is."),
    watch: z.array(Point).describe(watchHint),
    actions: z
      .array(Point)
      .describe('0 to 3 concrete next steps someone could take this week. evidence may be "" when an action rests on no single number.'),
  });

export type InsightDraft = z.infer<ReturnType<typeof insightSchema>>;

/**
 * "better" / "worse" / "unchanged" for a figure against an earlier one —
 * computed, so the model reads the direction instead of working it out (it
 * called a fall from 40% to 31% "going well" because it beat an older 15%).
 */
export function trend(now: number | null, before: number | null, better: "higher" | "lower"): string {
  if (now == null || before == null) return "";
  if (now === before) return " unchanged";
  return (now > before) === (better === "higher") ? " better" : " worse";
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
export function reconcileInsight<D>(
  raw: InsightDraft,
  evidence: Evidence<D>[],
  prompt: string,
): Pick<Insight<D>, "headline" | "goingWell" | "watch" | "actions" | "dropped"> {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const known = new Set(numbers(prompt));
  let dropped = 0;
  const fix = (points: { text: string; evidence: string }[], mayStandAlone: boolean, good = false) => {
    const out: InsightPoint<D>[] = [];
    for (const p of points) {
      const text = p.text?.trim();
      const id = (p.evidence ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
      const e = id ? byId.get(id) : undefined;
      const inventedNumber = numbers(text ?? "").some((n) => !known.has(n));
      if (!text || (id && !e) || (!e && !mayStandAlone) || inventedNumber || (good && e?.worse)) {
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
    goingWell: fix(raw.goingWell ?? [], false, true),
    watch: fix(raw.watch ?? [], false),
    actions: fix(raw.actions ?? [], true),
    dropped: dropped + (badHeadline ? 1 : 0),
  };
}

