/**
 * Freshchat event handler — the chat-channel entrypoint.
 *
 * Freddy (the front-line bot) answers FAQs; when it hands a conversation off
 * to Jetta's agent/group, this route picks it up and runs the agent loop.
 *
 * Lifecycle:
 *   1. Verify the RSA signature (X-Freshchat-Signature over the raw body).
 *   2. Decide whether the event warrants a run (decision tree below).
 *   3. Dedupe deliveries (idempotency via KV), debounce rapid messages.
 *   4. Assemble context (channel "freshchat"), run the agent loop.
 *
 * No follow-up scheduling: chats resolve in-session (see FollowUpJob TODO).
 * Ignored events return 200 — Freshchat retries non-2xx responses, and a
 * retried "ignored" is just noise.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { config } from "@/lib/config";
import { buildContext, buildMessages } from "@/lib/context";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { runAgentLoop } from "@/lib/agent";
import { markEventSeen, recordOutcome } from "@/lib/kv";
import { recordRun } from "@/lib/runlog";
import { isAssignedToJetta, getLatestUserMessageId } from "@/lib/tools/freshchat";

export const runtime = "nodejs";
export const maxDuration = 300;

// ── Payload shapes (docs-derived; verified against captured traffic in rollout) ──

interface FcWebhookMessage {
  id?: string;
  conversation_id?: string;
  actor_type?: string;
  actor_id?: string;
  message_type?: string;
}

interface FcWebhookPayload {
  actor?: { actor_type?: string; actor_id?: string };
  action?: string;
  action_time?: string;
  data?: {
    message?: FcWebhookMessage;
    assignment?: {
      conversation_id?: string;
      to_agent_id?: string;
      to_group_id?: string;
      // Some payload versions nest the conversation instead.
      conversation?: { conversation_id?: string; assigned_agent_id?: string; assigned_group_id?: string };
    };
  };
}

/**
 * Verify X-Freshchat-Signature: RSA-SHA256 over the raw body, base64, checked
 * against the public key from the Freshchat admin console. When no key is
 * configured we allow (local/stub testing), matching the Freshdesk route's
 * shared-secret behavior.
 */
function verifySignature(raw: string, signature: string | null): boolean {
  const key = config.freshchat.webhookPublicKey;
  if (!key) return true;
  if (!signature) return false;
  try {
    const pem = key.replace(/\\n/g, "\n"); // PEM stored in env with escaped newlines
    return crypto.createVerify("RSA-SHA256").update(raw).end().verify(pem, signature, "base64");
  } catch (e) {
    console.error("Freshchat signature verification errored:", e);
    return false;
  }
}

function ignored(reason: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ status: `ignored: ${reason}`, ...extra });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-freshchat-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: FcWebhookPayload;
  try {
    payload = JSON.parse(raw) as FcWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = payload.action ?? "";

  // ── message_create: a new message in some conversation ──
  if (action === "message_create") {
    const msg = payload.data?.message ?? {};
    const convId = msg.conversation_id;
    const msgId = msg.id;
    if (!convId || !msgId) return ignored("message missing conversation_id or id");

    // CRITICAL loop prevention: act only on customer messages. This filters
    // Jetta's own outbound messages, human agents, and Freddy. Belt-and-braces:
    // also drop anything from Jetta's own actor id regardless of actor_type.
    if (msg.actor_type !== "user") return ignored("non-user message", { convId });
    if (config.freshchat.agentId && msg.actor_id === config.freshchat.agentId) {
      return ignored("own message", { convId });
    }
    if (msg.message_type === "private") return ignored("private message", { convId });

    if (!(await markEventSeen(`fc:msg:${msgId}`))) {
      return ignored("duplicate delivery", { convId });
    }

    // Only conversations Freddy handed off to Jetta's agent/group are ours.
    if (!(await isAssignedToJetta(convId))) {
      return ignored("conversation not assigned to Jetta", { convId });
    }

    // Debounce: customers often send several short messages in a burst. Wait,
    // then only run for the newest user message — earlier deliveries exit here
    // and the final one runs against the full refetched history.
    if (config.freshchat.debounceSeconds > 0) {
      await sleep(config.freshchat.debounceSeconds * 1000);
      const latest = await getLatestUserMessageId(convId, msgId).catch(() => msgId);
      if (latest && latest !== msgId) {
        return ignored("superseded by a newer message", { convId });
      }
    }

    return runPipeline(convId);
  }

  // ── conversation_assignment: the Freddy hand-off trigger ──
  // The customer's last message predates the assignment, so no message_create
  // will fire for it; without this branch Jetta sits silent until the customer
  // types again.
  if (action === "conversation_assignment") {
    const a = payload.data?.assignment ?? {};
    const convId = a.conversation_id ?? a.conversation?.conversation_id;
    if (!convId) return ignored("assignment missing conversation_id");

    const toAgent = a.to_agent_id ?? a.conversation?.assigned_agent_id;
    const toGroup = a.to_group_id ?? a.conversation?.assigned_group_id;
    const { agentId, handoffGroupId } = config.freshchat;
    const mine =
      (!!agentId && toAgent === agentId) || (!!handoffGroupId && toGroup === handoffGroupId);
    // Payload versions vary in how assignment is expressed; when the event
    // doesn't say, fall back to asking the API who owns the conversation.
    if (!mine && (toAgent || toGroup)) return ignored("assigned to someone else", { convId });
    if (!mine && !(await isAssignedToJetta(convId))) {
      return ignored("conversation not assigned to Jetta", { convId });
    }

    if (!(await markEventSeen(`fc:assign:${convId}:${payload.action_time ?? ""}`))) {
      return ignored("duplicate delivery", { convId });
    }

    return runPipeline(convId);
  }

  return ignored(`unhandled action "${action || "(none)"}"`);
}

/** Assemble context and run the agent loop — mirrors the Freshdesk webhook body. */
async function runPipeline(convId: string) {
  try {
    const ctx = await buildContext(convId, "freshchat");
    if (!ctx.ticket) {
      return NextResponse.json({ error: "conversation not found", convId }, { status: 404 });
    }

    // Product filter (controlled rollout): skip before the agent ever runs.
    // The conversation stays with Freddy / the human queue.
    if (config.productFilter.length && !config.productFilter.includes(ctx.product)) {
      return NextResponse.json({
        status: `skipped — product "${ctx.product}" not in JETTA_PRODUCTS`,
        convId,
        product: ctx.product,
      });
    }

    const messages = buildMessages(ctx.ticket, "freshchat");
    const system = await buildSystemPrompt(ctx);
    const started = Date.now();
    // Draft mode (JETTA_REPLY_MODE) is intentionally Freshdesk-webhook-only:
    // chat is synchronous, so a human review queue makes no sense mid-conversation.
    const result = await runAgentLoop(system, messages, ctx);
    await recordRun("webhook", ctx, result, Date.now() - started);

    if (result.blockedByAllowlist) {
      return NextResponse.json({
        status: "skipped — conversation not on JETTA_TICKET_ALLOWLIST (forced dry-run, no writes)",
        convId,
        toolsUsed: result.toolsUsed,
      });
    }

    // No scheduleFollowUp on chat: conversations resolve in-session, and the
    // follow-up cron's reply/close path is Freshdesk-only.
    const replied = result.toolsUsed.includes("reply_to_ticket");
    await recordOutcome({
      ticketId: convId,
      subject: ctx.ticket.subject,
      at: Math.floor(Date.now() / 1000),
      channel: "freshchat",
      product: ctx.product,
      model: result.model,
      toolsUsed: result.toolsUsed,
      replied,
      resolutionSent: result.resolutionSent,
      escalated: result.toolsUsed.includes("send_escalation"),
      kind: "handled",
    }).catch((e) => console.warn("recordOutcome failed:", e));

    return NextResponse.json({
      status: "handled",
      convId,
      toolsUsed: result.toolsUsed,
      resolutionSent: result.resolutionSent,
      reply: result.text,
    });
  } catch (err) {
    console.error(`Freshchat webhook handling failed for conversation ${convId}:`, err);
    return NextResponse.json(
      { error: "handler failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// Lightweight health check for the webhook endpoint.
export async function GET() {
  return NextResponse.json({
    ok: true,
    stubMode: config.stubMode,
    freshchatLive: config.freshchat.live,
  });
}
