/**
 * Compute a single day's rollup from the raw outcome/run-log feeds. Pure — no
 * storage access — so it is directly testable and reused by both the
 * daily-overview cron and the manual regenerate endpoint. The AI narrative is
 * added separately (lib/daily-insight.ts); this only produces the numbers.
 */
import { dayKey } from "./series";
import { gapList, tokenStats } from "./analytics";
import type { DailyRollup, OutcomeEvent, RunLog } from "./kv";

/** Volume by product for a day's outcomes, most frequent first. */
function byProduct(outcomes: OutcomeEvent[]): { product: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const o of outcomes) {
    const p = o.product || "unknown";
    freq.set(p, (freq.get(p) ?? 0) + 1);
  }
  return [...freq.entries()]
    .map(([product, count]) => ({ product, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build the numeric rollup for `date` (UTC "YYYY-MM-DD") from the full recent
 * feeds — both are filtered down to that day here. The `insight` field is left
 * for the caller to fill via lib/daily-insight.ts.
 */
export function computeDailyRollup(
  date: string,
  outcomes: OutcomeEvent[],
  runLogs: RunLog[],
): Omit<DailyRollup, "insight"> {
  const dayOutcomes = outcomes.filter((o) => dayKey(o.at) === date);
  const dayRuns = runLogs.filter((r) => dayKey(r.at) === date);

  const total = dayOutcomes.length;
  const escalated = dayOutcomes.filter((o) => o.escalated).length;
  const resolved = dayOutcomes.filter((o) => o.resolutionSent).length;
  const reopened = dayOutcomes.filter((o) => o.kind === "reopened").length;
  const closed = dayOutcomes.filter((o) => o.kind === "closed").length;

  return {
    date,
    computedAt: Date.now(),
    outcomes: {
      total,
      resolved,
      escalated,
      reopened,
      closed,
      deflectionRate: total ? Number((1 - escalated / total).toFixed(2)) : null,
    },
    byProduct: byProduct(dayOutcomes),
    models: tokenStats(dayRuns),
    gaps: gapList(dayOutcomes),
  };
}
