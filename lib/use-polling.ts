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
 *
 * That takes more than skipping the visibility check: browsers throttle a
 * hidden tab's MAIN-THREAD timers (Chrome to once a minute under intensive
 * throttling or energy saver, Safari harder still), so an interval here would
 * simply stop firing — which read as "the chime only rings when I re-enter
 * the tab", because the visibilitychange tick was the first one to run. Worker
 * timers are exempt from that throttling, so whileHidden moves the clock into
 * a tiny inline worker; fetch and audio were never throttled, only the timer.
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
    // Kept for both modes: it is what makes a re-entered tab catch up NOW
    // rather than at the next interval.
    document.addEventListener("visibilitychange", tick);

    let stop: () => void;
    if (whileHidden && typeof Worker !== "undefined") {
      const url = URL.createObjectURL(
        new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" }),
      );
      let worker: Worker | null = null;
      try {
        worker = new Worker(url);
        worker.onmessage = tick;
      } catch {
        // A CSP without blob: worker-src lands here — fall back to the
        // throttled interval, which still polls whenever the tab is seen.
      }
      if (worker) {
        const w = worker;
        stop = () => {
          w.terminate();
          URL.revokeObjectURL(url);
        };
      } else {
        URL.revokeObjectURL(url);
        const id = setInterval(tick, ms);
        stop = () => clearInterval(id);
      }
    } else {
      const id = setInterval(tick, ms);
      stop = () => clearInterval(id);
    }

    return () => {
      stop();
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms, whileHidden]);
}
