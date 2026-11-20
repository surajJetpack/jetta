/**
 * Daily team report cron: posts yesterday's per-person report to Slack. See
 * lib/team-report.ts (what is in it) and lib/team-report-run.ts (the guard).
 *
 * 03:30 UTC (vercel.json), which is 09:15 in Kathmandu: after the hourly
 * activity (:25) and performance (:40) syncs have caught up on the day before.
 * Posts nothing until JETTA_TEAM_REPORT_CHANNEL is set. ?dry returns the text
 * without posting.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { logOpsEvent } from "@/lib/events";
import { cronAuthorized } from "@/lib/request-auth";
import { previewTeamReport, runTeamReport } from "@/lib/team-report-run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handler(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (req.nextUrl.searchParams.has("dry")) {
    const { report, text } = await previewTeamReport(req.nextUrl.searchParams.get("day") ?? undefined);
    return NextResponse.json({ dry: true, day: report.day, text });
  }
  const result = await runTeamReport();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "cron.team_report_failed" : "cron.team_report_run",
    source: "cron",
    data: { ...result },
  });
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}

export const GET = withCronBeat("team-report", handler);
