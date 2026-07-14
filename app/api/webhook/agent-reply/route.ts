/**
 * Agent-reply reconciler — the Freshdesk-native half of draft review.
 *
 * A Freshdesk automation rule ("Reply is sent, performed by Agent") POSTs here.
 * If the ticket has a pending Jetta draft, the agent's actual sent reply is
 * fetched and diffed against the suggestion: near-identical counts as
 * approve-unedited (good), edited as approve-edited (partial), unrelated as
 * unused (discarded/bad) — so replying straight from the draft note in
 * Freshdesk feeds the /evals learning loop with no console step.
 *
 * Replies authored by Jetta's own FD agent user (FRESHDESK_AGENT_ID) are
 * skipped: console-approved sends fire this same automation, and the console
 * path already records its own decision.
 */
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import {
  getPendingReplyDraftForTicket,
  updateReplyDraft,
  scheduleFollowUp,
  recordOutcome,
  markEventSeen,
} from "@/lib/kv";
import { recordEvaluation } from "@/lib/evals";
import { logOpsEvent } from "@/lib/events";
import { normalizeReplyText, replySimilarity, classifyReplySimilarity } from "@/lib/reply-similarity";
import * as freshdesk from "@/lib/tools/freshdesk";

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
  after(() => reconcile(ticketId, payload));
  return NextResponse.json({ status: "accepted", ticketId });
}

async function reconcile(ticketId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const draft = await getPendingReplyDraftForTicket(ticketId);
    if (!draft) {
      await logOpsEvent({ level: "info", event: "draft.reconcile_no_pending", source: "webhook", ticketId });
      return;
    }
    if (draft.channel !== "freshdesk") return;

    // Stub passthrough: local tests can supply the "sent" reply in the payload
    // instead of standing up a live Freshdesk.
    const reply =
      !config.freshdesk.live && typeof payload.body === "string"
        ? {
            body: payload.body,
            userId: Number(payload.user_id ?? 0),
            createdAt: new Date().toISOString(),
          }
        : await freshdesk.getLatestAgentReply(ticketId);
    if (!reply) {
      await logOpsEvent({ level: "info", event: "draft.reconcile_no_agent_reply", source: "webhook", ticketId });
      return;
    }

    // Loop prevention: console-approved sends are authored by Jetta's own FD
    // agent user. The no-pending check alone can't catch them — the console
    // sends BEFORE flipping the draft state.
    if (config.freshdesk.agentId && String(reply.userId) === config.freshdesk.agentId) {
      await logOpsEvent({
        level: "info",
        event: "draft.reconcile_skipped_self",
        source: "webhook",
        ticketId,
        data: { draftId: draft.id, agentUserId: reply.userId },
      });
      return;
    }

    // Event about a reply older than the draft (automation replay) — ignore.
    if (Date.parse(reply.createdAt) < draft.createdAt * 1000) {
      await logOpsEvent({
        level: "info",
        event: "draft.reconcile_skipped_stale_reply",
        source: "webhook",
        ticketId,
        data: { draftId: draft.id, replyAt: reply.createdAt },
      });
      return;
    }

    const score = replySimilarity(normalizeReplyText(draft.suggestedReply), normalizeReplyText(reply.body));
    const rating = classifyReplySimilarity(score);
    const agentName = (await freshdesk.getAgentName(reply.userId)) ?? `agent-${reply.userId}`;
    const decidedBy = `${agentName} via freshdesk`;
    const now = Math.floor(Date.now() / 1000);

    // Final race guard: the console may have decided meanwhile (same
    // check-then-act tolerance the console route accepts).
    const current = await getPendingReplyDraftForTicket(ticketId);
    if (!current || current.id !== draft.id) {
      await logOpsEvent({ level: "info", event: "draft.reconcile_no_pending", source: "webhook", ticketId });
      return;
    }

    if (rating === "bad") {
      await updateReplyDraft(draft.id, { state: "discarded", decidedAt: now, decidedBy });
      await recordEvaluation({
        id: draft.id,
        ticketId: draft.ticketId,
        subject: draft.subject,
        channel: draft.channel,
        product: draft.product,
        model: draft.model,
        decidedBy,
        at: now,
        action: "discard",
        rating: "bad",
        tags: ["other"],
        note: `agent sent an unrelated reply (auto-reconciled from Freshdesk, similarity ${score.toFixed(2)})`,
        suggestedReply: draft.suggestedReply,
      }).catch(() => {});
    } else {
      const edited = rating === "partial";
      await updateReplyDraft(draft.id, {
        state: "approved",
        decidedAt: now,
        decidedBy,
        editedBody: edited ? reply.body : undefined,
      });
      await recordEvaluation({
        id: draft.id,
        ticketId: draft.ticketId,
        subject: draft.subject,
        channel: draft.channel,
        product: draft.product,
        model: draft.model,
        decidedBy,
        at: now,
        action: "approve",
        rating,
        tags: [],
        note: `auto-reconciled from Freshdesk (similarity ${score.toFixed(2)})`,
        suggestedReply: draft.suggestedReply,
        finalBody: reply.body,
      }).catch(() => {});

      // The human sent the reply themselves — never touch ticket status here.
      // Follow-up still applies when the run marked a resolution as sent.
      if (draft.resolutionSent) {
        await scheduleFollowUp(draft.ticketId, reply.createdAt).catch(() => {});
      }
      await recordOutcome({
        ticketId: draft.ticketId,
        subject: draft.subject,
        at: now,
        channel: draft.channel,
        product: draft.product,
        model: draft.model ?? "unknown",
        toolsUsed: ["reply_to_ticket"],
        replied: true,
        resolutionSent: draft.resolutionSent,
        escalated: false,
        drafted: true,
        kind: "handled",
      }).catch(() => {});
    }

    await logOpsEvent({
      level: "info",
      event: "draft.reconciled",
      source: "webhook",
      ticketId,
      actor: decidedBy,
      data: { draftId: draft.id, rating, score: Number(score.toFixed(3)), agentUserId: reply.userId },
    });
  } catch (e) {
    await logOpsEvent({
      level: "error",
      event: "draft.reconcile_failed",
      source: "webhook",
      ticketId,
      data: { error: e instanceof Error ? e.message : String(e) },
    });
  }
}
