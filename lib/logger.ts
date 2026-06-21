/**
 * Tiny structured logger (Tier 3). Emits one JSON line per event to stdout so
 * Vercel logs (and any future log drain) are queryable. Not for the rich
 * per-run activity log — that's recordRunLog in kv.ts.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ level, event, t: new Date().toISOString(), ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, err?: unknown, data?: Record<string, unknown>) =>
    emit("error", event, {
      ...data,
      error: err instanceof Error ? err.message : err ? String(err) : undefined,
      stack: err instanceof Error ? err.stack : undefined,
    }),
};
