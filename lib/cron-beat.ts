/**
 * Cron heartbeats: did each scheduled job actually run, and did it succeed?
 *
 * The crons log inconsistently (some write `cron.x_run`, some only log
 * failures, one logs nothing), and the ops event list is capped at 5,000 rows,
 * so "when did the follow-up cron last run?" had no answer anywhere. Every cron
 * route is wrapped in `withCronBeat`, which keeps one small record per cron:
 * when it last ran, how it ended, how long it took, when it last succeeded and
 * how many runs in a row have failed. The self-review reads these to say which
 * job is late or failing (lib/self-review/reliability.ts).
 *
 * An unauthorized hit (401) is not a run and is not recorded, nor is a manual
 * `?dry=1` call. Recording is best effort: a Redis blip never fails the cron.
 */
import type { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import { config } from "./config";

const BEATS_KEY = "jetta:cron:beats:v1";

export interface CronBeat {
  /** Unix ms the latest run started. */
  at: number;
  ms: number;
  /** HTTP status the route answered, or 0 when it threw. */
  status: number;
  /** Unix ms of the latest run that ended below 400. */
  okAt?: number;
  /** Failed runs in a row, 0 after a success. */
  failStreak: number;
  /** The latest failure's message or status, kept until the next success. */
  lastError?: string;
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, CronBeat>();

async function recordBeat(name: string, at: number, ms: number, status: number, error?: string): Promise<void> {
  try {
    const r = client();
    const prev = r ? await r.hget<CronBeat>(BEATS_KEY, name) : mem.get(name);
    const ok = status > 0 && status < 400;
    const beat: CronBeat = {
      at,
      ms,
      status,
      okAt: ok ? at : prev?.okAt,
      failStreak: ok ? 0 : (prev?.failStreak ?? 0) + 1,
      lastError: ok ? undefined : (error ?? `HTTP ${status}`).slice(0, 300),
    };
    if (r) await r.hset(BEATS_KEY, { [name]: beat });
    else mem.set(name, beat);
  } catch {
    // Never let bookkeeping fail the job it describes.
  }
}

/** Every cron's latest beat, keyed by cron name (its path segment). */
export async function getCronBeats(): Promise<Record<string, CronBeat>> {
  const r = client();
  if (!r) return Object.fromEntries(mem);
  return ((await r.hgetall<Record<string, CronBeat>>(BEATS_KEY)) ?? {}) as Record<string, CronBeat>;
}

/** Wrap a cron route's GET so each real run leaves a heartbeat. */
export function withCronBeat(name: string, handler: (req: NextRequest) => Promise<Response>) {
  return async function GET(req: NextRequest): Promise<Response> {
    const at = Date.now();
    const dry = req.nextUrl.searchParams.has("dry");
    try {
      const res = await handler(req);
      if (res.status !== 401 && !dry) await recordBeat(name, at, Date.now() - at, res.status);
      return res;
    } catch (e) {
      if (!dry) await recordBeat(name, at, Date.now() - at, 0, e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
}
