/**
 * Dev board sync cron — reads both monday dev boards into the /dev-board store
 * and mines a few new conversations. See lib/dev-board-sync.ts.
 *
 * Hourly (vercel.json). Read-only against monday.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncDevBoard } from "@/lib/dev-board-sync";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Fails CLOSED: a missing secret must not make an LLM-spending route public.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await syncDevBoard();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "cron.devboard_sync_failed" : "cron.devboard_sync_run",
    source: "cron",
    data: { ...result },
  });
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}
