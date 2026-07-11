/** Client-safe display helpers shared across console components. */

/** "480ms" under a second, "12.3s" from one second up. */
export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
