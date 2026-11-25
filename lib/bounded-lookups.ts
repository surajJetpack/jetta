/**
 * Run many lookups a few at a time, and stop waiting at a deadline.
 *
 * Written for the Today page's Freshdesk fallback. With Jetta's own ticket
 * copy unavailable (in November 2026 its database was over quota for days),
 * the page asked Freshdesk about every ticket on the worklist at once: about
 * 50 requests against a limit of 40 a minute. Freshdesk refused them, each
 * retry waited up to 30 seconds, and the page died at its 60-second limit
 * with nothing to show, having also spent the allowance ticket replies share.
 *
 * So: a few at a time, and once the time allowed is spent, whatever is still
 * unanswered is reported as unchecked for the caller to handle. A lookup that
 * loses the race is not cancelled; with a small `concurrency` only a few can
 * be left running. A lookup that throws is unchecked too.
 */
export interface BoundedLookups<T> {
  results: Map<string, T>;
  /** Ids with no answer: out of time, or the lookup threw. In input order. */
  unchecked: string[];
}

export async function boundedLookups<T>(
  ids: readonly string[],
  lookup: (id: string) => Promise<T>,
  opts: { concurrency: number; budgetMs: number },
): Promise<BoundedLookups<T>> {
  const deadline = Date.now() + opts.budgetMs;
  const results = new Map<string, T>();
  const missed = new Set<string>();
  let next = 0;

  const TIMED_OUT = Symbol("timed out");
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const left = deadline - Date.now();
      if (left <= 0) {
        missed.add(id);
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const got = await Promise.race([
          lookup(id),
          new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), left);
          }),
        ]);
        if (got === TIMED_OUT) missed.add(id);
        else results.set(id, got as T);
      } catch {
        missed.add(id);
      } finally {
        clearTimeout(timer);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, ids.length)) }, worker));
  return { results, unchecked: ids.filter((id) => missed.has(id)) };
}
