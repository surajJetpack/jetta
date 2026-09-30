/**
 * The /health page's data — any signed-in console user.
 *
 * GET is one Redis GET of a payload the hourly performance sync precomputes;
 * never touches Freshdesk. Its own key, not a projection of the /performance
 * summary, so nothing per-agent can leak through here by a field someone adds
 * to that summary later. `?rows=1` returns the tickets behind the numbers
 * instead (also precomputed) — fetched once, when someone first clicks one.
 *
 * POST runs one sync step now — the same work as the hourly cron. Open to the
 * same audience as the page: the sync lock stops two runs overlapping, and a
 * run paces itself inside the Freshdesk budget whoever pressed the button.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminActor, adminAuthorized } from "@/lib/auth";
import { getSupportHealth, getSupportHealthRows, syncPerformance, syncStatus } from "@/lib/performance-sync";
import { freshdeskTicketUrl } from "@/lib/tools/freshdesk";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("rows")) {
    // Null until the first sync after a deploy has built them — not "no tickets".
    return NextResponse.json({ rows: await getSupportHealthRows() });
  }
  const [health, sync] = await Promise.all([getSupportHealth(), syncStatus()]);
  return NextResponse.json({
    health,
    sync: { lastRunAt: sync.lastRunAt, queued: sync.queued, lastError: sync.lastError },
    ticketUrlBase: freshdeskTicketUrl("").replace(/\/$/, "/"),
  });
}

export async function POST(req: NextRequest) {
  const actor = adminActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await syncPerformance();
  await logOpsEvent({
    level: result.status === "error" ? "error" : "info",
    event: "performance.sync_manual",
    source: "console",
    actor,
    data: { ...result, page: "health" },
  });
  if (result.status === "busy") {
    return NextResponse.json({ ...result, message: "A sync is already running — try again in a few minutes." }, { status: 409 });
  }
  return NextResponse.json(result, { status: result.status === "error" ? 500 : 200 });
}
