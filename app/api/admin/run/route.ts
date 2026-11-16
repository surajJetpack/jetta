/**
 * "Run a ticket through Jetta", used by the System page. A dry run is open to
 * any signed-in user; a live run (`dryRun: false`) is admin only.
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
import { adminActor, adminAuthorized } from "@/lib/auth";
import { requireAdmin } from "@/lib/roles";
import { logOpsEvent } from "@/lib/events";
import { recordRun } from "@/lib/runlog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    ticketId?: string;
    dryRun?: boolean;
    channel?: "freshdesk" | "freshchat";
    /** Explicit model tier for A/B comparison (light vs standard). */
    tier?: "light" | "standard";
  };
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
  const channel = body.channel === "freshchat" ? "freshchat" : "freshdesk";

  // A preview is anyone's. A live run posts on a real ticket, can file on the
  // dev board and escalate in Slack, and has no idempotency gate, so it is an
  // admin's — and it is written down who started it, which the run log alone
  // ("console") never said.
  if (!dryRun) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    await logOpsEvent({
      level: "warn",
      event: "console.live_run",
      source: "console",
      ticketId,
      data: { actor: adminActor(req) ?? "console", channel, tier: body.tier },
    });
  }

  try {
    const ctx = await buildContext(ticketId, channel);
    if (!ctx.ticket) {
      return NextResponse.json({ error: "ticket not found", ticketId }, { status: 404 });
    }

    const started = Date.now();
    const result = await runAgentLoop(
      await buildSystemPrompt(ctx),
      buildMessages(ctx.ticket, channel),
      ctx,
      { dryRun, tier: body.tier === "light" || body.tier === "standard" ? body.tier : undefined },
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
      model: result.model,
      channel,
      dryRun: result.dryRun,
      freshdeskLive: config.freshdesk.live,
      freshchatLive: config.freshchat.live,
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
