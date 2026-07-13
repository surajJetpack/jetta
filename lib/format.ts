/** Client-safe display helpers shared across console components. */

import { useEffect, useState } from "react";

/** "480ms" under a second, "12.3s" from one second up. */
export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Relative age of a unix-seconds timestamp against a caller-supplied "now". */
export function fmtAgo(atSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - atSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Exact local time of a unix-seconds timestamp, for hover titles. */
export function fmtExact(atSeconds: number): string {
  return new Date(atSeconds * 1000).toLocaleString();
}

/** Local date ("Jul 13, 2026") of a unix-seconds or ISO timestamp. */
export function fmtDate(at: number | string): string {
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Local date + time ("Jul 13, 2026, 14:30") of a unix-seconds or ISO timestamp. */
export function fmtDateTime(at: number | string): string {
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Ticking clock for relative timestamps: re-renders on an interval so
 * "Xm ago" stays correct while the page sits open.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
