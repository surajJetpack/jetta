/**
 * Agent-reply reconciler — the Freshdesk-native half of draft review.
 *
 * A Freshdesk automation rule ("Reply is sent, performed by Agent") POSTs here.
 * That rule is optional: /api/cron/reconcile-drafts polls for the same outcome,
 * which is what actually runs today — this endpoint received one request in its
 * first month because the rule was never created.
 * If the ticket has a pending Jetta draft, the agent's actual sent reply is
 * fetched and diffed against the suggestion: near-identical counts as
 * approve-unedited (good), edited as approve-edited (partial), unrelated as
 * unused (discarded/bad) — so replying straight from the draft note in
 * Freshdesk feeds the /evals learning loop with no console step.
 *
 * The comparison logic lives in lib/reconcile.ts, shared with the cron and the
 * backfill script.
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { markEventSeen } from "@/lib/kv";
import { logOpsEvent } from "@/lib/events";
import { reconcileTicketDraft } from "@/lib/reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

function verifySecret(req: NextRequest): boolean {
  // If no secret is configured, allow (useful for local stub testing).
  if (!config.webhook.secret) return true;
  const provided = req.headers.get("x-jetta-secret");
  return provided === config.webhook.secret;
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const ticketId = payload.ticket_id != null ? String(payload.ticket_id) : null;
  if (!ticketId) {
    return NextResponse.json({ error: "no ticket id in payload" }, { status: 400 });
  }

  const updatedAt = payload.updated_at as string | undefined;
  const fresh = await markEventSeen(`agent-reply:${ticketId}:${updatedAt ?? ""}`, updatedAt ? 3600 : 300);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate, ignored", ticketId });
  }

  await logOpsEvent({
    level: "info",
    event: "draft.reconcile_received",
    source: "webhook",
    ticketId,
    data: { userAgent: req.headers.get("user-agent") ?? undefined },
  });

  // ACK before the FD fetches so the automation client never times out.
  // Stub passthrough: local tests can supply the "sent" reply in the payload
  // instead of standing up a live Freshdesk.
  const stubReply =
    typeof payload.body === "string"
      ? { body: payload.body, userId: Number(payload.user_id ?? 0) }
      : undefined;
  after(() => reconcileTicketDraft(ticketId, { source: "webhook", stubReply }));
  return NextResponse.json({ status: "accepted", ticketId });
}

