/**
 * Backstop for a customer reply the webhook missed. Runs daily at 09:00 UTC
 * (see vercel.json), so a job fires 24–47h after it was scheduled.
 *
 * For each due job: if the customer has replied since the resolution was
 * sent and the webhook never answered it, run Jetta on it now. A silent
 * customer is no longer handled here — this used to send a fixed "I'll assume
 * this is resolved" and close, which reads as a form letter and could not see
 * a colleague's own follow-up (ticket 14520 got both). Following up with a
 * quiet customer is app/api/cron/ticket-followup's job.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getDueFollowUps, clearFollowUp, recordOutcome, markEventSeen, unmarkEventSeen } from "@/lib/kv";
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
    // Released if the run fails, so the webhook can still answer the message.
    let claimedMarker: string | null = null;
    try {
      const replied = await freshdesk.hasCustomerReplySince(job.ticketId, job.resolutionSentAt);

      if (replied) {
        // Customer responded — let Jetta handle it as a normal turn, unless the
        // webhook already has. It almost always has: the cron fires a day or
        // more later, and re-running then posted a duplicate note + draft 37h
        // after the fact (ticket 14404). Claiming the webhook's own marker
        // makes this a backstop for a webhook that never ran or failed (a
        // failed run releases its marker), and stops a later webhook re-run.
        // In draft mode the new reply is held and lands in the review queue
        // like any webhook turn (superseding an older pending draft).
        const draftMode = config.replyMode === "draft";
        const ctx = await buildContext(job.ticketId);
        const marker = ctx.ticket ? freshdesk.customerMessageMarker(job.ticketId, ctx.ticket) : null;
        if (marker && !(await markEventSeen(marker, freshdesk.CUSTOMER_MSG_MARKER_TTL))) {
          handled.push({ ticketId: job.ticketId, action: "replied → already handled by webhook" });
        } else if (ctx.ticket) {
          claimedMarker = marker;
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
        // Customer still silent: nothing to do here any more. Following up
        // with them — the check-in, the nudge and the close — is the
        // ticket-followup cron's job (lib/ticket-followup.ts), which watches
        // every ticket we answered, not only the ones flagged as resolutions.
        handled.push({ ticketId: job.ticketId, action: "no reply → left to ticket-followup" });
      }
    } catch (err) {
      if (claimedMarker) await unmarkEventSeen(claimedMarker).catch(() => {});
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
      await clearFollowUp(job.ticketId);
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
