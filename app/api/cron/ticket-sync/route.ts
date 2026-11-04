/**
 * Keeps the Postgres ticket mirror in step with Freshdesk (lib/ticket-mirror).
 *
 * Every 5 minutes: tickets changed since the last tick, then a slice of history
 * until the backfill catches up. Background priority — it yields whenever the
 * shared Freshdesk budget runs low, so webhook runs never wait on it. Does
 * nothing (200, `skipped`) when DATABASE_URL is unset.
 *
 * Writes only to our own database; Freshdesk is read, never written.
 */
import { NextRequest, NextResponse } from "next/server";
import { withCronBeat } from "@/lib/cron-beat";
import { runTicketSync } from "@/lib/ticket-mirror/sync";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Leave headroom under maxDuration for the final writes. */
const RUN_BUDGET_MS = 240_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handler(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runTicketSync(RUN_BUDGET_MS);
    if (!report) return NextResponse.json({ skipped: "DATABASE_URL not set" });
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logOpsEvent({ level: "error", event: "ticket_sync.failed", source: "cron", data: { message } });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withCronBeat("ticket-sync", handler);
