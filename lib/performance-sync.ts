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
import { getOutcomes, markEventSeen, unmarkEventSeen } from "./kv";
import { listConversations } from "./chat-store";
import { fd, freshdeskTicketUrl } from "./tools/freshdesk";
import { devItemsByTicket } from "./tools/monday";
import { judgeHandoff } from "./handoff-judge";
import { appProductFromHint, inferAppProduct } from "./context";
import { ticketRecords } from "./topics";
import { buildHealth, healthRows, type HealthRow, type HealthTicket, type SupportHealth } from "./support-health";
import {
  perfRows,
  BASELINE_START,
  JETTA_LIVE_DATE,
  PERF_SCHEMA,
  buildSummary,
  chatWeeks,
  chatWindow,
  isJunkSubject,
  isSettled,
  summarizeTicket,
  weekStart,
  withBoardHandoffs,
  type HandoffOutcome,
  type PerfConversation,
  type PerfListTicket,
  type PerfRow,
  type PerfTicket,
  type PerformanceSummary,
} from "./performance";

const TICKETS_KEY = "jetta:perf:tickets:v1";
const SUMMARY_KEY = "jetta:perf:summary:v1";
/** /health's payload — its own key so the general page never reads the per-agent summary. */
const HEALTH_KEY = "jetta:perf:health:v1";
/** The tickets behind /health's numbers — read only when someone clicks one. */
const HEALTH_ROWS_KEY = "jetta:perf:health:rows:v1";
/** The tickets behind /performance's numbers (admin; carries agent names). */
const PERF_ROWS_KEY = "jetta:perf:rows:v1";
const STATE_KEY = "jetta:perf:state:v1";
/** Handoff verdicts, field per ticket id. Written by the judge step, read once per rebuild. */
const OUTCOMES_KEY = "jetta:perf:handoffs:v1";
/**
 * What the Freshdesk LIST says about each ticket — live status, the app
 * dropdown, updated_at — field per ticket id. Refreshed on every listing,
 * which costs nothing extra, so /health's backlog reads today's status even
 * for a ticket whose thread is still queued.
 */
const META_KEY = "jetta:perf:meta:v1";
/**
 * Jetta's labels for tickets she read — topic and app — copied out of the
 * outcome feed at each rebuild. The feed keeps only the newest 1,000 events
 * (a few weeks), so without this copy a ticket's topic would vanish from
 * /health once it scrolled off.
 */
const LABELS_KEY = "jetta:perf:labels:v1";
const LOCK_ID = "perf-sync-lock";

/** Thread reads per run. At PACE_MS apart this is ~2 minutes of a 5-minute function. */
export const MAX_PER_RUN = 50;
/**
 * Handoffs judged per run. Each costs two Freshdesk reads (thread + opening
 * message), one monday query and one LLM call; the LLM calls run together at
 * the end so they don't hold the Freshdesk pacing up.
 */
const JUDGE_PER_RUN = 6;
/** Stop starting new Freshdesk reads past this point, leaving room for the judge + rebuild. */
const READ_DEADLINE_MS = 170_000;
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

export interface TicketMeta {
  status: number | null;
  updatedAt: string;
  /** Raw cf_product value. */
  product: string | null;
}

interface TicketLabel {
  topic: string | null;
  app: string | null;
}

export interface PerfSyncState {
  /** Freshdesk updated_at of the newest ticket listed so far. */
  cursor: string;
  /** Tickets listed but not yet read, oldest change first (read from the end). */
  queue: PerfListTicket[];
  lastRunAt: number | null;
  lastError: string | null;
  /** PERF_SCHEMA the stored records were written under. Absent = 1. */
  schema?: number;
  /**
   * Tickets with a dev item Jetta filed, from the last board scan — merged into
   * the records at rebuild time (withBoardHandoffs), since the board, not the
   * ticket, is where some of her handoffs are recorded.
   */
  boardHandoffs?: Record<string, { itemIds: string[]; jettaFiledAt: string }>;
  /**
   * The one-time re-list that fills META_KEY for tickets listed before it
   * existed, and re-queues every unresolved one so its record gains
   * `lastPublicFrom`. A ticket updated_at cursor like `cursor`; "done" once caught up.
   */
  metaCursor?: string;
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
const mem = {
  tickets: new Map<string, PerfTicket>(),
  outcomes: new Map<string, HandoffOutcome>(),
  meta: new Map<string, TicketMeta>(),
  labels: new Map<string, TicketLabel>(),
  summary: null as PerformanceSummary | null,
  health: null as SupportHealth | null,
  healthRows: null as HealthRow[] | null,
  perfRows: null as PerfRow[] | null,
  state: null as PerfSyncState | null,
};

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

async function allOutcomes(): Promise<Map<number, HandoffOutcome>> {
  const r = client();
  const raw = r ? ((await r.hgetall<Record<string, HandoffOutcome>>(OUTCOMES_KEY)) ?? {}) : Object.fromEntries(mem.outcomes);
  return new Map(Object.values(raw).map((o) => [o.ticketId, o]));
}

async function saveOutcomes(list: HandoffOutcome[]): Promise<void> {
  if (!list.length) return;
  const r = client();
  if (r) await r.hset(OUTCOMES_KEY, Object.fromEntries(list.map((o) => [String(o.ticketId), o])));
  else for (const o of list) mem.outcomes.set(String(o.ticketId), o);
}

async function saveMeta(listed: PerfListTicket[]): Promise<void> {
  if (!listed.length) return;
  const entries = listed.map((t): [string, TicketMeta] => [
    String(t.id),
    { status: t.status ?? null, updatedAt: t.updated_at, product: t.custom_fields?.cf_product ?? null },
  ]);
  const r = client();
  if (r) await r.hset(META_KEY, Object.fromEntries(entries));
  else for (const [id, m] of entries) mem.meta.set(id, m);
}

async function allMeta(): Promise<Map<string, TicketMeta>> {
  const r = client();
  if (!r) return mem.meta;
  return new Map(Object.entries((await r.hgetall<Record<string, TicketMeta>>(META_KEY)) ?? {}));
}

/**
 * Fold the outcome feed's per-ticket labels into LABELS_KEY. A newer label
 * wins; a missing one never erases an older one. Writes only what changed.
 */
async function refreshLabels(): Promise<Map<string, TicketLabel>> {
  const r = client();
  const stored = r
    ? new Map(Object.entries((await r.hgetall<Record<string, TicketLabel>>(LABELS_KEY)) ?? {}))
    : mem.labels;
  const feed = ticketRecords(await getOutcomes(1000).catch(() => []));
  const changed: Record<string, TicketLabel> = {};
  for (const rec of feed) {
    if (!/^\d+$/.test(rec.ticketId)) continue; // chat conversations carry UUIDs, not ticket ids
    const old = stored.get(rec.ticketId);
    const next: TicketLabel = {
      topic: rec.topic ?? old?.topic ?? null,
      app: rec.app && rec.app !== "unknown" ? rec.app : (old?.app ?? null),
    };
    if (!next.topic && !next.app) continue;
    if (old?.topic === next.topic && old?.app === next.app) continue;
    changed[rec.ticketId] = next;
    stored.set(rec.ticketId, next);
  }
  if (r && Object.keys(changed).length) await r.hset(LABELS_KEY, changed);
  return stored;
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
async function listChanged(
  cursor: string,
  maxPages = MAX_LIST_PAGES,
): Promise<{ tickets: PerfListTicket[]; cursor: string; complete: boolean }> {
  const found: PerfListTicket[] = [];
  let next = cursor;
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fd<PerfListTicket[]>(
      `/tickets?updated_since=${encodeURIComponent(cursor)}&order_by=updated_at&order_type=asc&per_page=100&page=${page}&include=stats`,
    );
    for (const t of batch) {
      if (t.updated_at > next) next = t.updated_at;
      if (t.created_at >= BASELINE_START && !t.spam && !isJunkSubject(t.subject ?? "")) found.push(t);
    }
    if (batch.length < 100) {
      complete = true;
      break;
    }
    await sleep(PACE_MS);
  }
  return { tickets: found, cursor: next, complete };
}

/** Meta re-list pages per run. ~1,500 tickets since BASELINE_START is two runs. */
const META_LIST_PAGES = 8;

export interface SyncResult {
  status: "ok" | "busy" | "error";
  listed: number;
  read: number;
  queued: number;
  tickets: number;
  /** Handoffs given a verdict this run. */
  judged: number;
  error?: string;
}

/**
 * One sync step: list what changed, read up to `budget` threads, rebuild the
 * summary. Safe to call from the cron and from the admin "sync now" button —
 * a lock keeps two runs from spending the Freshdesk budget twice.
 */
export async function syncPerformance(budget = MAX_PER_RUN): Promise<SyncResult> {
  if (!(await markEventSeen(LOCK_ID, 290))) {
    return { status: "busy", listed: 0, read: 0, queued: 0, tickets: 0, judged: 0 };
  }
  const started = Date.now();
  const state = await getSyncState();
  // A store written under an older record shape is re-listed from the start:
  // every ticket is re-queued once and re-read into the new shape.
  if ((state.schema ?? 1) < PERF_SCHEMA) {
    state.cursor = BASELINE_START;
    state.schema = PERF_SCHEMA;
  }
  let listed = 0;
  let read = 0;
  const done: PerfTicket[] = [];
  try {
    const changed = await listChanged(state.cursor);
    listed = changed.tickets.length;
    await saveMeta(changed.tickets);
    // A ticket changed again while queued keeps one entry, with its newest stats.
    const queue = new Map(state.queue.map((t) => [t.id, t]));
    for (const t of changed.tickets) queue.set(t.id, t);
    state.cursor = changed.cursor;

    // One-time: fill meta for tickets listed before it existed, and re-read
    // every unresolved one so /health knows whose turn it is. Resolved
    // tickets don't need that, so their records are left alone.
    if (state.metaCursor !== "done") {
      const relist = await listChanged(state.metaCursor ?? BASELINE_START, META_LIST_PAGES);
      await saveMeta(relist.tickets);
      for (const t of relist.tickets) {
        if (t.status !== 4 && t.status !== 5 && !queue.has(t.id)) queue.set(t.id, t);
      }
      state.metaCursor = relist.complete ? "done" : relist.cursor;
    }
    state.queue = [...queue.values()];

    const agents = await fetchAgents();
    const jettaId = config.freshdesk.agentId ? Number(config.freshdesk.agentId) : null;
    // Newest change first: during a backfill the last-28-days headline is what
    // the team reads, so it fills in within hours instead of after the baseline.
    while (state.queue.length && read < budget && Date.now() - started < READ_DEADLINE_MS) {
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
    const judged = state.lastError ? 0 : await judgeSettledHandoffs(JUDGE_PER_RUN, state).catch((e) => {
      state.lastError = `handoff judge: ${e instanceof Error ? e.message : String(e)}`;
      return 0;
    });
    await saveState(state);
    const tickets = await rebuildSummary();
    return {
      status: state.lastError ? "error" : "ok",
      listed,
      read,
      queued: state.queue.length,
      tickets,
      judged,
      ...(state.lastError ? { error: state.lastError } : {}),
    };
  } finally {
    await unmarkEventSeen(LOCK_ID);
  }
}

/**
 * Give verdicts to handoffs that have an outcome to judge — settled (resolved,
 * closed, or quiet for a week) and not judged since their last activity.
 * Newest handoffs first, so the dashboard's recent numbers fill before history.
 */
async function judgeSettledHandoffs(limit: number, state: PerfSyncState): Promise<number> {
  if (limit <= 0) return 0;
  const now = Date.now();
  const linked = await devItemsByTicket(`${JETTA_LIVE_DATE}T00:00:00Z`).catch(() => null);
  if (linked) {
    state.boardHandoffs = Object.fromEntries(
      [...linked.entries()]
        .filter(([, v]) => v.jettaFiled.length && v.jettaFiledAt)
        .map(([id, v]) => [id, { itemIds: v.itemIds, jettaFiledAt: v.jettaFiledAt! }]),
    );
  }
  const outcomes = await allOutcomes();
  const due = withBoardHandoffs(await allTickets(), state.boardHandoffs ?? {})
    .filter((t) => t.handoff && isSettled(t, now))
    .filter((t) => {
      const o = outcomes.get(t.id);
      return !o || o.basisUpdatedAt < t.updatedAt;
    })
    .sort((a, b) => b.handoff!.at.localeCompare(a.handoff!.at))
    .slice(0, limit);
  if (!due.length) return 0;

  const agents = await fetchAgents();
  const jettaId = config.freshdesk.agentId ? Number(config.freshdesk.agentId) : null;
  // Freshdesk reads stay paced and in sequence; only the LLM calls overlap.
  const inputs: { ticket: PerfTicket; thread: PerfConversation[]; description: string | null }[] = [];
  for (const t of due) {
    await sleep(PACE_MS);
    const thread = await fetchThread(t.id).catch(() => null);
    await sleep(PACE_MS);
    const detail = await fd<{ description_text?: string }>(`/tickets/${t.id}`).catch(() => null);
    if (thread) inputs.push({ ticket: t, thread, description: detail?.description_text ?? null });
  }
  const verdicts = await Promise.all(
    inputs.map((i) =>
      judgeHandoff({ ...i, jettaId, agents, extraItemIds: linked?.get(String(i.ticket.id))?.itemIds }).catch(() => null),
    ),
  );
  const ok = verdicts.filter((v): v is HandoffOutcome => !!v);
  await saveOutcomes(ok);
  return ok.length;
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
  if (!chat || !chat.recent || now - chat.computedAt > CHAT_REFRESH_MS) {
    const convs = await listConversations(300).catch(() => null);
    if (convs) {
      const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
      chat = {
        computedAt: now,
        weeks: chatWeeks(convs),
        recent: chatWindow(convs, iso(28), iso(0)),
        previous: chatWindow(convs, iso(56), iso(28)),
      };
    }
  }

  const { boardHandoffs } = await getSyncState();
  const records = withBoardHandoffs(kept, boardHandoffs ?? {});
  const outcomes = await allOutcomes();
  const [meta, labels] = await Promise.all([allMeta(), refreshLabels()]);
  const summary = {
    ...buildSummary(records, now, chat, outcomes),
    ticketUrlBase: freshdeskTicketUrl("").replace(/\/$/, "/"),
  };
  const healthTickets = records.map((t) => healthTicket(t, meta, labels));
  const health = buildHealth(healthTickets, outcomes, chatForHealth(chat), now);
  const rows = healthRows(healthTickets, outcomes, now);
  const pRows = perfRows(healthTickets, outcomes, now);
  const r = client();
  if (r) {
    await Promise.all([
      r.set(SUMMARY_KEY, summary),
      r.set(HEALTH_KEY, health),
      r.set(HEALTH_ROWS_KEY, rows),
      r.set(PERF_ROWS_KEY, pRows),
    ]);
  } else {
    mem.summary = summary;
    mem.health = health;
    mem.healthRows = rows;
    mem.perfRows = pRows;
  }
  await bumpDataVersion("performance");
  return kept.length;
}

/**
 * A record joined with what it needs for /health. The live status is the
 * list's when the list has seen a newer version of the ticket than the thread
 * read did. App precedence matches lib/context.ts — the cf_product dropdown,
 * then Jetta's label (which already applied keywords + triage to the whole
 * message), then keywords on the subject.
 */
export function healthTicket(t: PerfTicket, meta: Map<string, TicketMeta>, labels: Map<string, TicketLabel>): HealthTicket {
  const m = meta.get(String(t.id));
  const label = labels.get(String(t.id));
  const status = m && m.updatedAt >= t.updatedAt ? m.status : (t.status ?? m?.status ?? null);
  const fromSubject = inferAppProduct(t.subject ?? "");
  const app =
    appProductFromHint(m?.product) ??
    label?.app ??
    (fromSubject !== "unknown" ? fromSubject : "unknown");
  return { ...t, status, app, topic: label?.topic ?? null };
}

function chatForHealth(chat: PerformanceSummary["chat"]): SupportHealth["chat"] {
  return chat?.recent && chat.previous ? { recent: chat.recent, previous: chat.previous } : null;
}

/** The /health payload. One GET. */
export async function getSupportHealth(): Promise<SupportHealth | null> {
  const r = client();
  return r ? await r.get<SupportHealth>(HEALTH_KEY) : mem.health;
}

/** The tickets behind /health's numbers, as of the last rebuild. */
export async function getSupportHealthRows(): Promise<HealthRow[] | null> {
  const r = client();
  return r ? await r.get<HealthRow[]>(HEALTH_ROWS_KEY) : mem.healthRows;
}

/** The tickets behind /performance's numbers. Admin only — rows carry agent names. */
export async function getPerformanceRows(): Promise<PerfRow[] | null> {
  const r = client();
  return r ? await r.get<PerfRow[]>(PERF_ROWS_KEY) : mem.perfRows;
}

/**
 * The AI read on /health, cached against the payload it was written from.
 * One entry: a newer payload makes it stale, and the route rewrites it.
 */
const HEALTH_INSIGHT_KEY = "jetta:perf:health:insight:v1";
let memHealthInsight: unknown = null;

export async function getHealthInsight<T>(): Promise<T | null> {
  const r = client();
  return r ? await r.get<T>(HEALTH_INSIGHT_KEY) : (memHealthInsight as T | null);
}

export async function saveHealthInsight(insight: unknown): Promise<void> {
  const r = client();
  if (r) await r.set(HEALTH_INSIGHT_KEY, insight, { ex: 7 * 86_400 });
  else memHealthInsight = insight;
}

/** The AI read on /performance — same shape and cache rule as /health's. Admin only. */
const PERF_INSIGHT_KEY = "jetta:perf:insight:v1";
let memPerfInsight: unknown = null;

export async function getPerformanceInsight<T>(): Promise<T | null> {
  const r = client();
  return r ? await r.get<T>(PERF_INSIGHT_KEY) : (memPerfInsight as T | null);
}

export async function savePerformanceInsight(insight: unknown): Promise<void> {
  const r = client();
  if (r) await r.set(PERF_INSIGHT_KEY, insight, { ex: 7 * 86_400 });
  else memPerfInsight = insight;
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
