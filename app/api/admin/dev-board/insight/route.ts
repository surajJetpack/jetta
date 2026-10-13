/**
 * The AI read for /dev-board — admin only, like the page.
 *
 * Same contract as the /health and /performance reads: cached against the
 * summary's computedAt, so written at most once per sync and only when someone
 * looks; ?refresh=1 rewrites; a failed rewrite serves the previous read, stale.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUnderstand } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";
import { getDevBoardInsight, getDevBoardRows, getDevBoardSummary, saveDevBoardInsight } from "@/lib/dev-board-sync";
import { generateDevBoardInsight, type DevBoardInsight } from "@/lib/dev-board-insight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = requireUnderstand(req);
  if (denied) return denied;
  const actor = adminActor(req) ?? undefined;
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const [summary, rows, cached] = await Promise.all([
    getDevBoardSummary(),
    getDevBoardRows(),
    getDevBoardInsight<DevBoardInsight>().catch(() => null),
  ]);
  if (!summary) return NextResponse.json({ insight: null, reason: "not_built" });
  if (!force && cached?.basedOn === summary.computedAt) return NextResponse.json({ insight: cached, cached: true });
  if (!rows) return NextResponse.json({ insight: null, reason: "not_built" });

  const started = Date.now();
  try {
    const insight = await generateDevBoardInsight(summary, rows);
    await saveDevBoardInsight(insight).catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "devboard.insight_generated",
      source: "console",
      actor,
      data: { forced: force, ms: Date.now() - started, model: insight.model, dropped: insight.dropped },
    });
    return NextResponse.json({ insight, cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logOpsEvent({ level: "error", event: "devboard.insight_failed", source: "console", actor, data: { message } });
    if (cached) return NextResponse.json({ insight: cached, cached: true, stale: true });
    return NextResponse.json({ error: "insight_failed", message: "Couldn't write the analysis — try again." }, { status: 502 });
  }
}
