/**
 * Storage for lib/activity.ts — the durable record of what people did.
 *
 *   jetta:activity:items:v1   hash  id → Activity
 *   jetta:activity:at:v1      zset  id scored by `at` (ms)
 *   jetta:activity:slack:v1   hash  Slack user id → display name
 *   jetta:activity:state:v1   the activity sync's cursors and last-run report
 *
 * Ids are deterministic per source, so a source read twice writes the same
 * rows twice and nothing is double-counted. Rows older than RETAIN_DAYS are
 * pruned by the sync.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { bumpDataVersion } from "./data-version";
import type { Activity, Place } from "./activity";

const ITEMS_KEY = "jetta:activity:items:v1";
const AT_KEY = "jetta:activity:at:v1";
const SLACK_NAMES_KEY = "jetta:activity:slack:v1";
const STATE_KEY = "jetta:activity:state:v1";

/** Longer than the page's widest window, short enough that the hash stays small. */
export const RETAIN_DAYS = 120;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

const mem = {
  items: new Map<string, Activity>(),
  slack: {} as Record<string, string>,
  state: null as ActivitySyncState | null,
};

/** Write rows. Never throws: activity is an observer and must not break the thing it watches. */
export async function recordActivities(acts: Activity[], opts: { bump?: boolean } = {}): Promise<void> {
  if (!acts.length) return;
  try {
    const r = client();
    if (r) {
      for (let i = 0; i < acts.length; i += 200) {
        const chunk = acts.slice(i, i + 200);
        const p = r.pipeline();
        p.hset(ITEMS_KEY, Object.fromEntries(chunk.map((a) => [a.id, JSON.stringify(a)])));
        const [first, ...rest] = chunk.map((a) => ({ score: a.at, member: a.id }));
        p.zadd(AT_KEY, first, ...rest);
        await p.exec();
      }
    } else {
      for (const a of acts) mem.items.set(a.id, a);
    }
    if (opts.bump ?? true) await bumpDataVersion("activity");
  } catch (e) {
    console.warn(`activity: write failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Every row at or after `sinceMs`, oldest first. */
export async function loadActivities(sinceMs: number): Promise<Activity[]> {
  const r = client();
  if (!r) return [...mem.items.values()].filter((a) => a.at >= sinceMs).sort((a, b) => a.at - b.at);
  const ids = await r.zrange<string[]>(AT_KEY, sinceMs, "+inf", { byScore: true });
  const out: Activity[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (!chunk.length) continue;
    const got = await r.hmget<Record<string, Activity | string>>(ITEMS_KEY, ...chunk);
    for (const id of chunk) {
      const v = got?.[id];
      if (v) out.push(typeof v === "string" ? (JSON.parse(v) as Activity) : v);
    }
  }
  return out;
}

/** Drop rows past retention. Returns how many went. */
export async function pruneActivities(): Promise<number> {
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
  const r = client();
  if (!r) {
    let n = 0;
    for (const [id, a] of mem.items) if (a.at < cutoff && mem.items.delete(id)) n++;
    return n;
  }
  const old = await r.zrange<string[]>(AT_KEY, "-inf", cutoff, { byScore: true });
  for (let i = 0; i < old.length; i += 500) {
    const chunk = old.slice(i, i + 500);
    await r.hdel(ITEMS_KEY, ...chunk);
    await r.zrem(AT_KEY, ...chunk);
  }
  return old.length;
}

export async function getSlackNames(): Promise<Record<string, string>> {
  const r = client();
  if (!r) return { ...mem.slack };
  return (await r.hgetall<Record<string, string>>(SLACK_NAMES_KEY).catch(() => null)) ?? {};
}

export async function saveSlackNames(names: Record<string, string>): Promise<void> {
  if (!Object.keys(names).length) return;
  const r = client();
  if (r) await r.hset(SLACK_NAMES_KEY, names);
  else Object.assign(mem.slack, names);
}

export interface SourceReport {
  /** Unix ms of the last attempt. */
  at: number;
  ok: boolean;
  /** Rows written by that attempt. */
  added: number;
  /** Why this source is not reporting, in words someone can act on. */
  problem?: string;
}

export interface ActivitySyncState {
  /** Newest KB audit entry already imported (unix SECONDS, the audit's unit). */
  kbAt?: number;
  /** Per Slack channel: the newest thread activity already read (Slack ts). */
  slack?: Record<string, string>;
  /** ISO time the monday activity log was last read up to. */
  mondayFrom?: string;
  /**
   * The monday user Jetta acts as. Her own item creations and context posts are
   * that user's, so the user is left out of monday activity — and named on the
   * page, in case it is also a person's own account.
   */
  mondaySelf?: { id: string; name: string };
  /** The one-time copy of human events already in the ops log is done. */
  eventsImported?: boolean;
  lastRunAt?: number;
  sources?: Partial<Record<Exclude<Place, "freshdesk" | "chat"> | "kb" | "events", SourceReport>>;
}

export async function getActivityState(): Promise<ActivitySyncState> {
  const r = client();
  if (!r) return mem.state ?? {};
  return (await r.get<ActivitySyncState>(STATE_KEY).catch(() => null)) ?? {};
}

export async function saveActivityState(s: ActivitySyncState): Promise<void> {
  const r = client();
  if (r) await r.set(STATE_KEY, s);
  else mem.state = s;
}
