/**
 * Tiny structured logger (Tier 3). Every event goes two places:
 *   1. One JSON line to stdout — visible in local dev and Vercel function logs.
 *   2. The durable ops event log (lib/events.ts, `jetta:events`) — best-effort
 *      fire-and-forget so logging never blocks or breaks a request. Events a
 *      route must not lose (decisions, auth) should call logOpsEvent directly
 *      with await instead of relying on this floating write.
 *
 * `data.source`, `data.ticketId`, and `data.actor` are lifted onto the event
 * envelope when present. Not for the rich per-run activity log — that's
 * recordRunLog in kv.ts.
 */
import { logOpsEvent, type OpsEvent } from "./events";

type Level = "info" | "warn" | "error";

const SOURCES: OpsEvent["source"][] = ["webhook", "freshchat", "console", "cron", "slack", "auth", "app"];

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ level, event, t: new Date().toISOString(), ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  const src = data?.source;
  void logOpsEvent({
    level,
    event,
    source: SOURCES.includes(src as OpsEvent["source"]) ? (src as OpsEvent["source"]) : "app",
    ticketId: typeof data?.ticketId === "string" ? data.ticketId : data?.ticketId != null ? String(data.ticketId) : undefined,
    actor: typeof data?.actor === "string" ? data.actor : undefined,
    data,
  }).catch(() => {});
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
