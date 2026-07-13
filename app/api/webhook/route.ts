/**
 * Main event handler. Freshdesk / Freshchat fire a webhook here on a new
 * ticket or reply.
 *
 * Lifecycle:
 *   1. Verify the shared-secret header.
 *   2. Parse the ticket id + a dedupe key from the payload.
 *   3. Skip duplicate deliveries (idempotency via KV).
 *   4. ACK 200 immediately, then (via `after`) assemble context and run the
 *      Claude tool loop. Freshdesk's webhook client times out in well under a
 *      minute and disables the rule after repeated failures, while an agent
 *      run takes 60s+ — so the run must never block the response. Outcomes
 *      are observable in the run log / drafts console, not the ACK.
 *   5. If a resolution was sent, schedule the 24h follow-up.
 *
 * Note: Freshdesk's native webhooks do not HMAC-sign payloads — verification is
 * a shared-secret header you configure on the automation rule, checked here.
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import { markEventSeen, unmarkEventSeen, scheduleFollowUp, recordOutcome } from "@/lib/kv";
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

  // Idempotency: dedupe by event id when present, else ticket + rule marker +
  // timestamp. Freshdesk automations can't always send a timestamp — without
  // one, use a short TTL so a genuine follow-up event (customer reply an hour
  // later) isn't swallowed, while immediate redeliveries still dedupe.
  const updatedAt = payload.updated_at as string | undefined;
  const eventId =
    (payload.event_id as string | undefined) ??
    `${ticketId}:${(payload.event as string | undefined) ?? ""}:${updatedAt ?? ""}`;
  const fresh = await markEventSeen(eventId, updatedAt ? 3600 : 300);
  if (!fresh) {
    return NextResponse.json({ status: "duplicate, ignored", ticketId });
  }

  const channel = (payload.channel as "freshdesk" | "freshchat" | undefined) ?? "freshdesk";

  // ACK before the (60s+) agent run so Freshdesk never times out and disables
  // the rule. The pipeline continues after the response via `after` — the
  // function stays alive up to maxDuration on Vercel.
  after(() => processTicket(ticketId, channel));
  return NextResponse.json({ status: "accepted", ticketId });
}

/**
 * TTL for the per-customer-message run marker. Long enough that a webhook
 * storm weeks later can't re-run an old message; a NEW customer message always
 * has a new marker, so nothing legitimate is ever blocked.
 */
const CUSTOMER_MSG_MARKER_TTL = 30 * 86400;

/** The full agent pipeline, detached from the webhook response. */
async function processTicket(ticketId: string, channel: "freshdesk" | "freshchat"): Promise<void> {
  // Set once the run marker is claimed, so the catch can release it on failure.
  let claimedMarker: string | null = null;
  try {
    const ctx = await buildContext(ticketId, channel);
    if (!ctx.ticket) {
      console.warn(`Webhook ticket ${ticketId}: not found, skipping.`);
      return;
    }

    // Product filter (controlled rollout): skip before the agent ever runs.
    if (config.productFilter.length && !config.productFilter.includes(ctx.product)) {
      console.log(`Webhook ticket ${ticketId}: product "${ctx.product}" not in JETTA_PRODUCTS, skipping.`);
      return;
    }

    // Semantic idempotency: run at most once per CUSTOMER message. Upstream
    // senders (Freshdesk automations, Make scenarios) fire on all kinds of
    // ticket updates — including Jetta's own private notes, which produced a
    // note → webhook → run → note loop (seen on ticket 13756). The event-id
    // dedupe above can't stop that because each bot update looks fresh; this
    // marker only changes when the customer actually says something new.
    // (Console re-runs and the follow-up cron bypass this path on purpose.)
    // Marker = timestamp of the newest customer reply, or "initial" when the
    // only customer content is the ticket description (which never changes).
    const lastCustomerAt =
      ctx.ticket.replies
        .filter((r) => r.author === "customer" && !r.isPrivate)
        .map((r) => r.createdAt)
        .sort()
        .pop() ?? "initial";
    const marker = `customer-msg:${ticketId}:${lastCustomerAt}`;
    if (!(await markEventSeen(marker, CUSTOMER_MSG_MARKER_TTL))) {
      console.log(`Webhook ticket ${ticketId}: no new customer message since last run, skipping.`);
      return;
    }
    claimedMarker = marker;

    const messages = buildMessages(ctx.ticket, channel);
    const system = await buildSystemPrompt(ctx);
    const draftMode = config.replyMode === "draft";
    const started = Date.now();
    // autoTier: complexity-based routing, only active when JETTA_TIERED_AGENT
    // is on. Safe surface: draft mode means humans review every reply anyway.
    // (Freshchat and the follow-up cron intentionally stay on standard.)
    const result = await runAgentLoop(
      system,
      messages,
      ctx,
      draftMode ? { holdCustomerWrites: true, autoTier: true } : { autoTier: true },
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
        model: result.model,
        toolsUsed: result.toolsUsed,
        replied: false,
        resolutionSent: false,
        escalated: result.toolsUsed.includes("send_escalation"),
        drafted: !!draft,
        kind: "handled",
      }).catch((e) => console.warn("recordOutcome failed:", e));
      return;
    }

    // Allowlist guard: the run was forced to dry-run (ticket not allowlisted) —
    // nothing was written, so don't schedule follow-ups or log a real outcome.
    if (result.blockedByAllowlist) {
      console.log(`Webhook ticket ${ticketId}: not on JETTA_TICKET_ALLOWLIST — forced dry-run, no writes.`);
      return;
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
      model: result.model,
      toolsUsed: result.toolsUsed,
      replied,
      resolutionSent: result.resolutionSent,
      escalated: result.toolsUsed.includes("send_escalation"),
      kind: "handled",
    }).catch((e) => console.warn("recordOutcome failed:", e));
  } catch (err) {
    // The ACK already went out — failures land in the function log (and the
    // run log when the failure happened after the agent ran).
    console.error(`Webhook processing failed for ticket ${ticketId}:`, err);
    // Release the customer-message marker so a retry can process this message.
    if (claimedMarker) await unmarkEventSeen(claimedMarker).catch(() => {});
  }
}

// Lightweight health check for the webhook endpoint.
export async function GET() {
  return NextResponse.json({ ok: true, stubMode: config.stubMode });
}
