/**
 * The AI read for /performance — admin only, like the page (it names agents).
 *
 * Same contract as /api/admin/support-health/insight: cached against the
 * summary's computedAt, so it is written at most once per sync and only when
 * someone looks; `?refresh=1` rewrites; a failed rewrite serves the previous
 * read marked stale.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import {
  getPerformanceInsight,
  getPerformanceRows,
  getPerformanceSummary,
  savePerformanceInsight,
} from "@/lib/performance-sync";
import { generatePerformanceInsight, type PerformanceInsight } from "@/lib/performance-insight";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const actor = adminActor(req) ?? undefined;
  const force = req.nextUrl.searchParams.get("refresh") === "1";

  const [summary, rows, cached] = await Promise.all([
    getPerformanceSummary(),
    getPerformanceRows(),
    getPerformanceInsight<PerformanceInsight>().catch(() => null),
  ]);
  if (!summary || !summary.tickets) return NextResponse.json({ insight: null, reason: "no_data" });
  if (!force && cached?.basedOn === summary.computedAt) {
    return NextResponse.json({ insight: cached, cached: true });
  }
  // The rows are what every citation opens; without them there is nothing to cite.
  if (!rows) return NextResponse.json({ insight: null, reason: "not_built" });

  const started = Date.now();
  try {
    const insight = await generatePerformanceInsight(summary, rows);
    await savePerformanceInsight(insight).catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "performance.insight_generated",
      source: "console",
      actor,
      data: { forced: force, ms: Date.now() - started, model: insight.model, dropped: insight.dropped },
    });
    return NextResponse.json({ insight, cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "performance.insight_failed", source: "console", actor, data: { message } });
    if (cached) return NextResponse.json({ insight: cached, cached: true, stale: true });
    return NextResponse.json({ error: "insight_failed", message: "Couldn't write the analysis — try again." }, { status: 502 });
  }
}
