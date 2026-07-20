/**
 * Daily overview cron: compute yesterday's rollup + AI narrative once, and
 * persist it for the Insights dashboard. Scheduled in vercel.json (06:10 UTC,
 * after kb-sync at 05:00 and before followup at 09:00); also invocable manually
 * with the CRON_SECRET bearer token.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshDailyRollup, yesterdayKey } from "@/lib/daily-overview";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = yesterdayKey();
  try {
    const rollup = await refreshDailyRollup(date);
    await logOpsEvent({
      level: "info",
      event: "cron.daily_overview_run",
      source: "cron",
      data: {
        date,
        tickets: rollup.outcomes.total,
        escalated: rollup.outcomes.escalated,
        insightGenerated: !!rollup.insight,
      },
    });
    return NextResponse.json({ status: "ok", date, rollup });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "cron.daily_overview_failed", source: "cron", data: { date, error } });
    return NextResponse.json({ status: "error", date, error }, { status: 500 });
  }
}
