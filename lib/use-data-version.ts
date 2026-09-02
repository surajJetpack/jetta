"use client";

import { useRef } from "react";
import { usePolling } from "./use-polling";

/**
 * Re-run `onChange` when a watched dataset is written — a cron sync landing at
 * 5am, a Regenerate click in another tab, a backfill script. The page's own
 * first fetch is the baseline: the first successful poll only records what the
 * markers were, so mounting never double-loads.
 *
 * Polls /api/admin/data-version (one Redis command) rather than the page's
 * real endpoint, which for /kb and /today is exactly the kind of read the
 * Redis budget cannot spend once a minute on unchanged data.
 *
 * `datasets` and `onChange` are read fresh each tick (usePolling re-captures
 * the latest closure), so neither needs to be memoised by the caller.
 */
export function useDataVersion(datasets: string[], onChange: () => void, ms = 60_000) {
  const seen = useRef<Record<string, number> | null>(null);

  usePolling(async () => {
    let versions: Record<string, number>;
    try {
      const r = await fetch("/api/admin/data-version", { cache: "no-store" });
      if (!r.ok) return; // a failed poll is a skipped poll, not a refresh
      versions = (await r.json()).versions ?? {};
    } catch {
      return;
    }
    const prev = seen.current;
    seen.current = versions;
    if (!prev) return; // baseline — the page just loaded its own data
    if (datasets.some((d) => (versions[d] ?? 0) !== (prev[d] ?? 0))) onChange();
  }, ms);
}
