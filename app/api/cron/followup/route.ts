/**
 * 24-hour follow-up checker. Runs daily at 09:00 UTC (see vercel.json), so a
 * job fires 24–47h after it was scheduled.
 *
 * For each due follow-up job:
 *   - If the customer has replied since the resolution was sent: re-run the
 *     agent loop so Jetta handles the reply normally.
 *   - If not, and the ticket is still waiting on the customer
 *     (lib/followup-guard.ts): send a follow-up message and close the ticket.
 *   - Otherwise leave it alone — the team owes the next reply.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getDueFollowUps, clearFollowUp, recordOutcome, getEscalationTs } from "@/lib/kv";
import { followUpCloseBlocker } from "@/lib/followup-guard";
import { modelLabel } from "@/lib/llm";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import { recordRun } from "@/lib/runlog";
import { createDraftFromRun } from "@/lib/drafts";
import * as freshdesk from "@/lib/tools/freshdesk";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const due = await getDueFollowUps();
  const handled: { ticketId: string; action: string }[] = [];

  for (const job of due) {
    let keep = false;
    try {
      const replied = await freshdesk.hasCustomerReplySince(job.ticketId, job.resolutionSentAt);

      if (replied) {
        // Customer responded — let Jetta handle it as a normal turn. In draft
        // mode the new reply is held and lands in the review queue like any
        // webhook turn (superseding an older pending draft for this ticket).
        const draftMode = config.replyMode === "draft";
        const ctx = await buildContext(job.ticketId);
        if (ctx.ticket) {
          const started = Date.now();
          const result = await runAgentLoop(
            await buildSystemPrompt(ctx),
            buildMessages(ctx.ticket),
            ctx,
            draftMode ? { holdCustomerWrites: true } : {},
          );
          await recordRun("cron", ctx, result, Date.now() - started);
          const draft = draftMode ? await createDraftFromRun(ctx, result) : null;
          handled.push({
            ticketId: job.ticketId,
            action: `replied → ${draft ? "drafted" : "handled"} (${result.toolsUsed.join(",")})`,
          });
          await recordOutcome({
            ticketId: job.ticketId,
            subject: ctx.ticket.subject,
            at: Math.floor(Date.now() / 1000),
            channel: ctx.channel,
            product: ctx.product,
            app: ctx.app,
            topic: ctx.topic,
            model: result.model,
            toolsUsed: result.toolsUsed,
            replied: !draftMode && result.toolsUsed.includes("reply_to_ticket"),
            resolutionSent: !draftMode && result.resolutionSent,
            escalated: result.toolsUsed.includes("send_escalation"),
            drafted: !!draft,
            kind: "reopened",
          }).catch(() => {});
        }
      } else {
        const block = followUpCloseBlocker(
          await freshdesk.getTicketStatus(job.ticketId),
          !!(await getEscalationTs(job.ticketId)),
        );
        if (block) {
          keep = block.retry;
          handled.push({
            ticketId: job.ticketId,
            action: `no reply → held (${block.reason === "status" ? `status: ${block.status}` : block.reason})`,
          });
          await logOpsEvent({
            level: "info",
            event: "cron.followup_held",
            source: "cron",
            ticketId: job.ticketId,
            data: { ...block },
          });
          continue;
        }
        // No response, still waiting on the customer — send a closing
        // follow-up, then resolve the ticket.
        // Deliberately automatic even in draft mode: the message is a fixed
        // template (not model-generated), and follow-ups are only scheduled
        // when a human sent the resolution (console approve, or the reconciler
        // seeing the draft used), and the guard above has just confirmed the
        // ticket is waiting on the customer.
        await freshdesk.replyToTicket(
          job.ticketId,
          "Following up — I haven't heard back, so I'll assume this is resolved and close the ticket. " +
            "If the issue is still happening, just reply here and I'll pick it straight back up.",
        );
        await freshdesk.closeTicket(job.ticketId, true);
        handled.push({ ticketId: job.ticketId, action: "no reply → closed" });
        await recordOutcome({
          ticketId: job.ticketId,
          at: Math.floor(Date.now() / 1000),
          channel: "freshdesk",
          product: "unknown",
          model: modelLabel(),
          toolsUsed: ["reply_to_ticket", "close_ticket"],
          replied: false,
          resolutionSent: false,
          escalated: false,
          kind: "closed",
        }).catch(() => {});
      }
    } catch (err) {
      handled.push({
        ticketId: job.ticketId,
        action: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
      await logOpsEvent({
        level: "error",
        event: "cron.followup_job_failed",
        source: "cron",
        ticketId: job.ticketId,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      if (!keep) await clearFollowUp(job.ticketId);
    }
  }

  if (due.length) {
    await logOpsEvent({
      level: handled.some((h) => h.action.startsWith("error")) ? "warn" : "info",
      event: "cron.followup_run",
      source: "cron",
      data: { due: due.length, processed: handled },
    });
  }

  return NextResponse.json({ status: "ok", stubMode: config.stubMode, processed: handled });
}
