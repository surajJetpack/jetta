/**
 * Daily overview cron: compute yesterday's rollup + AI narrative once, and
 * persist it for the Insights dashboard. Scheduled in vercel.json (06:10 UTC,
 * after kb-sync at 05:00 and before followup at 09:00); also invocable manually
 * with the CRON_SECRET bearer token.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshDailyRollup, yesterdayKey } from "@/lib/daily-overview";
import { pruneTopics } from "@/lib/kv";
import { pruneExpiredFiles } from "@/lib/chat-files";
import { getChatSettings } from "@/lib/chat-settings";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = yesterdayKey();

  // Retention runs FIRST and outside the try, deliberately.
  //
  // Chat attachments have no TTL of their own — blob storage would keep
  // customer screenshots forever, well past the window the transcripts obey.
  // Hanging that off the rollup meant a deletion promise depended on an LLM
  // call succeeding: one bad narrative and nothing was pruned that day, with
  // no signal except storage quietly climbing.
  const pruned = await pruneExpiredFiles((await getChatSettings()).retentionDays).catch((e) => {
    console.warn("attachment prune failed:", e instanceof Error ? e.message : e);
    return { deleted: 0 };
  });

  try {
    const rollup = await refreshDailyRollup(date);
    // Cap the topic vocabulary here rather than on the ticket path — one-off
    // labels from odd tickets age out instead of crowding the triage prompt.
    await pruneTopics().catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "cron.daily_overview_run",
      source: "cron",
      data: {
        date,
        attachmentsPruned: pruned.deleted,
        tickets: rollup.outcomes.total,
        escalated: rollup.outcomes.escalated,
        insightGenerated: !!rollup.insight,
      },
    });
    return NextResponse.json({ status: "ok", date, rollup });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logOpsEvent({
      level: "error",
      event: "cron.daily_overview_failed",
      source: "cron",
      // Reported on the failure path too, so a run that lost its narrative
      // still shows that retention was honoured.
      data: { date, error, attachmentsPruned: pruned.deleted },
    });
    return NextResponse.json({ status: "error", date, error }, { status: 500 });
  }
}
