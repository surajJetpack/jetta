/**
 * Orchestrates a day's rollup end-to-end: pull the raw feeds, compute the
 * numbers (lib/daily-rollup.ts), generate the AI narrative (lib/daily-insight.ts),
 * and persist (lib/kv.ts). Shared by the daily-overview cron and the manual
 * regenerate endpoint so both produce identical results.
 */
import { getOutcomes, getRunLogs, getDailyRollup, saveDailyRollup, type DailyRollup } from "./kv";
import { computeDailyRollup } from "./daily-rollup";
import { generateDailyInsight } from "./daily-insight";
import { dayKey } from "./series";

/** UTC "YYYY-MM-DD" for the most recently completed full day. */
export function yesterdayKey(nowMs = Date.now()): string {
  return dayKey(Math.floor(nowMs / 1000) - 86400);
}

/**
 * Compute + narrate + save the rollup for `date`. The insight is best-effort:
 * if the LLM call fails, the numeric rollup is still saved (insight: null) so
 * the dashboard shows data. Returns the saved rollup.
 */
export async function refreshDailyRollup(date: string): Promise<DailyRollup> {
  // Same source the live stats route reads (capped feeds); a persisted rollup
  // then survives even after the day rolls out of the window.
  const [outcomes, runLogs, prev] = await Promise.all([
    getOutcomes(500),
    getRunLogs(500),
    getDailyRollup(dayKey(Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) - 86400)),
  ]);

  const base = computeDailyRollup(date, outcomes, runLogs);

  let insight: DailyRollup["insight"] = null;
  try {
    insight = await generateDailyInsight(base, prev);
  } catch (e) {
    console.warn(`daily-insight generation failed for ${date}:`, e instanceof Error ? e.message : e);
  }

  const rollup: DailyRollup = { ...base, insight };
  await saveDailyRollup(rollup);
  return rollup;
}
