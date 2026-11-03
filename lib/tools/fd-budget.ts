/**
 * Shared view of the Freshdesk API budget.
 *
 * The account allows 40 calls/minute (measured 2026-11-03: `x-ratelimit-total:
 * 40`), shared by EVERY caller — webhook runs, first-response, follow-ups,
 * performance sync, the console. Freshdesk tells us what is left on every
 * response (`x-ratelimit-remaining`), so the cheapest budget guard is to keep
 * the latest reading where every function instance can see it.
 *
 * Customer-facing paths never wait on this. Background work (the ticket mirror
 * sync and backfill) calls `waitForHeadroom` first and yields when the minute
 * is nearly spent, so a webhook arriving mid-backfill is never the one that 429s.
 */
import { kvGet, kvSet } from "../kv";

const KEY = "jetta:fd:ratelimit";
/** Freshdesk's window is one minute; an older reading says nothing about now. */
const READING_TTL_MS = 60_000;
/** Throttle KV writes: one per instance every few seconds is plenty. */
const WRITE_EVERY_MS = 3_000;

export interface FdBudgetReading {
  remaining: number;
  total: number;
  at: number;
}

let latest: FdBudgetReading | null = null;
let lastWrite = 0;

/** Called by `fd()` on every response. Never throws. */
export function recordFdBudget(headers: Headers): void {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const total = Number(headers.get("x-ratelimit-total"));
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return;
  latest = { remaining, total, at: Date.now() };
  if (latest.at - lastWrite < WRITE_EVERY_MS) return;
  lastWrite = latest.at;
  // Expire with the window so a stale reading can't block anyone.
  void kvSet(KEY, JSON.stringify(latest), 60).catch(() => {});
}

/** The freshest reading across instances, or null if nothing recent. */
export async function readFdBudget(): Promise<FdBudgetReading | null> {
  let best = latest;
  try {
    const raw = await kvGet(KEY);
    if (raw) {
      const shared = JSON.parse(raw) as FdBudgetReading;
      if (!best || shared.at > best.at) best = shared;
    }
  } catch {
    // KV trouble is not a reason to stop work — fall back to the local reading.
  }
  return best && Date.now() - best.at < READING_TTL_MS ? best : null;
}

/**
 * Wait until at least `reserve` calls remain in the current minute (or the
 * reading is stale, which means the window has rolled). Returns false if that
 * did not happen within `maxWaitMs` — the caller should stop for this run.
 */
export async function waitForHeadroom(reserve = 15, maxWaitMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const r = await readFdBudget();
    if (!r || r.remaining >= reserve) return true;
    // The window resets on the minute boundary of the first call; we can't see
    // it, so wait out a slice of it and look again.
    const wait = Math.min(10_000, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return false;
    await new Promise((res) => setTimeout(res, wait));
  }
}
