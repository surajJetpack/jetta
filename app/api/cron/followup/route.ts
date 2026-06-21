/**
 * 24-hour follow-up checker. Runs hourly (see vercel.json).
 *
 * For each due follow-up job:
 *   - If the customer has replied since the resolution was sent: re-run the
 *     agent loop so Jetta handles the reply normally.
 *   - If not: send a follow-up message and close the ticket.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getDueFollowUps, clearFollowUp } from "@/lib/kv";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import * as freshdesk from "@/lib/tools/freshdesk";

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
    try {
      const replied = await freshdesk.hasCustomerReplySince(job.ticketId, job.resolutionSentAt);

      if (replied) {
        // Customer responded — let Jetta handle it as a normal turn.
        const ctx = await buildContext(job.ticketId);
        if (ctx.ticket) {
          const result = await runAgentLoop(buildSystemPrompt(ctx), buildMessages(ctx.ticket), ctx);
          handled.push({ ticketId: job.ticketId, action: `replied → handled (${result.toolsUsed.join(",")})` });
        }
      } else {
        // No response — send a closing follow-up, then resolve the ticket.
        await freshdesk.replyToTicket(
          job.ticketId,
          "Following up — I haven't heard back, so I'll assume this is resolved and close the ticket. " +
            "If the issue is still happening, just reply here and I'll pick it straight back up.",
        );
        await freshdesk.closeTicket(job.ticketId, true);
        handled.push({ ticketId: job.ticketId, action: "no reply → closed" });
      }
    } catch (err) {
      handled.push({
        ticketId: job.ticketId,
        action: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      await clearFollowUp(job.ticketId);
    }
  }

  return NextResponse.json({ status: "ok", stubMode: config.stubMode, processed: handled });
}
