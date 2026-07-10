/**
 * Main event handler. Freshdesk / Freshchat fire a webhook here on a new
 * ticket or reply.
 *
 * Lifecycle:
 *   1. Verify the shared-secret header.
 *   2. Parse the ticket id + a dedupe key from the payload.
 *   3. Skip duplicate deliveries (idempotency via KV).
 *   4. Assemble context, run the Claude tool loop.
 *   5. If a resolution was sent, schedule the 24h follow-up.
 *
 * Note: Freshdesk's native webhooks do not HMAC-sign payloads — verification is
 * a shared-secret header you configure on the automation rule, checked here.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import { markEventSeen, scheduleFollowUp, recordOutcome } from "@/lib/kv";
import { modelLabel } from "@/lib/llm";
import { recordRun } from "@/lib/runlog";
import { createDraftFromRun } from "@/lib/drafts";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Pull a ticket id out of the various shapes Freshdesk automations can send. */
function extractTicketId(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.ticket_id,
    payload.id,
    (payload.ticket as Record<string, unknown> | undefined)?.id,
    (payload.freshdesk_webhook as Record<string, unknown> | undefined)?.ticket_id,
  ];
  for (const c of candidates) {
    if (c != null) return String(c);
  }
  return null;
}

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

  const ticketId = extractTicketId(payload);
  if (!ticketId) {
    return NextResponse.json({ error: "no ticket id in payload" }, { status: 400 });
  }

  // Idempotency: dedupe by event id when present, else by a ticket+timestamp key.
  const eventId =
    (payload.event_id as string | undefined) ??
    `${ticketId}:${(payload.updated_at as string | undefined) ?? ""}`;
  const fresh = await markEventSeen(eventId);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate, ignored", ticketId });
  }

  const channel = (payload.channel as "freshdesk" | "freshchat" | undefined) ?? "freshdesk";

  try {
    const ctx = await buildContext(ticketId, channel);
    if (!ctx.ticket) {
      return NextResponse.json({ error: "ticket not found", ticketId }, { status: 404 });
    }

    // Product filter (controlled rollout): skip before the agent ever runs.
    if (config.productFilter.length && !config.productFilter.includes(ctx.product)) {
      return NextResponse.json({
        status: `skipped — product "${ctx.product}" not in JETTA_PRODUCTS`,
        ticketId,
        product: ctx.product,
      });
    }

    const messages = buildMessages(ctx.ticket, channel);
    const system = buildSystemPrompt(ctx);
    const draftMode = config.replyMode === "draft";
    const started = Date.now();
    const result = await runAgentLoop(
      system,
      messages,
      ctx,
      draftMode ? { holdCustomerWrites: true } : {},
    );
    await recordRun("webhook", ctx, result, Date.now() - started);

    // Draft mode: the customer-visible reply was held — materialize it as a
    // ReplyDraft for human approval. Follow-up scheduling moves to approve time
    // (the reply hasn't actually gone out yet).
    if (draftMode) {
      const draft = await createDraftFromRun(ctx, result);
      await recordOutcome({
        ticketId,
        subject: ctx.ticket.subject,
        at: Math.floor(Date.now() / 1000),
        channel,
        product: ctx.product,
        model: modelLabel(),
        toolsUsed: result.toolsUsed,
        replied: false,
        resolutionSent: false,
        escalated: result.toolsUsed.includes("send_escalation"),
        drafted: !!draft,
        kind: "handled",
      }).catch((e) => console.warn("recordOutcome failed:", e));
      return NextResponse.json({
        status: draft ? "drafted" : "handled (no reply proposed)",
        ticketId,
        draftId: draft?.id,
        toolsUsed: result.toolsUsed,
      });
    }

    // Allowlist guard: the run was forced to dry-run (ticket not allowlisted) —
    // nothing was written, so don't schedule follow-ups or log a real outcome.
    if (result.blockedByAllowlist) {
      return NextResponse.json({
        status: "skipped — ticket not on JETTA_TICKET_ALLOWLIST (forced dry-run, no writes)",
        ticketId,
        toolsUsed: result.toolsUsed,
      });
    }

    // Defence in depth: only treat a turn as a resolution if a customer-visible
    // reply actually went out. Guards against the model logging "resolution_sent"
    // without calling reply_to_ticket.
    const replied = result.toolsUsed.includes("reply_to_ticket");
    if (result.resolutionSent && !replied) {
      console.warn(`Ticket ${ticketId}: resolution_sent logged but no reply was posted — not scheduling follow-up.`);
    }
    if (result.resolutionSent && replied) {
      await scheduleFollowUp(ticketId, new Date().toISOString());
    }

    // Phase 0: capture the outcome for the learning/gap analytics loop.
    await recordOutcome({
      ticketId,
      subject: ctx.ticket.subject,
      at: Math.floor(Date.now() / 1000),
      channel,
      product: ctx.product,
      model: modelLabel(),
      toolsUsed: result.toolsUsed,
      replied,
      resolutionSent: result.resolutionSent,
      escalated: result.toolsUsed.includes("send_escalation"),
      kind: "handled",
    }).catch((e) => console.warn("recordOutcome failed:", e));

    return NextResponse.json({
      status: "handled",
      ticketId,
      toolsUsed: result.toolsUsed,
      resolutionSent: result.resolutionSent,
      reply: result.text,
    });
  } catch (err) {
    console.error(`Webhook handling failed for ticket ${ticketId}:`, err);
    return NextResponse.json(
      { error: "handler failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// Lightweight health check for the webhook endpoint.
export async function GET() {
  return NextResponse.json({ ok: true, stubMode: config.stubMode });
}
