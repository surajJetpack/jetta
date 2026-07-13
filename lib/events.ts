/**
 * Unified ops event log — the durable "everything" stream for audit and AI
 * analysis. One capped Redis list (`jetta:events`) that every subsystem writes
 * to: webhook receipts and skips, agent runs, draft decisions, learnings
 * changes, auth, cron summaries, Slack actions, failures.
 *
 * Two entry paths:
 *   - lib/logger.ts dual-writes every log.info/warn/error here (best-effort)
 *   - route handlers call logOpsEvent() directly (awaited) for decision-grade
 *     events that must not be lost
 *
 * Consumption: GET /api/admin/events (JSON for the console, NDJSON for AI).
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

export type EventLevel = "info" | "warn" | "error";

export interface OpsEvent {
  id: string;
  /** Unix MILLISECONDS — keeps ordering within bursts. */
  at: number;
  level: EventLevel;
  /** Dot-namespaced machine name, e.g. "webhook.skipped_product_filter". */
  event: string;
  source: "webhook" | "freshchat" | "console" | "cron" | "slack" | "auth" | "app";
  ticketId?: string;
  /** Console username / "api" / "dev" where a human (or key) acted. */
  actor?: string;
  data?: Record<string, unknown>;
}

const EVENTS_KEY = "jetta:events";
const EVENTS_CAP = 5000;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

const memEvents: OpsEvent[] = [];

/** Append an event. NEVER throws — logging must not break a request. */
export async function logOpsEvent(e: Omit<OpsEvent, "id" | "at">): Promise<void> {
  try {
    const full: OpsEvent = { ...e, id: `evt-${crypto.randomUUID()}`, at: Date.now() };
    const r = client();
    if (r) {
      await r.lpush(EVENTS_KEY, JSON.stringify(full));
      await r.ltrim(EVENTS_KEY, 0, EVENTS_CAP - 1);
      return;
    }
    memEvents.unshift(full);
    if (memEvents.length > EVENTS_CAP) memEvents.pop();
  } catch {
    // Swallowed by design; the console line from lib/logger.ts still exists.
  }
}

export interface EventQuery {
  limit?: number;
  level?: EventLevel;
  /** Prefix match, e.g. "webhook." */
  event?: string;
  source?: OpsEvent["source"];
  ticketId?: string;
  /** Unix ms lower bound. */
  sinceMs?: number;
}

/** Newest-first. Filters applied after fetch (single small list). */
export async function getOpsEvents(q: EventQuery = {}): Promise<OpsEvent[]> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), EVENTS_CAP);
  const r = client();
  let all: OpsEvent[];
  if (r) {
    // Over-fetch when filtering so post-filter results still fill the limit.
    const filtered = q.level || q.event || q.source || q.ticketId || q.sinceMs;
    const raw = await r.lrange<OpsEvent | string>(EVENTS_KEY, 0, (filtered ? EVENTS_CAP : limit) - 1);
    all = raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as OpsEvent) : x));
  } else {
    all = [...memEvents];
  }
  return all
    .filter(
      (e) =>
        (!q.level || e.level === q.level) &&
        (!q.event || e.event.startsWith(q.event)) &&
        (!q.source || e.source === q.source) &&
        (!q.ticketId || e.ticketId === q.ticketId) &&
        (!q.sinceMs || e.at >= q.sinceMs),
    )
    .slice(0, limit);
}
