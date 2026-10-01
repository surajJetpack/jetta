/**
 * Activity sync cron — reads Slack, monday and the KB audit into the /activity
 * store. Read-only everywhere else. See lib/activity-sync.ts.
 *
 * Hourly (vercel.json), off the performance sync's minute so the two don't
 * start together.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncActivity } from "@/lib/activity-sync";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails CLOSED like the other crons: no secret, no public trigger.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
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
