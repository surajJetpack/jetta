"use client";

import { useState } from "react";
import { usePolling } from "@/lib/use-polling";

export interface Attention {
  chatsWaiting: number;
  chatsLive: number;
  billingPending: number;
  learningsPending: number;
  kbDrafts: number;
}

const NONE: Attention = {
  chatsWaiting: 0,
  chatsLive: 0,
  billingPending: 0,
  learningsPending: 0,
  kbDrafts: 0,
};

/**
 * What is waiting, polled once for the whole chrome.
 *
 * 20 seconds is set by the most impatient thing it counts: a visitor watching
 * a blank chat window. The billing queue would be happy with five minutes, but
 * splitting the interval means splitting the request, and one poll answering
 * both is cheaper than two polls answering one each.
 *
 * Any failure — expired session, offline, a store having a bad minute —
 * resolves to zeroes, so the badges disappear rather than freezing on a stale
 * number. A badge that lies is worse than no badge.
 */
export function useAttention(): Attention {
  const [counts, setCounts] = useState<Attention>(NONE);

  usePolling(async () => {
    try {
      const r = await fetch("/api/admin/attention", { cache: "no-store" });
      if (!r.ok) return setCounts(NONE);
      const j = (await r.json()) as Partial<Attention>;
      setCounts({
        chatsWaiting: j.chatsWaiting ?? 0,
        chatsLive: j.chatsLive ?? 0,
        billingPending: j.billingPending ?? 0,
        learningsPending: j.learningsPending ?? 0,
        kbDrafts: j.kbDrafts ?? 0,
      });
    } catch {
      setCounts(NONE);
    }
  }, 20_000);

  return counts;
}
