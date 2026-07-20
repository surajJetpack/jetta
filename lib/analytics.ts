/**
 * Shared analytics helpers: per-model pricing, token/cost aggregation, and the
 * knowledge-gap list. Extracted from app/api/admin/stats/route.ts so the live
 * Insights panel and the daily rollup (lib/daily-rollup.ts) compute the exact
 * same numbers from one source of truth.
 */
import { config } from "./config";
import type { OutcomeEvent, RunLog } from "./kv";

/**
 * $ per million tokens (input, output) for models we run, keyed by the RunLog
 * model label. Used for estimated-cost display only — billing truth lives with
 * the provider. Unknown models show token counts without a cost estimate.
 */
export const PRICES: Record<string, { in: number; out: number; cacheRead?: number }> = {
  "openrouter/anthropic/claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 },
  "openrouter/anthropic/claude-haiku-4.5": { in: 1, out: 5, cacheRead: 0.1 },
  "openrouter/z-ai/glm-5.2": { in: 0.42, out: 1.32, cacheRead: 0.078 },
};

export interface ModelTokenStat {
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  avgTokensPerRun: number;
  estCostUsd: number | null;
}

/** Aggregate token usage + estimated cost per model from run logs. */
export function tokenStats(runs: RunLog[]): ModelTokenStat[] {
  const by = new Map<
    string,
    { runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  >();
  for (const r of runs) {
    if (!r.usage) continue;
    let b = by.get(r.model);
    if (!b) {
      b = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      by.set(r.model, b);
    }
    b.runs++;
    b.inputTokens += r.usage.inputTokens ?? 0;
    b.outputTokens += r.usage.outputTokens ?? 0;
    b.cacheReadTokens += r.usage.cacheReadTokens ?? 0;
  }
  return [...by.entries()].map(([model, b]) => {
    const price = PRICES[model];
    // Cached reads bill at the cacheRead rate; the remainder at full input
    // price. (Cache-write premium ~1.25x on a fraction of tokens is ignored.)
    const freshIn = Math.max(0, b.inputTokens - b.cacheReadTokens);
    const cost = price
      ? (freshIn * price.in + b.cacheReadTokens * (price.cacheRead ?? price.in) + b.outputTokens * price.out) / 1e6
      : null;
    return {
      model,
      runs: b.runs,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheReadTokens: b.cacheReadTokens,
      avgTokensPerRun: b.runs ? Math.round((b.inputTokens + b.outputTokens) / b.runs) : 0,
      estCostUsd: cost != null ? Number(cost.toFixed(4)) : null,
    };
  });
}

export interface Gap {
  ticketId: string;
  subject: string;
  reason: string;
  at: number;
  url: string;
}

/**
 * De-dupe by ticket (keep most recent). These are the tickets Jetta couldn't
 * close herself — the prioritised "document these next" list.
 */
export function gapList(outcomes: OutcomeEvent[]): Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const o of outcomes) {
    if (!o.escalated && o.kind !== "reopened") continue;
    if (seen.has(o.ticketId)) continue;
    seen.add(o.ticketId);
    out.push({
      ticketId: o.ticketId,
      subject: o.subject ?? "(no subject)",
      reason: o.kind === "reopened" ? "reopened" : "escalated",
      at: o.at,
      url: `https://${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}/a/tickets/${o.ticketId}`,
    });
  }
  return out;
}
