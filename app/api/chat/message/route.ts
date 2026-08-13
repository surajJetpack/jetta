/**
 * Accept a visitor message and kick off the (debounced) agent turn.
 *
 * Returns as soon as the message is stored — the reply arrives over the SSE
 * stream, not in this response. Same shape as the Freshdesk webhook: ACK fast,
 * run the agent in `after`, because the loop takes far longer than any
 * reasonable client timeout.
 */
import { NextRequest } from "next/server";
import { after } from "next/server";
import {
  MAX_MESSAGE_CHARS,
  channelUnavailable,
  chatJson,
  overRateLimit,
  preflight,
} from "@/lib/chat-http";
import { runChatTurn } from "@/lib/chat-run";
import { logOpsEvent } from "@/lib/events";
import * as store from "@/lib/chat-store";

export const runtime = "nodejs";
// The agent turn continues in `after` once the response is sent; the function
// must stay alive for the debounce plus the full tool loop.
export const maxDuration = 300;

export async function OPTIONS(req: NextRequest) {
  return preflight(req);
}

export async function POST(req: NextRequest) {
  const blocked = channelUnavailable(req);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return chatJson(req, { error: "invalid JSON" }, { status: 400 });
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const token = typeof body.token === "string" ? body.token : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!conversationId || !store.verifyToken(conversationId, token)) {
    return chatJson(req, { error: "invalid token" }, { status: 403 });
  }
  if (!text) return chatJson(req, { error: "empty message" }, { status: 400 });
  if (text.length > MAX_MESSAGE_CHARS) {
    return chatJson(req, { error: "message too long" }, { status: 413 });
  }
  if (await overRateLimit(req)) {
    await logOpsEvent({
      level: "warn",
      event: "chat.rate_limited",
      source: "jettachat",
      ticketId: conversationId,
    });
    return chatJson(req, { error: "too many messages, please slow down" }, { status: 429 });
  }

  const stored = await store.appendMessage(conversationId, "visitor", text);
  if (!stored) return chatJson(req, { expired: true }, { status: 410 });

  // Mark this as the newest turn. The debounced run checks it before spending
  // an agent loop, so a burst of messages costs exactly one run.
  await store.setPendingTurn(conversationId, stored.id);

  // A conversation that already became a ticket stays a ticket — the customer
  // was told the team would email them, so don't restart the bot on top of it.
  const conv = await store.getConversation(conversationId);
  if (conv?.status === "ticketed") {
    return chatJson(req, { accepted: true, ticketed: true, message: stored });
  }

  after(() => runChatTurn(conversationId, stored.id));
  return chatJson(req, { accepted: true, message: stored });
}
