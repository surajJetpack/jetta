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
import { getChatSettings } from "@/lib/chat-settings";
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

  /*
   * The same idle rule the session route applies on resume, enforced here too:
   * a tab left open past the window would otherwise keep writing into a
   * conversation the widget would never have resumed on a reload.
   *
   * Deliberately BEFORE the reopen below, and the order is the interesting
   * part: `autoResolveHours` matches `sessionIdleHours` by default, so a
   * conversation the sweep resolved for silence is stale at the same moment
   * and a returning visitor correctly gets a fresh chat rather than being
   * dropped back into a thread whose framing they cannot escape. Reopening is
   * for a conversation resolved EARLY — by a colleague, or because she judged
   * it finished — which is still well inside the resume window.
   */
  const existing = await store.getConversation(conversationId);
  if (existing && store.isStale(existing, (await getChatSettings()).sessionIdleHours)) {
    return await chatJson(req, { expired: true }, { status: 410 });
  }

  const stored = await store.appendMessage(conversationId, "visitor", text, { attachments });
  if (!stored) return await chatJson(req, { expired: true }, { status: 410 });

  /*
   * A visitor writing into a resolved conversation reopens it.
   *
   * "Resolved" is where the console files a finished chat, and it has to mean
   * that or it means nothing: without this the conversation would keep taking
   * messages and keep being answered while sitting in the Resolved bucket,
   * which is the one state the inbox cannot show you. Back to `ticketed` when
   * a ticket carries the issue, else `open`.
   *
   * Before the turn is scheduled, so the run below sees a live conversation.
   */
  let status = existing?.status;
  if (existing?.status === "resolved") {
    const reopened = await store.reopenConversation(conversationId);
    status = reopened?.status ?? status;
    await logOpsEvent({
      level: "info",
      event: "chat.reopened_by_visitor",
      source: "jettachat",
      ticketId: conversationId,
      data: { status, resolvedBy: existing.resolvedBy },
    });
  }

  // Mark this as the newest turn. The debounced run checks it before spending
  // an agent loop, so a burst of messages costs exactly one run.
  await store.setPendingTurn(conversationId, stored.id);

  /*
   * A ticketed conversation still gets a turn.
   *
   * This used to return here without waking her, on the reasoning that the
   * customer had been told the team would email them and the bot should not
   * restart on top of that promise. What it actually produced was a widget with
   * a live composer that accepted a message and then answered nothing — and,
   * worse, a follow-up that reached no one: the ticket carries the transcript
   * as it stood when it was opened, so "it only happens in Safari", typed
   * thirty seconds later, was invisible to the agent holding the ticket.
   *
   * She now answers with add_to_ticket alongside create_support_ticket, so
   * everything said here reaches the team — on the existing ticket if it is
   * the same issue, on its own if it is not. `ticketed` stays in the response:
   * the widget uses it for the banner that tells the visitor where their
   * answer is coming from.
   */
  after(() => runChatTurn(conversationId, stored.id));
  return await chatJson(req, {
    accepted: true,
    // Read AFTER the reopen above, not from `existing`: a ticketed conversation
    // that had been resolved is ticketed again by the time this responds, and
    // taking the flag from the pre-reopen document would drop the widget's
    // "your answer is coming by email" banner on the one message where the
    // visitor most needs to see it.
    ...(status === "ticketed" ? { ticketed: true } : {}),
    message: stored,
  });
}
