/**
 * Reply-draft review queue (admin-gated) — draft mode's approval surface.
 *
 *   GET  → { drafts }  (all reply drafts, pending first, newest first)
 *   POST { id, action: "approve" | "discard", body?, tags?, note? }
 *
 * Approve sends the reply to the customer via the Freshdesk client (optionally
 * edited via `body`), resolves the ticket when the agent wanted to close, and
 * schedules the 24h follow-up when the run logged a resolution — the pieces the
 * webhook deliberately skips in draft mode.
 *
 * Every decision also records a ReplyEvaluation (lib/evals.ts) feeding the
 * /evals learning loop. Discard requires ≥1 reason tag; approve tags/note are
 * optional (the edit diff itself is the main signal).
 */
import { NextRequest, NextResponse } from "next/server";
import { adminAuthorized, adminActor } from "@/lib/auth";
import { getReplyDraft, updateReplyDraft, listReplyDrafts, scheduleFollowUp, recordOutcome } from "@/lib/kv";
import { recordEvaluation, EVAL_TAGS, type EvalTag } from "@/lib/evals";
import { logOpsEvent } from "@/lib/events";
import { modelLabel } from "@/lib/llm";
import * as freshdesk from "@/lib/tools/freshdesk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drafts = await listReplyDrafts();
  // Cheap payload for the nav badge's 60s poll.
  if (req.nextUrl.searchParams.get("count")) {
    return NextResponse.json({ pending: drafts.filter((d) => d.state === "pending").length });
  }
  drafts.sort((a, b) =>
    a.state === "pending" && b.state !== "pending" ? -1
    : a.state !== "pending" && b.state === "pending" ? 1
    : b.createdAt - a.createdAt,
  );
  return NextResponse.json({ drafts });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, action, body, tags, note } = (await req.json().catch(() => ({}))) as {
    id?: string;
    action?: string;
    body?: string;
    tags?: string[];
    note?: string;
  };
  if (!id || (action !== "approve" && action !== "discard" && action !== "feedback")) {
    return NextResponse.json({ error: "id and action (approve|discard|feedback) required" }, { status: 400 });
  }
  const requestTags = (tags ?? []).filter((t): t is EvalTag => (EVAL_TAGS as readonly string[]).includes(t));
  if (action === "discard" && requestTags.length === 0) {
    return NextResponse.json(
      { error: `discard requires at least one reason tag (${EVAL_TAGS.join(", ")})` },
      { status: 400 },
    );
  }

  const draft = await getReplyDraft(id);
  if (!draft) return NextResponse.json({ error: "draft not found" }, { status: 404 });
  // Stale/double-decision guard (check-then-act; best-effort atomicity is fine
  // for a single small reviewer team — revisit if reviews become concurrent).
  if (draft.state !== "pending") {
    return NextResponse.json({ error: `draft is already ${draft.state}` }, { status: 409 });
  }

  const now = Math.floor(Date.now() / 1000);
  const actor = adminActor(req) ?? "console";

  // Standalone feedback: saved on the pending draft, no decision made. Whatever
  // eventually closes the draft (console decision or the agent-reply
  // reconciler) merges it into the evaluation.
  if (action === "feedback") {
    if (requestTags.length === 0 && !note?.trim()) {
      return NextResponse.json({ error: "feedback requires at least one tag or a note" }, { status: 400 });
    }
    await updateReplyDraft(id, {
      feedbackTags: requestTags,
      feedbackNote: note?.trim() || undefined,
      feedbackBy: actor,
      feedbackAt: now,
    });
    await logOpsEvent({
      level: "info",
      event: "draft.feedback_saved",
      source: "console",
      ticketId: draft.ticketId,
      actor,
      data: { draftId: draft.id, tags: requestTags, hasNote: !!note?.trim() },
    });
    return NextResponse.json({ ok: true, action: "feedback" });
  }

  // Decisions merge any feedback saved earlier on the card.
  const savedTags = (draft.feedbackTags ?? []).filter((t): t is EvalTag =>
    (EVAL_TAGS as readonly string[]).includes(t),
  );
  const evalTags = [...new Set([...requestTags, ...savedTags])];
  const mergedNote =
    [note?.trim(), draft.feedbackNote?.trim()].filter(Boolean).join(" · ") || undefined;

  if (action === "discard") {
    await updateReplyDraft(id, { state: "discarded", decidedAt: now, decidedBy: actor });
    // Discard is the strongest negative signal — record it for the learning loop.
    await recordEvaluation({
      id: draft.id,
      ticketId: draft.ticketId,
      subject: draft.subject,
      channel: draft.channel,
      product: draft.product,
      model: draft.model,
      decidedBy: actor,
      at: now,
      action: "discard",
      rating: "bad",
      tags: evalTags,
      note: mergedNote,
      suggestedReply: draft.suggestedReply,
    }).catch(() => {});
    await logOpsEvent({
      level: "info",
      event: "draft.discarded",
      source: "console",
      ticketId: draft.ticketId,
      actor,
      data: { draftId: draft.id, tags: evalTags, note: mergedNote },
    });
    return NextResponse.json({ ok: true, action: "discarded" });
  }

  if (draft.channel === "freshchat") {
    // TODO: dispatch to freshchat.replyToConversation once chat drafts exist.
    return NextResponse.json(
      { error: "freshchat drafts cannot be sent from the console yet" },
      { status: 400 },
    );
  }

  const finalBody = body?.trim() || draft.suggestedReply;
  try {
    await freshdesk.replyToTicket(draft.ticketId, finalBody);
    if (draft.wantsClose) await freshdesk.closeTicket(draft.ticketId, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateReplyDraft(id, { error: msg }); // stays pending — retryable
    await logOpsEvent({
      level: "error",
      event: "draft.send_failed",
      source: "console",
      ticketId: draft.ticketId,
      actor,
      data: { draftId: draft.id, error: msg },
    });
    return NextResponse.json({ error: `send failed: ${msg}` }, { status: 502 });
  }

  if (draft.resolutionSent) {
    await scheduleFollowUp(draft.ticketId, new Date().toISOString()).catch(() => {});
  }
  await updateReplyDraft(id, {
    state: "approved",
    decidedAt: now,
    decidedBy: actor,
    editedBody: finalBody !== draft.suggestedReply ? finalBody : undefined,
    error: undefined,
  });

  // Approve-unedited = good, approve-edited = partial; the edit diff is the
  // feedback the distiller learns from. Never blocks the decision.
  await recordEvaluation({
    id: draft.id,
    ticketId: draft.ticketId,
    subject: draft.subject,
    channel: draft.channel,
    product: draft.product,
    model: draft.model,
    decidedBy: actor,
    at: now,
    action: "approve",
    rating: finalBody !== draft.suggestedReply ? "partial" : "good",
    tags: evalTags,
    note: mergedNote,
    suggestedReply: draft.suggestedReply,
    finalBody,
  }).catch(() => {});

  // Count the real send in the outcome feed so Insights reflects approved
  // replies (webhook-time outcomes in draft mode record replied: false).
  await recordOutcome({
    ticketId: draft.ticketId,
    subject: draft.subject,
    at: now,
    channel: draft.channel,
    product: draft.product,
    model: draft.model ?? modelLabel(),
    toolsUsed: ["reply_to_ticket", ...(draft.wantsClose ? ["close_ticket"] : [])],
    replied: true,
    resolutionSent: draft.resolutionSent,
    escalated: false,
    drafted: true,
    kind: "handled",
  }).catch(() => {});

  await logOpsEvent({
    level: "info",
    event: "draft.approved",
    source: "console",
    ticketId: draft.ticketId,
    actor,
    data: { draftId: draft.id, edited: finalBody !== draft.suggestedReply, wantsClose: draft.wantsClose, tags: evalTags },
  });

  return NextResponse.json({ ok: true, action: "approved", ticketId: draft.ticketId });
}
