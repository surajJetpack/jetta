/**
 * Draft mode: turn a held agent run into a ReplyDraft awaiting human approval.
 *
 * Called by the webhook (and the follow-up cron's re-run path) after
 * runAgentLoop({holdCustomerWrites: true}). The KV write happens first so a
 * Freshdesk/Slack hiccup can never lose the draft; the private note and the
 * Slack ping are best-effort notifications on top.
 */
import crypto from "node:crypto";
import { config } from "./config";
import type { ConversationContext } from "./types";
import type { AgentResult } from "./agent";
import { addReplyDraft, type ReplyDraft } from "./kv";
import * as freshdesk from "./tools/freshdesk";
import * as slack from "./tools/slack";
import { log } from "./logger";

/**
 * Create a pending ReplyDraft from the run's trace. Returns null when the
 * agent never proposed a customer reply (e.g. escalation-only turns) — there
 * is nothing to approve.
 */
export async function createDraftFromRun(
  ctx: ConversationContext,
  result: AgentResult,
): Promise<ReplyDraft | null> {
  const lastReply = [...result.trace].reverse().find((t) => t.tool === "reply_to_ticket");
  let body = (lastReply?.input as { body?: string } | undefined)?.body;
  // Safety net: models occasionally emit the reply as final text instead of
  // calling reply_to_ticket (seen live on ticket 13756). A human reviews every
  // draft anyway, so a text-only reply becomes a draft rather than vanishing.
  if (!body && result.text.trim().length >= 40) {
    body = result.text.trim();
    log.warn("draft_from_final_text", { ticketId: ctx.ticket?.id });
  }
  if (!body || !ctx.ticket) return null;

  const draft: ReplyDraft = {
    id: crypto.randomUUID(),
    ticketId: ctx.ticket.id,
    subject: ctx.ticket.subject,
    channel: ctx.channel === "freshchat" ? "freshchat" : "freshdesk",
    product: ctx.product,
    suggestedReply: body,
    wantsClose: result.toolsUsed.includes("close_ticket"),
    resolutionSent: result.resolutionSent,
    escalated: result.toolsUsed.includes("send_escalation"),
    createdAt: Math.floor(Date.now() / 1000),
    state: "pending",
  };
  await addReplyDraft(draft);

  const ticketUrl = `https://${config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}/a/tickets/${draft.ticketId}`;

  // Best-effort notifications — a failure here never loses the draft.
  // The Freshdesk note is opt-in (JETTA_DRAFT_FD_NOTE): the console is the
  // review surface, so by default nothing draft-related touches the ticket.
  if (draft.channel === "freshdesk" && config.draftNoteToFreshdesk) {
    await freshdesk
      .addPrivateNote(
        draft.ticketId,
        `[Jetta — draft pending review]\n\n${body}\n\n— Approve, edit, or discard in the Jetta console: ${config.consoleUrl}/drafts`,
      )
      .catch((e) => log.warn("draft_note_failed", { ticketId: draft.ticketId, error: String(e) }));
  }
  await slack
    .notifyDraftPending({
      subject: draft.subject ?? `Ticket #${draft.ticketId}`,
      ticketUrl,
      consoleUrl: config.consoleUrl,
    })
    .catch((e) => log.warn("draft_ping_failed", { ticketId: draft.ticketId, error: String(e) }));

  log.info("draft_created", { draftId: draft.id, ticketId: draft.ticketId, wantsClose: draft.wantsClose });
  return draft;
}
