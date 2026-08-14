/**
 * Human side of a live chat: join a conversation, send a message as yourself,
 * hand it back to Jetta.
 *
 * Admin-gated and deliberately separate from the public /api/chat/* routes —
 * those authenticate a visitor with a conversation token, this authenticates a
 * colleague with a console session. Nothing here is reachable from the widget.
 *
 * The visitor needs no new plumbing to see these messages: the widget's stream
 * already polls the conversation store, so a message appended here arrives the
 * same way one of Jetta's does.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminActor, adminAuthorized } from "@/lib/auth";
import * as store from "@/lib/chat-store";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";

  const { conversationId, action, text } = (await req.json().catch(() => ({}))) as {
    conversationId?: string;
    action?: "join" | "send" | "release";
    text?: string;
  };
  if (!conversationId || !action) {
    return NextResponse.json({ error: "conversationId and action required" }, { status: 400 });
  }

  const conv = await store.getConversation(conversationId);
  if (!conv) return NextResponse.json({ error: "conversation not found or expired" }, { status: 404 });

  if (action === "join") {
    // Taking the conversation is what silences Jetta — see runChatTurn. The
    // visitor is told a person arrived, because a silent change of voice
    // mid-conversation is disorienting.
    await store.updateConversation(conversationId, { status: "human", humanAgent: actor });
    await store.appendMessage(conversationId, "agent", `${actor} has joined the chat.`);
    await logOpsEvent({
      level: "info",
      event: "chat.human_joined",
      source: "console",
      actor,
      ticketId: conversationId,
      data: { waitedMs: conv.humanRequestedAt ? Date.now() - conv.humanRequestedAt : null },
    });
    return NextResponse.json({ ok: true, status: "human" });
  }

  if (action === "send") {
    const body = (text ?? "").trim();
    if (!body) return NextResponse.json({ error: "text required" }, { status: 400 });
    // Sending implies joining: a colleague who types is in the conversation
    // whether or not they pressed the button first, and Jetta must not answer
    // over the top of them.
    if (conv.status !== "human") {
      await store.updateConversation(conversationId, { status: "human", humanAgent: actor });
    }
    await store.appendMessage(conversationId, "agent", body);
    await logOpsEvent({
      level: "info",
      event: "chat.human_replied",
      source: "console",
      actor,
      ticketId: conversationId,
      data: { chars: body.length },
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "release") {
    await store.updateConversation(conversationId, {
      status: "open",
      humanAgent: undefined,
      humanRequestedAt: undefined,
    });
    await logOpsEvent({
      level: "info",
      event: "chat.handed_back",
      source: "console",
      actor,
      ticketId: conversationId,
    });
    return NextResponse.json({ ok: true, status: "open" });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
