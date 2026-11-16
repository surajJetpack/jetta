/**
 * Activity sync cron — reads Slack, monday and the KB audit into the /activity
 * store. Read-only everywhere else. See lib/activity-sync.ts.
 *
 * Hourly (vercel.json), off the performance sync's minute so the two don't
 * start together.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { syncActivity } from "@/lib/activity-sync";
import { logOpsEvent } from "@/lib/events";
import { cronAuthorized } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await syncActivity();
  await logOpsEvent({
    level: result.status === "partial" ? "warn" : "info",
    event: "cron.activity_sync_run",
    source: "cron",
    data: { status: result.status, added: result.added, pruned: result.pruned, sources: result.sources },
  });
  return NextResponse.json(result);
}

export const GET = withCronBeat("activity-sync", handler);
