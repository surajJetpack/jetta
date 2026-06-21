/**
 * Admin "run a ticket through Jetta" endpoint, used by the ops dashboard.
 *
 * Unlike /api/webhook this has no idempotency gate (so you can re-run the same
 * ticket) and supports `dryRun` to preview Jetta's actions without any external
 * writes. Returns the ticket summary, the full tool trace, and the reply.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import { modelLabel } from "@/lib/llm";
import { adminAuthorized } from "@/lib/auth";
import { recordRun } from "@/lib/runlog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { ticketId?: string; dryRun?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const ticketId = body.ticketId?.toString().trim();
  if (!ticketId) {
    return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  }
  const dryRun = body.dryRun !== false; // default to safe preview

  try {
    const ctx = await buildContext(ticketId);
    if (!ctx.ticket) {
      return NextResponse.json({ error: "ticket not found", ticketId }, { status: 404 });
    }

    const started = Date.now();
    const result = await runAgentLoop(
      buildSystemPrompt(ctx),
      buildMessages(ctx.ticket),
      ctx,
      { dryRun },
    );
    const durationMs = Date.now() - started;
    await recordRun("console", ctx, result, durationMs);

    return NextResponse.json({
      ticket: {
        id: ctx.ticket.id,
        subject: ctx.ticket.subject,
        status: ctx.ticket.status,
        requester: ctx.ticket.requesterName,
        product: ctx.product,
      },
      model: modelLabel(),
      dryRun: result.dryRun,
      blockedByAllowlist: result.blockedByAllowlist,
      freshdeskLive: config.freshdesk.live,
      durationMs,
      resolutionSent: result.resolutionSent,
      // The customer-facing reply is the reply_to_ticket body, not the model's
      // trailing wrap-up text. Surface that; fall back to the final text.
      reply:
        ([...result.trace].reverse().find((t) => t.tool === "reply_to_ticket")?.input as
          | { body?: string }
          | undefined)?.body ?? result.text,
      trace: result.trace,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "run failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
