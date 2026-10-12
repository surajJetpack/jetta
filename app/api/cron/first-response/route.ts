/**
 * Sends the first responses the webhook scheduled (lib/first-response.ts).
 *
 * Every minute: for each reply whose delay has run out, read the ticket FRESH
 * and send only if the thread is where Jetta left it — nobody has replied, no
 * `jetta-hold` tag, not closed, and the customer hasn't written again since.
 * Anything else cancels quietly: a teammate got there first, which is fine.
 *
 * `?dry=1` reports what it would do and writes nothing. Switching
 * JETTA_FIRST_RESPONSE away from "on" stops sends at the next tick; pending
 * ones are cancelled with a note so the announced reply becomes a draft.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import * as freshdesk from "@/lib/tools/freshdesk";
import {
  clearScheduledFirstResponse,
  listScheduledFirstResponses,
  sendDecision,
  type ScheduledFirstResponse,
} from "@/lib/first-response";
import { markEventSeen, unmarkEventSeen, recordOutcome, scheduleFollowUp } from "@/lib/kv";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Customers who can hear from her in one tick, whatever goes wrong upstream. */
const MAX_PER_RUN = 10;
/** A send still failing this long after it was due goes to a person instead. */
const GIVE_UP_MS = 60 * 60_000;

function authorized(req: NextRequest): boolean {
  // Fails CLOSED: a route that writes to customers must never be publicly
  // triggerable because a variable is unset.
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

type Handled = { ticketId: string; action: string; reason?: string };

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const now = Date.now();
  const all = await listScheduledFirstResponses();
  const armed = config.firstResponse === "on";
  // Disarmed: everything pending is due now, to be cancelled, not sent.
  const due = all.filter((j) => !armed || j.sendAt <= now).slice(0, MAX_PER_RUN);
  const handled: Handled[] = [];

  for (const job of due) {
    if (dry) {
      handled.push({ ticketId: job.ticketId, action: armed ? "would_check_and_send" : "would_cancel_disarmed" });
      continue;
    }
    try {
      handled.push(await handle(job, armed, now));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      handled.push({ ticketId: job.ticketId, action: "error", reason: error });
      await logOpsEvent({ level: "error", event: "first_response.failed", source: "cron", ticketId: job.ticketId, data: { error } });
    }
  }

  return NextResponse.json({
    armed,
    dry,
    pending: all.length,
    due: due.length,
    handled,
    upcoming: all
      .filter((j) => j.sendAt > now)
      .map((j) => ({ ticketId: j.ticketId, sendAt: new Date(j.sendAt).toISOString() })),
  });
}

async function handle(job: ScheduledFirstResponse, armed: boolean, now: number): Promise<Handled> {
  const { ticketId } = job;

  if (!armed) {
    await clearScheduledFirstResponse(job);
    await freshdesk
      .addPrivateNote(ticketId, "Jetta did NOT send the first response announced above — first responses were switched off. Use it as a draft.")
      .catch(() => {});
    await cancelled(job, "disarmed");
    return { ticketId, action: "cancelled", reason: "disarmed" };
  }

  // One send per scheduled job, even if two ticks overlap.
  const claim = `firstresponse-send:${ticketId}:${job.createdAt}`;
  if (!(await markEventSeen(claim, 2 * 86400))) return { ticketId, action: "skipped", reason: "claimed" };

  const ticket = await freshdesk.getTicketDetails(ticketId).catch(() => null);
  const decision = sendDecision(job, ticket, ticket ? freshdesk.isTerminalStatus(ticket.status) : false);
  if (decision.action === "cancel") {
    await clearScheduledFirstResponse(job);
    await cancelled(job, decision.reason);
    return { ticketId, action: "cancelled", reason: decision.reason };
  }

  try {
    await freshdesk.replyToTicket(ticketId, freshdesk.markdownToFdHtml(job.body));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (now - job.sendAt > GIVE_UP_MS) {
      await clearScheduledFirstResponse(job);
      await freshdesk
        .addPrivateNote(ticketId, `Jetta could not send the first response announced above (${error}). Please reply to the customer — the text above is ready to use.`)
        .catch(() => {});
      await cancelled(job, "send_failed");
      return { ticketId, action: "gave_up", reason: error };
    }
    await unmarkEventSeen(claim).catch(() => {}); // retried next tick
    throw e;
  }

  await clearScheduledFirstResponse(job);
  if (job.resolutionSent) await scheduleFollowUp(ticketId, new Date().toISOString()).catch(() => {});
  await recordOutcome({
    ticketId,
    subject: job.subject,
    at: Math.floor(Date.now() / 1000),
    channel: "freshdesk",
    product: job.product,
    app: job.app,
    topic: job.topic,
    model: job.model,
    toolsUsed: job.toolsUsed,
    replied: true,
    resolutionSent: job.resolutionSent,
    escalated: job.escalated,
    drafted: false,
    kind: "handled",
  }).catch(() => {});
  await logOpsEvent({
    level: "info",
    event: "first_response.sent",
    source: "cron",
    ticketId,
    data: { lateBySec: Math.round((now - job.sendAt) / 1000), writtenSecAgo: Math.round((now - job.createdAt) / 1000) },
  });
  return { ticketId, action: "sent" };
}

/** The run happened and nothing reached the customer — record it as such. */
async function cancelled(job: ScheduledFirstResponse, reason: string): Promise<void> {
  await recordOutcome({
    ticketId: job.ticketId,
    subject: job.subject,
    at: Math.floor(Date.now() / 1000),
    channel: "freshdesk",
    product: job.product,
    app: job.app,
    topic: job.topic,
    model: job.model,
    toolsUsed: job.toolsUsed,
    replied: false,
    resolutionSent: false,
    escalated: job.escalated,
    drafted: false,
    kind: "handled",
  }).catch(() => {});
  await logOpsEvent({
    level: "info",
    event: "first_response.cancelled",
    source: "cron",
    ticketId: job.ticketId,
    data: { reason },
  });
}
