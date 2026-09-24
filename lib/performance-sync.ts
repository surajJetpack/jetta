/**
 * Keeps the /performance page's data current by reading Freshdesk slowly.
 *
 * The page's numbers need every ticket's full thread (who replied, when, and
 * whether it was Jetta's suggestion) — one Freshdesk call per ticket. This
 * account's API budget is 40 calls a MINUTE, shared with live Jetta: the
 * 2026-09-23 performance review hit 429s after a few dozen parallel reads, and
 * every one of those is a webhook run that could have failed instead. So this
 * never runs on page load. An hourly cron lists what changed since its cursor,
 * queues it, and drains the queue at a fixed pace with a per-run ceiling.
 *
 * Page loads then read ONE key: the precomputed summary. The per-ticket hash
 * is read once per sync (one HGETALL), never per view — see lib/data-version.ts
 * for the Redis quota incident that rule comes from.
 *
 * First run backfills from BASELINE_START; at MAX_PER_RUN tickets an hour a
 * cold store takes most of a day to fill, and the page says how far along it is.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { bumpDataVersion } from "./data-version";
import { markEventSeen, unmarkEventSeen } from "./kv";
import { listConversations } from "./chat-store";
import { fd } from "./tools/freshdesk";
import {
  BASELINE_START,
  buildSummary,
  chatWeeks,
  isJunkSubject,
  summarizeTicket,
  weekStart,
  type PerfConversation,
  type PerfListTicket,
  type PerfTicket,
  type PerformanceSummary,
} from "./performance";

const TICKETS_KEY = "jetta:perf:tickets:v1";
const SUMMARY_KEY = "jetta:perf:summary:v1";
const STATE_KEY = "jetta:perf:state:v1";
const LOCK_ID = "perf-sync-lock";

/** Thread reads per run. At PACE_MS apart this is ~2.5 minutes of a 5-minute function. */
export const MAX_PER_RUN = 60;
/** Gap between Freshdesk reads: ~24/min, leaving live Jetta most of the 40/min budget. */
const PACE_MS = 2500;
/**
 * List pages per run — 100 tickets each, one call per page. A cold store's whole
 * backlog (~1,500 tickets since BASELINE_START) lists in one run; the cursor
 * carries anything beyond to the next.
 */
const MAX_LIST_PAGES = 15;
/** Chats are counted once a day; listing them reads one key per conversation. */
const CHAT_REFRESH_MS = 20 * 3600_000;
/** Records older than this are dropped so the hash cannot grow without bound. */
const RETAIN_DAYS = 400;

export interface PerfSyncState {
  /** Freshdesk updated_at of the newest ticket listed so far. */
  cursor: string;
  /** Tickets listed but not yet read, oldest change first (read from the end). */
  queue: PerfListTicket[];
  lastRunAt: number | null;
  lastError: string | null;
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

// In-memory fallback (single-process only, mirrors kv.ts).
const mem = { tickets: new Map<string, PerfTicket>(), summary: null as PerformanceSummary | null, state: null as PerfSyncState | null };

export async function getPerformanceSummary(): Promise<PerformanceSummary | null> {
  const r = client();
  return r ? await r.get<PerformanceSummary>(SUMMARY_KEY) : mem.summary;
}

export async function getSyncState(): Promise<PerfSyncState> {
  const r = client();
  const s = r ? await r.get<PerfSyncState>(STATE_KEY) : mem.state;
  return s ?? { cursor: BASELINE_START, queue: [], lastRunAt: null, lastError: null };
}

async function saveState(s: PerfSyncState): Promise<void> {
  const r = client();
  if (r) await r.set(STATE_KEY, s);
  else mem.state = s;
}

export async function saveTickets(records: PerfTicket[]): Promise<void> {
  if (!records.length) return;
  const r = client();
  if (r) {
    await r.hset(TICKETS_KEY, Object.fromEntries(records.map((t) => [String(t.id), t])));
    return;
  }
  for (const t of records) mem.tickets.set(String(t.id), t);
}

async function allTickets(): Promise<PerfTicket[]> {
  const r = client();
  if (!r) return [...mem.tickets.values()];
  const raw = (await r.hgetall<Record<string, PerfTicket>>(TICKETS_KEY)) ?? {};
  return Object.values(raw);
}

async function dropTickets(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const r = client();
  if (r) await r.hdel(TICKETS_KEY, ...ids.map(String));
  else for (const id of ids) mem.tickets.delete(String(id));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchThread(ticketId: number): Promise<PerfConversation[]> {
  const all: PerfConversation[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await fd<PerfConversation[]>(`/tickets/${ticketId}/conversations?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function fetchAgents(): Promise<Map<number, string>> {
  const agents = await fd<{ id: number; contact?: { name?: string } }[]>("/agents?per_page=100");
  return new Map(agents.map((a) => [a.id, a.contact?.name ?? `Agent ${a.id}`]));
}

/**
 * Tickets changed since the cursor, oldest change first. Junk (auto-replies,
 * spam) is dropped here so it never costs a thread read.
 */
async function listChanged(cursor: string): Promise<{ tickets: PerfListTicket[]; cursor: string }> {
  const found: PerfListTicket[] = [];
  let next = cursor;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const batch = await fd<PerfListTicket[]>(
      `/tickets?updated_since=${encodeURIComponent(cursor)}&order_by=updated_at&order_type=asc&per_page=100&page=${page}&include=stats`,
    );
    for (const t of batch) {
      if (t.updated_at > next) next = t.updated_at;
      if (t.created_at >= BASELINE_START && !t.spam && !isJunkSubject(t.subject ?? "")) found.push(t);
    }
    if (batch.length < 100) break;
    await sleep(PACE_MS);
  }
  return { tickets: found, cursor: next };
}

export interface SyncResult {
  status: "ok" | "busy" | "error";
  listed: number;
  read: number;
  queued: number;
  tickets: number;
  error?: string;
}

/**
 * One sync step: list what changed, read up to `budget` threads, rebuild the
 * summary. Safe to call from the cron and from the admin "sync now" button —
 * a lock keeps two runs from spending the Freshdesk budget twice.
 */
export async function syncPerformance(budget = MAX_PER_RUN): Promise<SyncResult> {
  if (!(await markEventSeen(LOCK_ID, 290))) {
    return { status: "busy", listed: 0, read: 0, queued: 0, tickets: 0 };
  }
  const state = await getSyncState();
  let listed = 0;
  let read = 0;
  const done: PerfTicket[] = [];
  try {
    const changed = await listChanged(state.cursor);
    listed = changed.tickets.length;
    // A ticket changed again while queued keeps one entry, with its newest stats.
    const queue = new Map(state.queue.map((t) => [t.id, t]));
    for (const t of changed.tickets) queue.set(t.id, t);
    state.cursor = changed.cursor;
    state.queue = [...queue.values()];

    const agents = await fetchAgents();
    const jettaId = config.freshdesk.agentId ? Number(config.freshdesk.agentId) : null;
    // Newest change first: during a backfill the last-28-days headline is what
    // the team reads, so it fills in within hours instead of after the baseline.
    while (state.queue.length && read < budget) {
      const t = state.queue[state.queue.length - 1];
      await sleep(PACE_MS);
      try {
        done.push(summarizeTicket(t, await fetchThread(t.id), agents, jettaId));
      } catch (e) {
        // A deleted or merged-away ticket 404s forever; dropping it keeps one
        // dead id from blocking the head of the queue. Anything else (a 429
        // after retries, an outage) stops the run with the ticket still queued.
        if (!/failed: 404/.test(String(e))) throw e;
      }
      state.queue.pop();
      read++;
    }
    state.lastError = null;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
  }

  try {
    // Saved on the failure path too: the cursor, the queue and every thread
    // already read survive, so the next run resumes instead of starting over.
    await saveTickets(done);
    state.lastRunAt = Date.now();
    await saveState(state);
    const tickets = await rebuildSummary();
    return {
      status: state.lastError ? "error" : "ok",
      listed,
      read,
      queued: state.queue.length,
      tickets,
      ...(state.lastError ? { error: state.lastError } : {}),
    };
  } finally {
    await unmarkEventSeen(LOCK_ID);
  }
}

/** Recompute the page payload from every stored record. Returns the record count. */
export async function rebuildSummary(): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - RETAIN_DAYS * 86_400_000).toISOString();
  const all = await allTickets();
  await dropTickets(all.filter((t) => t.createdAt < cutoff).map((t) => t.id));
  const kept = all.filter((t) => t.createdAt >= cutoff);

  const previous = await getPerformanceSummary();
  let chat = previous?.chat ?? null;
  if (!chat || now - chat.computedAt > CHAT_REFRESH_MS) {
    const convs = await listConversations(300).catch(() => null);
    if (convs) chat = { computedAt: now, weeks: chatWeeks(convs) };
  }

  const summary = buildSummary(kept, now, chat);
  const r = client();
  if (r) await r.set(SUMMARY_KEY, summary);
  else mem.summary = summary;
  await bumpDataVersion("performance");
  return kept.length;
}

/** Exposed for the page footer: how complete the store is. */
export async function syncStatus(): Promise<{ cursor: string; queued: number; lastRunAt: number | null; lastError: string | null; cursorWeek: string }> {
  const s = await getSyncState();
  return {
    cursor: s.cursor,
    queued: s.queue.length,
    lastRunAt: s.lastRunAt,
    lastError: s.lastError,
    cursorWeek: weekStart(s.cursor),
  };
}
