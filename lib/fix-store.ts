/**
 * What the GetSign team has fixed lately: Jetta's memory of the changes the
 * release watcher reads (lib/release-watch.ts), kept so a ticket can be
 * checked against them when it arrives (lib/fix-lookup.ts).
 *
 * One record per fix, keyed by its branch name, which is what ties the
 * board-view half of a change to the backend half. A fix is "merged" once it
 * is in `dev` and "released" once a production release carries it. Released
 * never goes back to merged.
 *
 * A Redis hash, a few hundred records at most, read whole. Not the vector
 * index: that has no namespaces, most of its callers query it unfiltered, and
 * a re-ingest wipes it.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

const KEY = "jetta:fixes:v1";
/** Older than this and a fix is no longer news to anyone. */
export const FIX_KEEP_DAYS = 120;
const DAY_MS = 24 * 3600 * 1000;

export interface ShippedFix {
  /** The branch name, lowercased. */
  key: string;
  title: string;
  /** One plain sentence on what changed for the customer. */
  summary: string;
  /** The developers' own description, trimmed. */
  body: string;
  customerVisible: boolean;
  prs: { repo: string; number: number; url: string }[];
  state: "merged" | "released";
  /** When it first reached `dev` (or production, for a hotfix). ISO. */
  mergedAt: string;
  /** When a production release carried it. ISO. */
  releasedAt?: string;
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, ShippedFix>();

async function readAll(): Promise<Map<string, ShippedFix>> {
  const r = client();
  if (!r) return new Map(mem);
  const raw = (await r.hgetall<Record<string, ShippedFix>>(KEY)) ?? {};
  return new Map(Object.entries(raw));
}

/** Every fix on record, newest first. Empty when the store is unreadable: a lookup must never stop a reply. */
export async function listFixes(): Promise<ShippedFix[]> {
  try {
    const at = (f: ShippedFix) => f.releasedAt ?? f.mergedAt;
    return [...(await readAll()).values()].sort((a, b) => at(b).localeCompare(at(a)));
  } catch (e) {
    console.warn("fix-store: could not read the fixes:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** The stored record for a branch, so a fix labelled when it merged is not labelled again when it ships. */
export async function getFix(key: string): Promise<ShippedFix | null> {
  const r = client();
  if (!r) return mem.get(key) ?? null;
  return (await r.hget<ShippedFix>(KEY, key)) ?? null;
}

/**
 * Two records for the same branch become one. Pure.
 *
 * The pull requests are pooled (the backend half can merge a day after the
 * board-view half), released wins over merged, and the earliest merge and the
 * earliest release are kept: a fix carried again by a later release shipped
 * when it first shipped.
 */
export function mergeFix(old: ShippedFix | null | undefined, next: ShippedFix): ShippedFix {
  if (!old) return next;
  const prs = [...old.prs];
  for (const p of next.prs) if (!prs.some((x) => x.repo === p.repo && x.number === p.number)) prs.push(p);
  const released = [old.releasedAt, next.releasedAt].filter((x): x is string => !!x).sort()[0];
  return {
    ...old,
    // A label is kept once given; only an empty one is filled in.
    summary: old.summary || next.summary,
    body: old.body || next.body,
    prs,
    state: released ? "released" : "merged",
    mergedAt: old.mergedAt < next.mergedAt ? old.mergedAt : next.mergedAt,
    ...(released ? { releasedAt: released } : {}),
  };
}

/** Add or update fixes, and drop the ones too old to matter. Returns how many records were written. */
export async function saveFixes(fixes: ShippedFix[], now = new Date()): Promise<number> {
  if (!fixes.length) return 0;
  const all = await readAll();
  const cutoff = new Date(now.getTime() - FIX_KEEP_DAYS * DAY_MS).toISOString();
  const write: Record<string, ShippedFix> = {};
  for (const f of fixes) {
    const merged = mergeFix(write[f.key] ?? all.get(f.key), f);
    if ((merged.releasedAt ?? merged.mergedAt) >= cutoff) write[f.key] = merged;
  }
  const stale = [...all.values()].filter((f) => (f.releasedAt ?? f.mergedAt) < cutoff).map((f) => f.key);
  const r = client();
  if (!r) {
    for (const [k, v] of Object.entries(write)) mem.set(k, v);
    for (const k of stale) mem.delete(k);
    return Object.keys(write).length;
  }
  // Upstash caps a request's size; a seed is a hundred records with bodies.
  const entries = Object.entries(write);
  for (let i = 0; i < entries.length; i += 20) await r.hset(KEY, Object.fromEntries(entries.slice(i, i + 20)));
  if (stale.length) await r.hdel(KEY, ...stale);
  return entries.length;
}

/** For tests: forget everything. Memory store only; a real store is never cleared from code. */
export function clearFixesForTest(): void {
  mem.clear();
}
