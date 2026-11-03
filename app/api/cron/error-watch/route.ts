/**
 * Error watch cron: reads Sentry and the CloudWatch logs, flags new and
 * spiking errors that hit customers, alerts Slack, lists (shadow) or files dev
 * items, and writes the /logs page's AI read. See lib/error-watch.ts.
 *
 * Hourly (vercel.json). JETTA_ERROR_WATCH=off makes it a no-op.
 */
import { NextRequest, NextResponse } from "next/server";
import { runErrorWatch } from "@/lib/error-watch";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails closed: it spends CloudWatch scans, Sentry calls and an LLM call.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runErrorWatch();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "cron.error_watch_failed" : "cron.error_watch_run",
    source: "cron",
    data: { ...result },
  });
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}
