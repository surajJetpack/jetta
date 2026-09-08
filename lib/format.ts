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

/**
 * Local wall-clock time of a unix-seconds or ISO timestamp — "2:30 PM" or
 * "14:30", whichever the viewer's locale uses. `hour: "numeric"` rather than
 * "2-digit" because "2:30 PM" beats "02:30 PM" in a 10px label.
 */
export function fmtTime(at: number | string): string {
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The viewer's own time zone: a short label to show ("PDT", "GMT+5:45") and
 * the IANA name to put in a tooltip ("America/Los_Angeles").
 *
 * Both are read off the browser, so both differ between the server render and
 * the client — whatever displays them needs `suppressHydrationWarning`, the
 * same bargain `RelativeTime` makes.
 *
 * `short` falls back to the IANA name rather than to an empty string: a zone
 * label that renders as nothing is worse than a long one, because the reader
 * cannot tell a missing zone from a zone they misread.
 */
export function localZone(): { short: string; name: string } {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(
    new Date(),
  );
  const short = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  return { short: short || name, name };
}

/**
 * Local calendar day of a timestamp ("2026-09-08"), for grouping.
 *
 * Built from the local date parts rather than `toISOString().slice(0, 10)`,
 * which would be the UTC day: west of Greenwich that reads an evening message
 * as tomorrow, and every day boundary then lands in the wrong place.
 */
export function dayKey(at: number | string): string {
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * A date divider's label: "Today", "Yesterday", or "Mon, 8 Sep".
 *
 * Compares calendar days against a caller-supplied "now" rather than elapsed
 * hours — 23:50 and 00:10 are twenty minutes and two days apart, and someone
 * scanning a transcript wants the second answer.
 */
export function fmtDayLabel(at: number | string, nowMs: number): string {
  const d = typeof at === "number" ? new Date(at * 1000) : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const key = dayKey(d.getTime() / 1000);
  if (key === dayKey(nowMs / 1000)) return "Today";
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime() / 1000)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    // A chat from last year is rare, but a bare "Mon, 8 Sep" on one is a lie.
    ...(d.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
  });
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
