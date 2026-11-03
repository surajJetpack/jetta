/**
 * The /logs page's data (admin only: it names customer accounts and shows raw
 * errors). GET reads the precomputed summary, one KV read. POST runs the watch
 * now, the same work as the hourly cron, alerts included (each alert is
 * deduped, so a click cannot repeat one the cron already sent).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { getErrorWatchSummary, runErrorWatch } from "@/lib/error-watch";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return NextResponse.json({ summary: await getErrorWatchSummary() });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const result = await runErrorWatch();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: "errorwatch.run_manual",
    source: "console",
    actor: adminActor(req) ?? undefined,
    data: { ...result },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A run is already in progress — try again in a few minutes." }, { status: 409 });
  }
  if (result.status === "off") {
    return NextResponse.json({ ...result, message: "The error watch is switched off (JETTA_ERROR_WATCH)." }, { status: 409 });
  }
  return NextResponse.json({ ...result, summary: await getErrorWatchSummary() }, { status: result.status === "error" ? 500 : 200 });
}
