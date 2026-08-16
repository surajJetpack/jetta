/**
 * Everything the chrome needs to know about what is waiting, in one request.
 *
 * The nav used to run three independent pollers — one per badge — each with
 * its own interval, its own endpoint and its own copy of the "any error means
 * hide the badge" logic. Three requests a minute to answer one question ("is
 * anything waiting?") is three chances to be rate-limited and three places to
 * fix a bug, so the sidebar now asks once.
 *
 * Read-only and cheap by construction: counts only, no payloads. Any caller
 * without a console session gets a 401 and the badges simply don't render,
 * which is the correct behaviour for an expired tab left open overnight.
 *
 * Counts are NOT filtered by role. A general user sees the chat badge because
 * a waiting visitor is their job; the billing count is only ever rendered
 * beside a nav item they don't have, so it costs nothing to return.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized } from "@/lib/auth";
import { listConversations } from "@/lib/chat-store";
import { listMonetApprovals } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // One slow store shouldn't blank every badge, so each side settles on its own
  // and a failure reports zero rather than taking the response down with it.
  const [convs, approvals] = await Promise.all([
    listConversations(100).catch(() => []),
    listMonetApprovals().catch(() => []),
  ]);

  return NextResponse.json({
    // Someone sitting in a live chat with nobody answering. The only count
    // here that is genuinely urgent — the widget is open in front of them.
    chatsWaiting: convs.filter((c) => c.status === "waiting_human").length,
    // Being handled by a colleague: information, not a summons.
    chatsLive: convs.filter((c) => c.status === "human").length,
    billingPending: approvals.length,
  });
}
