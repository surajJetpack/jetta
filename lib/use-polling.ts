"use client";

import { useEffect, useRef } from "react";

/**
 * Run `fn` on mount and every `ms` while the tab is visible; re-fire
 * immediately when the tab becomes visible again. Interval-based on purpose —
 * the console fetches imperatively everywhere, no data library needed.
 *
 * `whileHidden` keeps the poll running in a backgrounded tab. Pausing is the
 * right default — most badges only matter to eyes that are here — but a poll
 * that feeds the notification chime exists precisely for the tab nobody is
 * looking at, so it must keep ticking to have anything to say.
 */
export function usePolling(
  fn: () => void | Promise<void>,
  ms = 60_000,
  opts?: { whileHidden?: boolean },
) {
  const whileHidden = opts?.whileHidden ?? false;
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    const tick = () => {
      if (whileHidden || document.visibilityState === "visible") void fnRef.current();
    };
    tick();
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms, whileHidden]);
}
