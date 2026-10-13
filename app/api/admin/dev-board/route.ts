/**
 * The /dev-board page's data (admin only — rows name people).
 *
 * GET returns the precomputed summary and sync state: one key read. ?rows=1
 * returns every item row instead — what the drill sheet filters, fetched on
 * the first click. POST runs one sync now, the same work as the hourly cron.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/roles";
import { adminActor } from "@/lib/auth";
import { logOpsEvent } from "@/lib/events";
import { getDevBoardRows, getDevBoardState, getDevBoardSummary, syncDevBoard } from "@/lib/dev-board-sync";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("rows") === "1") {
    const rows = await getDevBoardRows();
    return NextResponse.json({ rows, built: rows != null });
  }
  const [summary, state] = await Promise.all([getDevBoardSummary(), getDevBoardState()]);
  return NextResponse.json({
    summary,
    sync: {
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      lastDurationMs: state.lastDurationMs ?? null,
    },
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const result = await syncDevBoard();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: result.status === "error" ? "devboard.sync_failed" : "devboard.sync_run",
    source: "console",
    actor: adminActor(req) ?? undefined,
    data: { ...result },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A sync is already running. Try again in a few minutes." }, { status: 409 });
  }
  return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 });
}
