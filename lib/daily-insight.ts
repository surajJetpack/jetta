/**
 * Turn a day's numeric rollup into a short narrative "AI Insight" for the
 * dashboard. Mirrors lib/distill.ts: generateObject + a Zod schema, on the
 * light tier (this runs once a day, not per page view). Pure of storage — the
 * caller passes today's rollup and, when available, yesterday's for trend
 * deltas, and persists the result.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { getModel, modelLabel } from "./llm";
import { PRICES } from "./analytics";
import type { DailyInsight, DailyRollup } from "./kv";

// NB: no array min/max constraints — some structured-output backends (the
// light tier's) reject minItems/maxItems other than 0/1. Counts are steered by
// the descriptions + system prompt instead, exactly as lib/distill.ts does.
export const InsightSchema = z.object({
  headline: z.string().describe("One plain-language sentence summarizing the day. No emoji."),
  highlights: z
    .array(z.string())
    .describe("2 to 4 short bullet observations a support lead would care about."),
  watchouts: z
    .array(z.string())
    .describe("0 to 2 things worth attention (spikes in escalations/reopens, cost anomalies). Empty array if nothing stands out."),
});

const SYSTEM = `You write a terse daily operations digest for "Jetta", an AI support agent that handles customer tickets. Your audience is the support/eng lead skimming a dashboard.

Rules:
1. Be factual and specific — cite the actual numbers from the data. Never invent figures.
2. Plain language, no marketing tone, no emoji. Each bullet is one short clause.
3. "watchouts" are for genuine signals only: a jump in escalations or reopens vs. yesterday, an unusual cost, a product suddenly dominating. If the day looks normal, return an empty watchouts array.
4. When yesterday's numbers are given, frame changes as deltas ("escalations up from 2 to 7"). Otherwise describe today alone.
5. A quiet day is a fine answer — say so plainly rather than padding.`;

/** Total estimated USD across a rollup's per-model cost figures. */
function totalCostUsd(r: Pick<DailyRollup, "models">): number {
  return r.models.reduce((s, m) => s + (m.estCostUsd ?? 0), 0);
}

function renderRollup(label: string, r: Omit<DailyRollup, "insight">): string {
  const o = r.outcomes;
  const cost = totalCostUsd(r);
  const products = r.byProduct.map((p) => `${p.product}:${p.count}`).join(", ") || "none";
  const knownCost = r.models.some((m) => PRICES[m.model]);
  return [
    `${label} (${r.date}):`,
    `  tickets handled: ${o.total}`,
    `  resolved: ${o.resolved}, escalated: ${o.escalated}, reopened: ${o.reopened}, auto-closed: ${o.closed}`,
    `  deflection rate: ${o.deflectionRate != null ? `${Math.round(o.deflectionRate * 100)}%` : "n/a"}`,
    `  by product: ${products}`,
    `  est. spend: ${knownCost ? `$${cost.toFixed(2)}` : "n/a (unpriced model)"}`,
    r.gaps.length
      ? `  unresolved (escalated/reopened): ${r.gaps.map((g) => `#${g.ticketId} ${g.subject}`).slice(0, 8).join("; ")}`
      : `  unresolved: none`,
  ].join("\n");
}

/**
 * Generate the narrative for `today`. `yesterday` is optional context for
 * trend deltas. Returns a DailyInsight (with generatedAt/model stamped).
 */
export async function generateDailyInsight(
  today: Omit<DailyRollup, "insight">,
  yesterday?: Omit<DailyRollup, "insight"> | null,
): Promise<DailyInsight> {
  const prompt = [
    renderRollup("TODAY", today),
    yesterday ? `\n${renderRollup("YESTERDAY", yesterday)}` : "\n(no prior day on record)",
    "\nWrite the digest.",
  ].join("\n");

  const { object } = await generateObject({
    model: getModel("light"),
    schema: InsightSchema,
    system: SYSTEM,
    prompt,
  });

  return {
    ...object,
    generatedAt: Date.now(),
    model: modelLabel("light"),
  };
}
