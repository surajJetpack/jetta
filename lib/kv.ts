/**
 * Tiny wrapper over Upstash Redis (provisioned via the Vercel Marketplace as
 * the replacement for the now-retired Vercel KV).
 *
 * Used for two things:
 *   1. Webhook idempotency — dedupe duplicate Freshdesk/Freshchat deliveries.
 *   2. Follow-up jobs — store "check this ticket in 24h" jobs the cron drains.
 *
 * When KV is not configured (e.g. local stub runs) it falls back to an
 * in-memory map so the app still works for a single process lifetime.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

export interface FollowUpJob {
  ticketId: string;
  /** Unix seconds when the job becomes due. */
  dueAt: number;
  action: "check_and_close";
  /** ISO timestamp of when the resolution was sent, to detect later replies. */
  resolutionSentAt: string;
}

const FOLLOWUP_SET = "jetta:followups";
const followupKey = (ticketId: string) => `jetta:followup:${ticketId}`;
const dedupeKey = (eventId: string) => `jetta:event:${eventId}`;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

// In-memory fallback (single-process only).
const memEvents = new Map<string, number>();
const memJobs = new Map<string, FollowUpJob>();

/**
 * Returns true the first time an event ID is seen, false on duplicates.
 * Backed by a short-TTL key so retried webhook deliveries are ignored.
 */
export async function markEventSeen(eventId: string, ttlSeconds = 3600): Promise<boolean> {
  const r = client();
  if (r) {
    // NX = only set if absent; returns "OK" on first write, null if it existed.
    const res = await r.set(dedupeKey(eventId), "1", { nx: true, ex: ttlSeconds });
    return res === "OK";
  }
  const now = Math.floor(Date.now() / 1000);
  const expiry = memEvents.get(eventId);
  if (expiry && expiry > now) return false;
  memEvents.set(eventId, now + ttlSeconds);
  return true;
}

/** Store a follow-up job, due `delaySeconds` from now (default 24h). */
export async function scheduleFollowUp(
  ticketId: string,
  resolutionSentAt: string,
  delaySeconds = 86400,
): Promise<void> {
  const job: FollowUpJob = {
    ticketId,
    dueAt: Math.floor(Date.now() / 1000) + delaySeconds,
    action: "check_and_close",
    resolutionSentAt,
  };
  const r = client();
  if (r) {
    await r.set(followupKey(ticketId), JSON.stringify(job));
    await r.sadd(FOLLOWUP_SET, ticketId);
    return;
  }
  memJobs.set(ticketId, job);
}

/** Return all follow-up jobs that are due (dueAt in the past). */
export async function getDueFollowUps(): Promise<FollowUpJob[]> {
  const now = Math.floor(Date.now() / 1000);
  const r = client();
  if (r) {
    const ids = await r.smembers(FOLLOWUP_SET);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<FollowUpJob>(followupKey(id))));
    return raw.filter((j): j is FollowUpJob => !!j && j.dueAt <= now);
  }
  return [...memJobs.values()].filter((j) => j.dueAt <= now);
}

/** Remove a follow-up job once handled. */
export async function clearFollowUp(ticketId: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(followupKey(ticketId));
    await r.srem(FOLLOWUP_SET, ticketId);
    return;
  }
  memJobs.delete(ticketId);
}

// ── Generic short-lived key/value (used for the two-person cancel confirm) ──
const memKv = new Map<string, { value: string; expiry: number }>();

export async function kvSet(key: string, value: string, ttlSeconds = 600): Promise<void> {
  const r = client();
  if (r) {
    await r.set(key, value, { ex: ttlSeconds });
    return;
  }
  memKv.set(key, { value, expiry: Math.floor(Date.now() / 1000) + ttlSeconds });
}

export async function kvGet(key: string): Promise<string | null> {
  const r = client();
  if (r) return await r.get<string>(key);
  const entry = memKv.get(key);
  if (!entry) return null;
  if (entry.expiry <= Math.floor(Date.now() / 1000)) {
    memKv.delete(key);
    return null;
  }
  return entry.value;
}

export async function kvDel(key: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(key);
    return;
  }
  memKv.delete(key);
}
