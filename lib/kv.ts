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

// ── Phase 0: outcome feedback log ──────────────────────────────────
export interface OutcomeEvent {
  ticketId: string;
  subject?: string;
  at: number; // unix seconds
  channel: string;
  product: string;
  model: string;
  toolsUsed: string[];
  replied: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  /** handled = normal turn; reopened = customer replied after resolution; closed = auto-closed on silence. */
  kind: "handled" | "reopened" | "closed";
}

const OUTCOMES_KEY = "jetta:outcomes";
const memOutcomes: OutcomeEvent[] = [];

/** Append a run outcome (newest first), capped at 1000. */
export async function recordOutcome(e: OutcomeEvent): Promise<void> {
  const r = client();
  if (r) {
    await r.lpush(OUTCOMES_KEY, e);
    await r.ltrim(OUTCOMES_KEY, 0, 999);
    return;
  }
  memOutcomes.unshift(e);
  if (memOutcomes.length > 1000) memOutcomes.length = 1000;
}

export async function getOutcomes(limit = 200): Promise<OutcomeEvent[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<OutcomeEvent | string>(OUTCOMES_KEY, 0, limit - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as OutcomeEvent) : x));
  }
  return memOutcomes.slice(0, limit);
}

// ── KB usage counters ──────────────────────────────────────────────
// Incremented (fire-and-forget) each time search_knowledge_base returns an
// article to the agent — the cheap signal for "which articles earn their keep".
const KB_HITS = "jetta:kb:hits";
const KB_LASTHIT = "jetta:kb:lasthit";
const kbHitsMonthKey = (d = new Date()) =>
  `jetta:kb:hits:m:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const memKbHits = new Map<string, { total: number; month: number; lastHit: number }>();

/** Record that these article ids were returned to the agent. Never throws. */
export async function recordKbHits(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = client();
  const t = Math.floor(Date.now() / 1000);
  if (r) {
    const monthKey = kbHitsMonthKey();
    const p = r.pipeline();
    for (const id of ids) {
      p.hincrby(KB_HITS, id, 1);
      p.hincrby(monthKey, id, 1);
      p.hset(KB_LASTHIT, { [id]: t });
    }
    p.expire(monthKey, 90 * 86400); // monthly counters age out on their own
    await p.exec();
    return;
  }
  for (const id of ids) {
    const e = memKbHits.get(id) ?? { total: 0, month: 0, lastHit: 0 };
    memKbHits.set(id, { total: e.total + 1, month: e.month + 1, lastHit: t });
  }
}

export interface KbUsage {
  total: number;
  month: number;
  lastHit: number;
}

/** All-time + current-month hit counts and last-hit time, keyed by article id. */
export async function getKbUsage(): Promise<Record<string, KbUsage>> {
  const r = client();
  if (!r) return Object.fromEntries(memKbHits);
  const [totals, months, lastHits] = await Promise.all([
    r.hgetall<Record<string, number>>(KB_HITS),
    r.hgetall<Record<string, number>>(kbHitsMonthKey()),
    r.hgetall<Record<string, number>>(KB_LASTHIT),
  ]);
  const out: Record<string, KbUsage> = {};
  for (const [id, total] of Object.entries(totals ?? {})) {
    out[id] = { total: Number(total), month: Number(months?.[id] ?? 0), lastHit: Number(lastHits?.[id] ?? 0) };
  }
  return out;
}

// ── Managed KB — DEPRECATED, superseded by lib/kb-store.ts ─────────
// Kept only so scripts/kb-migrate.ts can read the old keys during the
// migration soak period. No runtime code writes here anymore. Delete this
// section (and the old jetta:kb:managed:* / jetta:kbdraft:* keys) after soak.
export interface ManagedArticle {
  id: string;
  title: string;
  url: string;
  body: string;
  keywords: string[];
  /** "knowledge-loop" (approved draft) or "manual" (added in the UI). */
  origin: "knowledge-loop" | "manual";
  createdBy: string;
  at: number;
}

const MANAGED_IDS = "jetta:kb:managed:ids";
const managedKey = (id: string) => `jetta:kb:managed:${id}`;
const memManaged = new Map<string, ManagedArticle>();

export async function upsertManagedArticle(a: ManagedArticle): Promise<void> {
  const r = client();
  if (r) {
    await r.set(managedKey(a.id), a);
    await r.sadd(MANAGED_IDS, a.id);
    return;
  }
  memManaged.set(a.id, a);
}

export async function deleteManagedArticle(id: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(managedKey(id));
    await r.srem(MANAGED_IDS, id);
    return;
  }
  memManaged.delete(id);
}

export async function getManagedArticle(id: string): Promise<ManagedArticle | null> {
  const r = client();
  if (r) return await r.get<ManagedArticle>(managedKey(id));
  return memManaged.get(id) ?? null;
}

export async function listManagedArticles(): Promise<ManagedArticle[]> {
  const r = client();
  if (r) {
    const ids = await r.smembers(MANAGED_IDS);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<ManagedArticle>(managedKey(id))));
    return raw.filter((a): a is ManagedArticle => !!a).sort((x, y) => y.at - x.at);
  }
  return [...memManaged.values()].sort((x, y) => y.at - x.at);
}

// ── Pending drafts — DEPRECATED, superseded by lib/kb-store.ts ─────
// (drafts are now articles in "draft" state; read-only for migration)
export interface PendingDraft {
  id: string;
  channel: string;
  threadTs: string;
  title: string;
  body: string;
  keywords: string[];
  createdBy: string;
  at: number;
}

const DRAFT_IDS = "jetta:kbdrafts:ids";
const draftKey = (id: string) => `jetta:kbdraft:${id}`;
const memDrafts = new Map<string, PendingDraft>();

export async function addDraft(d: PendingDraft): Promise<void> {
  const r = client();
  if (r) {
    await r.set(draftKey(d.id), d, { ex: 7 * 86400 });
    await r.sadd(DRAFT_IDS, d.id);
    return;
  }
  memDrafts.set(d.id, d);
}

export async function getDraft(id: string): Promise<PendingDraft | null> {
  const r = client();
  if (r) return await r.get<PendingDraft>(draftKey(id));
  return memDrafts.get(id) ?? null;
}

export async function listDrafts(): Promise<PendingDraft[]> {
  const r = client();
  if (r) {
    const ids = await r.smembers(DRAFT_IDS);
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<PendingDraft>(draftKey(id))));
    // Drop expired (null) ids from the index opportunistically.
    const live: PendingDraft[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (raw[i]) live.push(raw[i]!);
      else await r.srem(DRAFT_IDS, ids[i]);
    }
    return live.sort((a, b) => b.at - a.at);
  }
  return [...memDrafts.values()].sort((a, b) => b.at - a.at);
}

export async function deleteDraft(id: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(draftKey(id));
    await r.srem(DRAFT_IDS, id);
    return;
  }
  memDrafts.delete(id);
}

// ── Detailed run logs (Tier 1 observability) ──────────────────────
export interface RunLog {
  id: string;
  at: number;
  source: "webhook" | "console" | "cron";
  ticketId: string;
  subject?: string;
  channel: string;
  product: string;
  model: string;
  dryRun: boolean;
  blockedByAllowlist: boolean;
  replied: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  reply: string;
  kbHits: { title: string; source: string; score?: number }[];
  trace: { tool: string; input: unknown; result: string }[];
  error?: string;
}

const RUNLOGS_KEY = "jetta:runlogs";
const runLogTicketKey = (ticketId: string) => `jetta:runlog:${ticketId}`;
const memRunLogs: RunLog[] = [];

/** Persist a run log: a global capped feed + a per-ticket history. */
export async function recordRunLog(entry: RunLog): Promise<void> {
  const r = client();
  if (r) {
    await r.lpush(RUNLOGS_KEY, entry);
    await r.ltrim(RUNLOGS_KEY, 0, 499);
    await r.lpush(runLogTicketKey(entry.ticketId), entry);
    await r.ltrim(runLogTicketKey(entry.ticketId), 0, 49);
    return;
  }
  memRunLogs.unshift(entry);
  if (memRunLogs.length > 500) memRunLogs.length = 500;
}

export async function getRunLogs(limit = 100): Promise<RunLog[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<RunLog | string>(RUNLOGS_KEY, 0, limit - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as RunLog) : x));
  }
  return memRunLogs.slice(0, limit);
}

export async function getRunLogsByTicket(ticketId: string, limit = 50): Promise<RunLog[]> {
  const r = client();
  if (r) {
    const raw = await r.lrange<RunLog | string>(runLogTicketKey(ticketId), 0, limit - 1);
    return raw.map((x) => (typeof x === "string" ? (JSON.parse(x) as RunLog) : x));
  }
  return memRunLogs.filter((l) => l.ticketId === ticketId).slice(0, limit);
}
