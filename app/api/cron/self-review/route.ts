/**
 * Self-review cron: checks Jetta's own reliability and has an independent
 * model judge a few of her recent replies, then writes the /self-review page
 * and posts findings to the ops channel. See lib/self-review/index.ts.
 *
 * Hourly (vercel.json). JETTA_SELF_REVIEW=off makes it a no-op.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { runSelfReview } from "@/lib/self-review";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails closed: it spends judge-model calls.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handler(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runSelfReview();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "cron.self_review_failed" : "cron.self_review_run",
    source: "cron",
    data: { ...result },
  });
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}

export const GET = withCronBeat("self-review", handler);
