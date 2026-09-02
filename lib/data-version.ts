/**
 * Change markers for the console's synced datasets.
 *
 * The KB is rewritten by a 5am cron, the daily rollup by a 6:10 cron, and both
 * have manual triggers (bulk actions, the Regenerate button, backfill scripts).
 * A console tab left open through any of those keeps showing the world as it
 * was at page load. The obvious fix — poll the data endpoints — is what the
 * Redis quota incident of 2026-08-19 was made of: /api/admin/kb reads every
 * article body and /api/admin/today fans out across three stores, so an open
 * tab would burn thousands of commands an hour showing unchanged data.
 *
 * So writers bump one hash field here (one HSET alongside a write that already
 * happened), and pages poll ONE endpoint costing one HGETALL, re-running their
 * real load only when a watched marker actually moved.
 *
 * Best-effort on purpose: a marker is a hint, not a record. Losing a bump means
 * a page refreshes one poll late (or on the next reload) — never worth failing
 * the write it rode along with.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

const VERSION_KEY = "jetta:data-version";

/**
 * What can be watched. A dataset is a reader's view, not a table: "today"
 * moves with every run outcome because that is what the /today numbers are
 * made from.
 */
export type Dataset = "kb" | "daily" | "today";

// In-memory fallback (single-process only, mirrors kv.ts).
const memVersions: Record<string, number> = {};

/** Mark a dataset as changed. Never throws — see module note. */
export async function bumpDataVersion(dataset: Dataset): Promise<void> {
  const at = Date.now();
  const r = client();
  if (r) {
    await r.hset(VERSION_KEY, { [dataset]: at }).catch(() => {});
    return;
  }
  memVersions[dataset] = at;
}

/** Every marker at once — the poll endpoint's whole read. */
export async function getDataVersions(): Promise<Record<string, number>> {
  const r = client();
  if (!r) return { ...memVersions };
  const raw = (await r.hgetall<Record<string, number | string>>(VERSION_KEY).catch(() => null)) ?? {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Number(v) || 0;
  return out;
}
