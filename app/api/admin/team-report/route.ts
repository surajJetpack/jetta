/**
 * Preview of the daily team report (admin only: every block names a person).
 *
 * GET returns the report as plain text (what the cron posts if Slack refuses
 * the tables; ?format=blocks returns the table messages themselves) for ?day=YYYY-MM-DD
 * (default: yesterday in the support timezone), as plain text, and posts
 * nothing. It works with or without JETTA_TEAM_REPORT_CHANNEL, so the report
 * can be read before it is switched on.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { config } from "@/lib/config";
import { freshdeskTicketUrl } from "@/lib/tools/freshdesk";
import { previewTeamReport, reportDay } from "@/lib/team-report-run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { report, text, tables } = await previewTeamReport(req.nextUrl.searchParams.get("day") ?? undefined);
  const format = req.nextUrl.searchParams.get("format");
  // ?format=blocks: the table messages as JSON, each pasteable into Slack's Block Kit Builder.
  if (format === "blocks") return NextResponse.json({ tables });
  // ?format=json: the report itself, with the list behind every count. The Daily report page reads this.
  if (format === "json") {
    return NextResponse.json({ report, ticketUrlBase: freshdeskTicketUrl(""), latestDay: reportDay(), posting: !!config.teamReport.channel });
  }
  return new NextResponse(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
