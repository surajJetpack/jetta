/**
 * The /performance page's data (admin only).
 *
 * GET reads the precomputed summary — one Redis GET plus the sync state — and
 * never touches Freshdesk. POST runs one sync step now (the same work as the
 * hourly cron), for an admin who wants fresh numbers or a faster backfill.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { getPerformanceSummary, syncPerformance, syncStatus } from "@/lib/performance-sync";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const [summary, sync] = await Promise.all([getPerformanceSummary(), syncStatus()]);
  return NextResponse.json({ summary, sync });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const result = await syncPerformance();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: "performance.sync_manual",
    source: "console",
    actor: adminActor(req) ?? undefined,
    data: { ...result },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A sync is already running — try again in a few minutes." }, { status: 409 });
  }
  return NextResponse.json({ ...result, sync: await syncStatus() }, { status: result.status === "error" ? 500 : 200 });
}
