/**
 * Preview of the daily team report (admin only: every block names a person).
 *
 * GET returns the exact Slack text the cron would post for ?day=YYYY-MM-DD
 * (default: yesterday in the support timezone), as plain text, and posts
 * nothing. It works with or without JETTA_TEAM_REPORT_CHANNEL, so the report
 * can be read before it is switched on.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { previewTeamReport } from "@/lib/team-report-run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { text } = await previewTeamReport(req.nextUrl.searchParams.get("day") ?? undefined);
  return new NextResponse(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
