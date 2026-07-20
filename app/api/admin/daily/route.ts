/**
 * Daily Overview data for the Insights dashboard.
 *
 *   GET                       → { rollups: DailyRollup[] } (last ?days=7, newest first)
 *   POST { date? }            → { rollup } — recompute + regenerate the narrative
 *                               (defaults to yesterday). Powers the "Regenerate" button.
 *
 * The POST path runs the exact same pipeline as the daily-overview cron
 * (lib/daily-overview.ts), so a manual refresh and the scheduled one match.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { getDailyRollups } from "@/lib/kv";
import { lastDays } from "@/lib/series";
import { refreshDailyRollup, yesterdayKey } from "@/lib/daily-overview";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const n = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 7), 1), 90);
  // lastDays is oldest-first; the dashboard wants newest-first.
  const dates = lastDays(n).reverse();
  const rollups = (await getDailyRollups(dates)).filter((r) => r != null);
  return NextResponse.json({ rollups });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";

  const body = (await req.json().catch(() => ({}))) as { date?: string };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date! : yesterdayKey();

  try {
    const rollup = await refreshDailyRollup(date);
    log.info("daily.regenerated", { date, actor, source: "console", insight: !!rollup.insight });
    return NextResponse.json({ rollup });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("daily.regenerate_failed", { date, error: msg, actor, source: "console" });
    return NextResponse.json({ error: `regeneration failed: ${msg}` }, { status: 502 });
  }
}
