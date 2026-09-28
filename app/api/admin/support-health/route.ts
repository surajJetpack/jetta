/**
 * The /health page's data — any signed-in console user.
 *
 * One Redis GET of a payload the hourly performance sync precomputes; never
 * touches Freshdesk. Its own key, not a projection of the /performance
 * summary, so nothing per-agent can leak through here by a field someone adds
 * to that summary later.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { getSupportHealth, syncStatus } from "@/lib/performance-sync";
import { freshdeskTicketUrl } from "@/lib/tools/freshdesk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [health, sync] = await Promise.all([getSupportHealth(), syncStatus()]);
  return NextResponse.json({
    health,
    sync: { lastRunAt: sync.lastRunAt, queued: sync.queued },
    ticketUrlBase: freshdeskTicketUrl("").replace(/\/$/, "/"),
  });
}
