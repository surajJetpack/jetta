/**
 * Draft reconciliation — infer what a human did with Jetta's suggestion.
 *
 * The team replies from Freshdesk, not the console: of 242 drafts written in the
 * first month, exactly one was decided in the console. So the outcome has to be
 * read back out of Freshdesk. Compare Jetta's suggested reply against the agent's
 * actual sent reply: near-identical means it was used as-is, partially similar
 * means edited, unrelated means not used.
 *
 * That measures ADOPTION ONLY. It deliberately writes no evaluation, because
 * "the human wrote something else" is not evidence the draft was worse — the
 * human benchmark had Jetta ahead 25/3/1. Quality is decided separately by the
 * blind judge in lib/judge.ts, which is what feeds the learning loop.
 *
 * Three callers share this: the agent-reply webhook (push, if the Freshdesk
 * automation rule is configured), the reconcile-drafts cron (poll, which works
 * whether or not it is), and the backfill script.
 */
import { getPendingReplyDraftForTicket, updateReplyDraft, scheduleFollowUp, recordOutcome } from "./kv";
import { logOpsEvent } from "./events";
import { normalizeReplyText, replySimilarity, classifyReplySimilarity } from "./reply-similarity";
import { config } from "./config";
import * as freshdesk from "./tools/freshdesk";

/** A follow-up only makes sense for a reply that just went out. */
const FOLLOW_UP_MAX_REPLY_AGE_HOURS = 48;

export type ReconcileStatus =
  | "no_pending"
  | "not_freshdesk"
  | "no_agent_reply"
  | "skipped_self"
  | "stale_reply"
  | "reconciled"
  | "failed";

export interface ReconcileResult {
  ticketId: string;
  status: ReconcileStatus;
  draftId?: string;
  /** Similarity class. Kept for continuity; `usage` is the meaningful field. */
  rating?: "good" | "partial" | "bad";
  usage?: "used_as_is" | "edited" | "not_used";
  score?: number;
  decidedBy?: string;
  error?: string;
}

export interface ReconcileOptions {
  /** Where this run came from — recorded on the ops events. */
  source: "webhook" | "cron";
  /**
   * When false, classify and report but write nothing: no draft state change, no
   * evaluation, no ops event. The backfill uses this to preview a month of
   * verdicts before any of them reach the learning loop.
   */
  commit?: boolean;
  /** Stub passthrough: local tests supply the "sent" reply instead of a live FD. */
  stubReply?: { body: string; userId: number };
}

export async function reconcileTicketDraft(
  ticketId: string,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const { source, commit = true } = opts;
  const note = async (status: ReconcileStatus, data?: Record<string, unknown>) => {
    if (commit) {
      await logOpsEvent({ level: "info", event: `draft.reconcile_${status}`, source, ticketId, data });
    }
    return { ticketId, status } as ReconcileResult;
  };

  try {
    const draft = await getPendingReplyDraftForTicket(ticketId);
    if (!draft) return await note("no_pending");
    if (draft.channel !== "freshdesk") return { ticketId, status: "not_freshdesk" };

    const draftAtIso = new Date(draft.createdAt * 1000).toISOString();
    const reply =
      !config.freshdesk.live && opts.stubReply
        ? { ...opts.stubReply, createdAt: new Date().toISOString() }
        : await freshdesk.getAgentReplyAfter(ticketId, draftAtIso);
    if (!reply) return await note("no_agent_reply", { draftId: draft.id });

    // Loop prevention: console-approved sends are authored by Jetta's own FD
    // agent user. The no-pending check alone can't catch them — the console
    // sends BEFORE flipping the draft state.
    if (config.freshdesk.agentId && String(reply.userId) === config.freshdesk.agentId) {
      return await note("skipped_self", { draftId: draft.id, agentUserId: reply.userId });
    }

    // getAgentReplyAfter already filters by timestamp; this catches clock skew.
    if (Date.parse(reply.createdAt) < draft.createdAt * 1000) {
      return await note("stale_reply", { draftId: draft.id, replyAt: reply.createdAt });
    }

    const score = replySimilarity(normalizeReplyText(draft.suggestedReply), normalizeReplyText(reply.body));
    const rating = classifyReplySimilarity(score);
    // Usage, not quality: "the human wrote something else" is not the same as
    // "the draft was wrong". lib/judge.ts decides quality separately.
    const usage = rating === "good" ? "used_as_is" : rating === "partial" ? "edited" : "not_used";

    if (!commit) {
      return { ticketId, status: "reconciled", draftId: draft.id, rating, score, usage };
    }

    const agentName = (await freshdesk.getAgentName(reply.userId)) ?? `agent-${reply.userId}`;
    const decidedBy = `${agentName} via freshdesk`;
    const now = Math.floor(Date.now() / 1000);

    // Final race guard: the console may have decided meanwhile (same
    // check-then-act tolerance the console route accepts).
    const current = await getPendingReplyDraftForTicket(ticketId);
    if (!current || current.id !== draft.id) return await note("no_pending", { draftId: draft.id });

    // Draft state still records what HAPPENED operationally: the ticket got a
    // reply, either recognisably from the draft or not. No evaluation is written
    // here — writing `rating: "bad"` off similarity alone would tell the
    // distiller (lib/distill.ts renders it as "human wrote a different reply")
    // to imitate every human reply, including the terse and the mistaken ones.
    await updateReplyDraft(draft.id, {
      state: usage === "not_used" ? "discarded" : "approved",
      decidedAt: now,
      decidedBy,
      editedBody: usage === "edited" ? reply.body : undefined,
      usage,
      agentReply: reply.body,
      similarity: Number(score.toFixed(3)),
    });

    // A human answered the customer, whichever words they used.
    //
    // Only schedule a follow-up for a reply that just happened. scheduleFollowUp
    // fires 24h from NOW regardless of the reply date, so reconciling an old
    // draft (the backfill walks month-old ones) would queue check_and_close jobs
    // against long-settled tickets and have the follow-up cron re-run the agent
    // on them tomorrow.
    const replyAgeHours = (Date.now() - Date.parse(reply.createdAt)) / 3_600_000;
    if (draft.resolutionSent && replyAgeHours <= FOLLOW_UP_MAX_REPLY_AGE_HOURS) {
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

    await logOpsEvent({
      level: "info",
      event: "draft.reconciled",
      source,
      ticketId,
      actor: decidedBy,
      data: {
        draftId: draft.id,
        usage,
        score: Number(score.toFixed(3)),
        agentUserId: reply.userId,
        ...(draft.feedbackBy ? { feedbackBy: draft.feedbackBy } : {}),
      },
    });

    return { ticketId, status: "reconciled", draftId: draft.id, rating, score, usage, decidedBy };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (commit) {
      await logOpsEvent({
        level: "error",
        event: "draft.reconcile_failed",
        source,
        ticketId,
        data: { error },
      });
    }
    return { ticketId, status: "failed", error };
  }
}
