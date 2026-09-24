/**
 * Performance sync cron — reads changed Freshdesk tickets into the /performance
 * store, a fixed number per run so it never competes with live Jetta for the
 * shared 40-calls-a-minute Freshdesk budget. See lib/performance-sync.ts.
 *
 * Hourly (vercel.json). A cold store backfills over the first day of runs.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncPerformance } from "@/lib/performance-sync";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails CLOSED like reconcile-drafts: a missing secret must not make a
  // Freshdesk-budget-spending route publicly triggerable.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
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
