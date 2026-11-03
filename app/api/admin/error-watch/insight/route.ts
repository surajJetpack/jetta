/**
 * The /logs AI read (admin only). The cron writes it whenever what is flagged
 * changes, so a page view normally just reads it; `?refresh=1` rewrites it.
 * A failed rewrite serves the previous read marked stale.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { errorWatchInsight, getErrorWatchInsight, getErrorWatchSummary } from "@/lib/error-watch";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const summary = await getErrorWatchSummary();
  if (!summary) return NextResponse.json({ insight: null, reason: "no_data" });
  try {
    const insight = await errorWatchInsight(summary, force);
    if (force) {
      await logOpsEvent({ level: "info", event: "errorwatch.insight_generated", source: "console", actor: adminActor(req) ?? undefined, data: { model: insight.model, dropped: insight.dropped } });
    }
    return NextResponse.json({ insight });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "errorwatch.insight_failed", source: "console", data: { message } });
    const cached = await getErrorWatchInsight().catch(() => null);
    if (cached) return NextResponse.json({ insight: cached, stale: true });
    return NextResponse.json({ error: "insight_failed", message: "Couldn't write the analysis — try again." }, { status: 502 });
  }
}
