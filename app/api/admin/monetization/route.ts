/**
 * Trials & discounts approval queue (admin-gated) — the console counterpart of
 * the Slack `approve/reject monet` commands.
 *
 *   GET            → { approvals }  (pending MonetApprovals, newest first)
 *   GET ?count     → { pending: N } (cheap poll for the nav badge)
 *   POST { id, action: "approve" | "reject" }
 *
 * approve/reject share lib/monetization-approvals.ts with the Slack path, so
 * both surfaces execute identical logic. approve runs the real monday call,
 * still bounded by MONDAY_MONETIZATION_ALLOW_WRITES.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { listMonetApprovals } from "@/lib/kv";
import { resolveMonetApproval } from "@/lib/monetization-approvals";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const approvals = await listMonetApprovals();
  if (req.nextUrl.searchParams.get("count")) {
    return NextResponse.json({ pending: approvals.length });
  }
  return NextResponse.json({ approvals });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "id and action (approve|reject) required" }, { status: 400 });
  }
  const res = await resolveMonetApproval(id, action, `console:${actor}`);
  await logOpsEvent({
    level: res.ok ? "info" : "warn",
    event: `monetization.${action}`,
    source: "console",
    actor,
    data: { ref: id, ok: res.ok, found: res.found },
  });
  // 404 for a missing id so the client can refetch; 200 for a decided request
  // even if the monday call no-op'd (message explains — e.g. writes disabled).
  return NextResponse.json({ ok: res.ok, message: res.message }, { status: res.found ? 200 : 404 });
}
