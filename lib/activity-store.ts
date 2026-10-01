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
  /** "push" = the source tells us as it happens and this read is the daily net; "poll" = read hourly. */
  mode?: "push" | "poll";
  /** Last pushed event from this source (unix ms). */
  pushAt?: number;
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
  /** Slack channel id → name, so a pushed message costs no conversations.info. */
  slackChannelNames?: Record<string, string>;
  /** Our monday webhooks, per board — registered once from the page. */
  mondayWebhooks?: Record<string, string[]>;
  /** monday board id → name, for webhook rows. */
  mondayBoards?: Record<string, string>;
  /** Last full read of each polled source (unix ms) — the daily safety net's clock. */
  lastFullRead?: Partial<Record<"slack" | "monday", number>>;
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

// ── Push support ────────────────────────────────────────────────────

const JETTA_POSTS_KEY = "jetta:activity:jetta-posts:v1";
const answeredKey = (channel: string, threadTs: string) => `jetta:activity:answered:${channel}:${threadTs}`;
const PUSH_KEY = "jetta:activity:push:v1";
const MONDAY_USERS_KEY = "jetta:activity:monday-users:v1";
const memPosts = new Map<string, JettaPost>();
const memAnswered = new Set<string>();
const memPush: Record<string, number> = {};
let memMondayUsers: Record<string, string> = {};

export interface JettaPost {
  /** Unix ms she posted it. */
  at: number;
  topic?: string;
  ticketId?: string;
}

/**
 * Jetta remembers her own top-level Slack posts as she makes them. A pushed
 * reply is then known to be under one of hers — and how long it sat — with no
 * Slack call. Pruned by age in the daily sync.
 */
export async function recordJettaPost(channelId: string, ts: string, post: JettaPost): Promise<void> {
  try {
    const r = client();
    if (r) await r.hset(JETTA_POSTS_KEY, { [`${channelId}:${ts}`]: JSON.stringify(post) });
    else memPosts.set(`${channelId}:${ts}`, post);
  } catch {
    // An observer; never break a Slack post.
  }
}

export async function getJettaPost(channelId: string, ts: string): Promise<JettaPost | null> {
  const r = client();
  if (!r) return memPosts.get(`${channelId}:${ts}`) ?? null;
  const v = await r.hget<JettaPost | string>(JETTA_POSTS_KEY, `${channelId}:${ts}`).catch(() => null);
  if (!v) return null;
  return typeof v === "string" ? (JSON.parse(v) as JettaPost) : v;
}

export async function pruneJettaPosts(olderThanMs: number): Promise<void> {
  const r = client();
  if (!r) return;
  const all = (await r.hgetall<Record<string, JettaPost | string>>(JETTA_POSTS_KEY).catch(() => null)) ?? {};
  const old = Object.entries(all)
    .filter(([, v]) => (typeof v === "string" ? (JSON.parse(v) as JettaPost) : v).at < olderThanMs)
    .map(([k]) => k);
  if (old.length) await r.hdel(JETTA_POSTS_KEY, ...old);
}

/** True for the first person to reply in a thread — the reply that ends the wait. */
export async function claimFirstReply(channel: string, threadTs: string): Promise<boolean> {
  const r = client();
  if (!r) {
    const k = answeredKey(channel, threadTs);
    if (memAnswered.has(k)) return false;
    memAnswered.add(k);
    return true;
  }
  const res = await r.set(answeredKey(channel, threadTs), "1", { nx: true, ex: 90 * 86400 }).catch(() => null);
  return res === "OK";
}

/** Note that a source just pushed something — how the sync knows push works. */
export async function markPush(source: "slack" | "monday"): Promise<void> {
  const r = client();
  if (r) await r.hset(PUSH_KEY, { [source]: Date.now() }).catch(() => {});
  else memPush[source] = Date.now();
}

export async function getPushTimes(): Promise<Partial<Record<"slack" | "monday", number>>> {
  const r = client();
  if (!r) return { ...memPush };
  const raw = (await r.hgetall<Record<string, number | string>>(PUSH_KEY).catch(() => null)) ?? {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
}

/** monday user id → name, refreshed by the daily sync; a webhook from someone new adds them. */
export async function getMondayUsers(): Promise<Map<string, string>> {
  const r = client();
  const raw = r ? ((await r.hgetall<Record<string, string>>(MONDAY_USERS_KEY).catch(() => null)) ?? {}) : memMondayUsers;
  return new Map(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

export async function saveMondayUsers(users: Map<string, string>): Promise<void> {
  if (!users.size) return;
  const obj = Object.fromEntries(users);
  const r = client();
  if (r) await r.hset(MONDAY_USERS_KEY, obj);
  else memMondayUsers = { ...memMondayUsers, ...obj };
}
