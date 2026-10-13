/**
 * Keeps /dev-board current: reads both monday dev boards, mines new
 * conversations, and precomputes the page's one summary key.
 *
 * Hourly cron plus a "Sync now" button. monday is cheap to read (a full run
 * measured 2026-10-13: ~17 s for items + logs, ~25 s for every comment on 450
 * items), and comments are re-read only for items whose updated_at moved, so a
 * steady-state run is a handful of calls. The expensive part is the miner —
 * one judge call per item — so it runs MINE_PER_RUN at a time, newest first;
 * a cold store backfills over a day of runs and the page says how far along.
 *
 * Page loads read ONE key (the summary); the item rows behind the numbers are
 * a second key, fetched on the first click. See lib/data-version.ts for why.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { bumpDataVersion } from "./data-version";
import { markEventSeen, unmarkEventSeen } from "./kv";
import { readBoards, readPosts } from "./dev-board-read";
import { mineItem } from "./dev-board-mine";
import {
  appOf,
  buildSummary,
  canonicalNames,
  devRow,
  parseSupport,
  threadHash,
  threadText,
  wantsMining,
  type DevBoardSummary,
  type DevItem,
  type DevRow,
  type MinedItem,
  type Roster,
  type StatusChange,
} from "./dev-board";

const ITEMS_KEY = "jetta:devboard:items:v1";
const MINED_KEY = "jetta:devboard:mined:v1";
const SUMMARY_KEY = "jetta:devboard:summary:v1";
const ROWS_KEY = "jetta:devboard:rows:v1";
const STATE_KEY = "jetta:devboard:state:v1";
const INSIGHT_KEY = "jetta:devboard:insight:v1";
const LOCK_ID = "devboard-sync-lock";

/** Items touched within this many days are read (plus every open item, however old). */
const WINDOW_DAYS = 120;
/** Judge calls per run, run 4 at a time. */
export const MINE_PER_RUN = 24;
const MINE_PARALLEL = 4;
/** Stop starting mining batches past this point. */
const MINE_DEADLINE_MS = 200_000;
/** An open item's thread is re-mined at most this often, however chatty it is. */
const REMINE_OPEN_MS = 24 * 3600_000;

export interface DevBoardSyncState {
  lastRunAt: number | null;
  lastError: string | null;
  /** The activity log is read from here on the next run (with overlap). */
  changesFrom: string | null;
  lastDurationMs?: number;
  self?: string;
  boards?: Record<string, string>;
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
// Single-process fallback for local runs without KV.
const mem = new Map<string, unknown>();

async function getJson<T>(key: string): Promise<T | null> {
  const r = client();
  if (!r) return (mem.get(key) as T) ?? null;
  return (await r.get<T>(key)) ?? null;
}
async function setJson(key: string, value: unknown): Promise<void> {
  const r = client();
  if (!r) return void mem.set(key, value);
  await r.set(key, value);
}
async function hashAll<T>(key: string): Promise<Map<string, T>> {
  const r = client();
  if (!r) return new Map(Object.entries((mem.get(key) as Record<string, T>) ?? {}));
  const raw = (await r.hgetall<Record<string, T>>(key)) ?? {};
  return new Map(Object.entries(raw));
}
async function hashSet(key: string, values: Record<string, unknown>): Promise<void> {
  if (!Object.keys(values).length) return;
  const r = client();
  if (!r) return void mem.set(key, { ...((mem.get(key) as object) ?? {}), ...values });
  // Upstash caps a request body; items carry their comments, so write in slices.
  const entries = Object.entries(values);
  for (let i = 0; i < entries.length; i += 20) await r.hset(key, Object.fromEntries(entries.slice(i, i + 20)));
}
async function hashDel(key: string, fields: string[]): Promise<void> {
  if (!fields.length) return;
  const r = client();
  if (!r) {
    const cur = { ...((mem.get(key) as Record<string, unknown>) ?? {}) };
    for (const f of fields) delete cur[f];
    return void mem.set(key, cur);
  }
  await r.hdel(key, ...fields);
}

export const getDevBoardSummary = () => getJson<DevBoardSummary>(SUMMARY_KEY);
export const getDevBoardRows = () => getJson<DevRow[]>(ROWS_KEY);
export const getDevBoardState = async () =>
  (await getJson<DevBoardSyncState>(STATE_KEY)) ?? { lastRunAt: null, lastError: null, changesFrom: null };
export const getDevBoardInsight = <T>() => getJson<T>(INSIGHT_KEY);
export const saveDevBoardInsight = (insight: unknown) => setJson(INSIGHT_KEY, insight);
export async function getDevItem(id: string): Promise<DevItem | null> {
  const r = client();
  if (!r) return ((mem.get(ITEMS_KEY) as Record<string, DevItem>) ?? {})[id] ?? null;
  return (await r.hget<DevItem>(ITEMS_KEY, id)) ?? null;
}
export async function getMined(id: string): Promise<MinedItem | null> {
  const r = client();
  if (!r) return ((mem.get(MINED_KEY) as Record<string, MinedItem>) ?? {})[id] ?? null;
  return (await r.hget<MinedItem>(MINED_KEY, id)) ?? null;
}
export async function saveMined(id: string, m: MinedItem): Promise<void> {
  await hashSet(MINED_KEY, { [id]: m });
}

export function rosterFor(self: string): Roster {
  return { support: parseSupport(config.devBoardSupport), self };
}

/** Every name the items carry, once per occurrence — canonicalNames counts them. */
export function namesOf(items: DevItem[]): Map<string, string> {
  return canonicalNames(
    items.flatMap((i) =>
      [i.creator, ...i.developers, ...i.reviewers, ...i.posts.map((p) => p.who), ...i.changes.map((c) => c.by)].filter(
        (n): n is string => !!n,
      ),
    ),
  );
}

const changeKey = (c: StatusChange) => `${c.at}|${c.kind}|${c.to}`;

export interface DevBoardSyncResult {
  status: "ok" | "busy" | "error";
  items?: number;
  postsRead?: number;
  mined?: number;
  minePending?: number;
  ms?: number;
  error?: string;
}

/** One sync: read, mine up to `mineBudget`, rebuild. Locked, so a cron and a click can't overlap. */
export async function syncDevBoard(mineBudget = MINE_PER_RUN): Promise<DevBoardSyncResult> {
  if (!(await markEventSeen(LOCK_ID, 290))) return { status: "busy" };
  const started = Date.now();
  const state = await getDevBoardState();
  try {
    const since = started - WINDOW_DAYS * 86_400_000;
    // Overlap the log read: monday's log can land a little after the action.
    const changesFrom = state.changesFrom
      ? new Date(Date.parse(state.changesFrom) - 30 * 60_000).toISOString()
      : new Date(since).toISOString();
    const [read, stored] = await Promise.all([readBoards(since, changesFrom), hashAll<DevItem>(ITEMS_KEY)]);

    // Comments: only for items new to us or whose updated_at moved.
    const stale = read.items.filter((i) => stored.get(i.id)?.updatedAt !== i.updatedAt).map((i) => i.id);
    const posts = await readPosts(stale);

    const items: DevItem[] = read.items.map((i) => {
      const prev = stored.get(i.id);
      const merged = new Map<string, StatusChange>();
      for (const c of [...(prev?.changes ?? []), ...(read.changes.get(i.id) ?? [])]) merged.set(changeKey(c), c);
      return {
        ...i,
        posts: posts.get(i.id) ?? prev?.posts ?? [],
        changes: [...merged.values()].sort((a, b) => a.at - b.at),
      };
    });
    const changed: Record<string, DevItem> = {};
    for (const it of items) {
      const prev = stored.get(it.id);
      if (!prev || prev.updatedAt !== it.updatedAt || prev.changes.length !== it.changes.length || prev.group !== it.group) {
        changed[it.id] = it;
      }
    }
    await hashSet(ITEMS_KEY, changed);
    const seen = new Set(items.map((i) => i.id));
    const gone = [...stored.keys()].filter((id) => !seen.has(id));
    await hashDel(ITEMS_KEY, gone);

    const roster = rosterFor(read.self);
    const names = namesOf(items);
    const mined = await hashAll<MinedItem>(MINED_KEY);
    await hashDel(MINED_KEY, [...mined.keys()].filter((id) => !seen.has(id)));

    // Mining queue: client issues with a conversation whose thread moved, newest first.
    const rows0 = items.map((i) => ({ item: i, row: devRow(i, roster, names, mined.get(i.id) ?? null) }));
    const queue = rows0
      .filter(({ item, row }) => {
        if (!wantsMining(row)) return false;
        const m = mined.get(item.id);
        if (!m) return true;
        if (m.hash === threadHash(item)) return false;
        // Open threads churn; read them again at most daily. A finished one, always.
        return !row.move || started - m.at > REMINE_OPEN_MS;
      })
      .sort((a, b) => b.item.updatedAt - a.item.updatedAt);

    const areasByApp = new Map<string, Set<string>>();
    for (const { item } of rows0) {
      const m = mined.get(item.id);
      if (!m?.area) continue;
      const app = appOf(item, m);
      areasByApp.set(app, (areasByApp.get(app) ?? new Set()).add(m.area));
    }

    let minedNow = 0;
    const todo = queue.slice(0, mineBudget);
    for (let i = 0; i < todo.length && Date.now() - started < MINE_DEADLINE_MS; i += MINE_PARALLEL) {
      const batch = todo.slice(i, i + MINE_PARALLEL);
      const results = await Promise.all(
        batch.map(async ({ item }) => {
          const app = appOf(item, mined.get(item.id));
          try {
            const m = await mineItem({
              itemId: item.id,
              thread: threadText(item, roster, names),
              knownAreas: [...(areasByApp.get(app) ?? [])].slice(0, 40),
              hash: threadHash(item),
            });
            // A draft someone already made from this item stays linked.
            const prev = mined.get(item.id);
            if (prev?.kbDraftId) m.kbDraftId = prev.kbDraftId;
            return [item.id, m] as const;
          } catch (e) {
            console.error(`[dev-board] mine ${item.id}:`, e instanceof Error ? e.message : e);
            return null;
          }
        }),
      );
      const ok = results.filter((r): r is readonly [string, MinedItem] => !!r);
      for (const [id, m] of ok) {
        mined.set(id, m);
        const app = appOf(items.find((x) => x.id === id)!, m);
        areasByApp.set(app, (areasByApp.get(app) ?? new Set()).add(m.area));
      }
      await hashSet(MINED_KEY, Object.fromEntries(ok));
      minedNow += ok.length;
    }

    const rows = items.map((i) => devRow(i, roster, names, mined.get(i.id) ?? null));
    const minePending = Math.max(0, queue.length - minedNow);
    const summary = buildSummary(rows, { now: Date.now(), minedPending: minePending, boards: read.boardNames });
    await Promise.all([setJson(SUMMARY_KEY, summary), setJson(ROWS_KEY, rows)]);
    const ms = Date.now() - started;
    await setJson(STATE_KEY, {
      lastRunAt: Date.now(),
      lastError: null,
      changesFrom: new Date(started).toISOString(),
      lastDurationMs: ms,
      self: read.self,
      boards: read.boardNames,
    } satisfies DevBoardSyncState);
    await bumpDataVersion("devboard");
    return { status: "ok", items: items.length, postsRead: stale.length, mined: minedNow, minePending, ms };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await setJson(STATE_KEY, { ...state, lastRunAt: Date.now(), lastError: error }).catch(() => {});
    return { status: "error", error, ms: Date.now() - started };
  } finally {
    await unmarkEventSeen(LOCK_ID);
  }
}

/**
 * Recompute rows + summary from the store after a mined record changed (a KB
 * draft was made) — no monday reads.
 */
export async function rebuildDevBoard(): Promise<void> {
  const state = await getDevBoardState();
  if (!state.self) return;
  const [stored, mined] = await Promise.all([hashAll<DevItem>(ITEMS_KEY), hashAll<MinedItem>(MINED_KEY)]);
  const items = [...stored.values()];
  const roster = rosterFor(state.self);
  const names = namesOf(items);
  const rows = items.map((i) => devRow(i, roster, names, mined.get(i.id) ?? null));
  const prev = await getDevBoardSummary();
  const summary = buildSummary(rows, { now: Date.now(), minedPending: prev?.mined.pending ?? 0, boards: state.boards ?? {} });
  await Promise.all([setJson(SUMMARY_KEY, summary), setJson(ROWS_KEY, rows)]);
  await bumpDataVersion("devboard");
}
