"use client";

import { useEffect, useRef, useState } from "react";
import { usePolling } from "@/lib/use-polling";
import { armChime, playChime } from "./chime";

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
  /**
   * The last KNOWN waiting count — null while we have never seen one, or after
   * a failed poll. Null, not zero: a poll that errors resolves the badges to
   * zeroes, and if that zero were remembered as fact, the next successful poll
   * would rediscover the same two waiting visitors and ring for them again.
   */
  const knownWaiting = useRef<number | null>(null);

  useEffect(() => {
    armChime();
  }, []);

  usePolling(
    async () => {
      try {
        const r = await fetch("/api/admin/attention", { cache: "no-store" });
        if (!r.ok) {
          knownWaiting.current = null;
          return setCounts(NONE);
        }
        const j = (await r.json()) as Partial<Attention>;
        const waiting = j.chatsWaiting ?? 0;
        // The chime is for the CHANGE — someone new started waiting — not for
        // the state, or a visitor nobody has picked up yet would ring every
        // twenty seconds until they gave up.
        if (knownWaiting.current !== null && waiting > knownWaiting.current) {
          playChime("waiting");
        }
        knownWaiting.current = waiting;
        setCounts({
          chatsWaiting: waiting,
          chatsLive: j.chatsLive ?? 0,
          billingPending: j.billingPending ?? 0,
          learningsPending: j.learningsPending ?? 0,
          kbDrafts: j.kbDrafts ?? 0,
        });
      } catch {
        knownWaiting.current = null;
        setCounts(NONE);
      }
    },
    20_000,
    // A waiting visitor most needs announcing to the tab that ISN'T being
    // looked at — pausing this poll in the background would silence the one
    // case the chime exists for.
    { whileHidden: true },
  );

  return counts;
}
