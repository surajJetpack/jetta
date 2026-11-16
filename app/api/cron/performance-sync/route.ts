/**
 * Performance sync cron — reads changed Freshdesk tickets into the /performance
 * store, a fixed number per run so it never competes with live Jetta for the
 * shared 40-calls-a-minute Freshdesk budget. See lib/performance-sync.ts.
 *
 * Hourly (vercel.json). A cold store backfills over the first day of runs.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { syncPerformance } from "@/lib/performance-sync";
import { logOpsEvent } from "@/lib/events";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await syncPerformance();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "cron.performance_sync_failed" : "cron.performance_sync_run",
    source: "cron",
    data: { ...result },
  });
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}

export const GET = withCronBeat("performance-sync", handler);
