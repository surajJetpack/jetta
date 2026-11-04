/**
 * The /self-review page's data (admin only: it quotes customer messages).
 * GET reads the precomputed summary, one KV read. POST runs the review now,
 * the same work as the hourly cron; `?judge=0` skips the judging and only
 * refreshes the reliability check. Slack posts are deduped, so a click cannot
 * repeat one the cron already sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { getSelfReviewSummary, runSelfReview } from "@/lib/self-review";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return NextResponse.json({ summary: await getSelfReviewSummary() });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const judge = req.nextUrl.searchParams.get("judge") !== "0";
  const result = await runSelfReview({ judge });
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: "selfreview.run_manual",
    source: "console",
    actor: adminActor(req) ?? undefined,
    data: { ...result },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A review is already running. Try again in a few minutes." }, { status: 409 });
  }
  if (result.status === "off") {
    return NextResponse.json({ ...result, message: "The self-review is switched off (JETTA_SELF_REVIEW)." }, { status: 409 });
  }
  return NextResponse.json({ ...result, summary: await getSelfReviewSummary() }, { status: result.status === "error" ? 500 : 200 });
}
