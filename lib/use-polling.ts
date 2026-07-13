"use client";

import { useEffect, useRef } from "react";

/**
 * Run `fn` on mount and every `ms` while the tab is visible; re-fire
 * immediately when the tab becomes visible again. Interval-based on purpose —
 * the console fetches imperatively everywhere, no data library needed.
 */
export function usePolling(fn: () => void | Promise<void>, ms = 60_000) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void fnRef.current();
    };
    tick();
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}
