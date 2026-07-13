/** Pure time-series bucketing helpers for the Insights charts. */

/** UTC day key ("2026-07-13") of a unix-seconds timestamp. */
export function dayKey(atSeconds: number): string {
  return new Date(atSeconds * 1000).toISOString().slice(0, 10);
}

/** The last `days` UTC day keys ending today, oldest first. */
export function lastDays(days: number, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(nowMs - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Bucket items into the last `days` UTC days; missing days are zero-filled. */
export function bucketByDay<T>(
  items: T[],
  atSeconds: (item: T) => number,
  days: number,
  nowMs = Date.now(),
): { day: string; items: T[] }[] {
  const buckets = new Map<string, T[]>(lastDays(days, nowMs).map((d) => [d, []]));
  for (const it of items) {
    const key = dayKey(atSeconds(it));
    buckets.get(key)?.push(it);
  }
  return [...buckets.entries()].map(([day, its]) => ({ day, items: its }));
}

/**
 * Trailing-window rolling ratio: for each day, numerator/denominator summed
 * over the previous `window` days (inclusive). Null when the window is empty.
 */
export function rollingRate(
  days: { day: string; num: number; den: number }[],
  window: number,
): { day: string; rate: number | null }[] {
  return days.map((_, i) => {
    const slice = days.slice(Math.max(0, i - window + 1), i + 1);
    const num = slice.reduce((s, d) => s + d.num, 0);
    const den = slice.reduce((s, d) => s + d.den, 0);
    return { day: days[i].day, rate: den ? num / den : null };
  });
}
