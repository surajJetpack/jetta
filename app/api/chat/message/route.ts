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
import { claimPending, MAX_FILES_PER_MESSAGE } from "@/lib/chat-files";
import { logOpsEvent } from "@/lib/events";
import * as store from "@/lib/chat-store";

export const runtime = "nodejs";
// The agent turn continues in `after` once the response is sent; the function
// must stay alive for the debounce plus the full tool loop.
export const maxDuration = 300;

export async function OPTIONS(req: NextRequest) {
  return await preflight(req);
}

export async function POST(req: NextRequest) {
  const blocked = await channelUnavailable(req);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return await chatJson(req, { error: "invalid JSON" }, { status: 400 });
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const token = typeof body.token === "string" ? body.token : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const uploadIds = Array.isArray(body.uploadIds)
    ? body.uploadIds.filter((v): v is string => typeof v === "string").slice(0, MAX_FILES_PER_MESSAGE)
    : [];

  if (!conversationId || !store.verifyToken(conversationId, token)) {
    return await chatJson(req, { error: "invalid token" }, { status: 403 });
  }
  // A screenshot with no caption is a complete message — people send the
  // picture and expect it to be understood.
  if (!text && !uploadIds.length) {
    return await chatJson(req, { error: "empty message" }, { status: 400 });
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return await chatJson(req, { error: "message too long" }, { status: 413 });
  }
  if (await overRateLimit(req)) {
    await logOpsEvent({
      level: "warn",
      event: "chat.rate_limited",
      source: "jettachat",
      ticketId: conversationId,
    });
    return await chatJson(req, { error: "too many messages, please slow down" }, { status: 429 });
  }

  // Attachments are rehydrated from the server-side record the upload route
  // parked, never from the request body: the vision description is prompt text
  // the model trusts, so the visitor never gets to write it.
  const attachments = uploadIds.length ? await claimPending(conversationId, uploadIds) : [];
  if (uploadIds.length && !attachments.length && !text) {
    // Every file expired or was already claimed, and there is nothing else to
    // send — better to say so than to post an empty turn.
    return await chatJson(req, { error: "that upload expired — try attaching it again" }, { status: 410 });
  }

  const stored = await store.appendMessage(conversationId, "visitor", text, { attachments });
  if (!stored) return await chatJson(req, { expired: true }, { status: 410 });

  // Mark this as the newest turn. The debounced run checks it before spending
  // an agent loop, so a burst of messages costs exactly one run.
  await store.setPendingTurn(conversationId, stored.id);

  // A conversation that already became a ticket stays a ticket — the customer
  // was told the team would email them, so don't restart the bot on top of it.
  const conv = await store.getConversation(conversationId);
  if (conv?.status === "ticketed") {
    return await chatJson(req, { accepted: true, ticketed: true, message: stored });
  }

  after(() => runChatTurn(conversationId, stored.id));
  return await chatJson(req, { accepted: true, message: stored });
}
