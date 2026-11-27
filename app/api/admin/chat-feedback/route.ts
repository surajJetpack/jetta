/**
 * The team's 👍 / 👎 on Jetta's chat replies (lib/chat-feedback.ts).
 *
 *   GET    ?conversation=…                             → { ratings } on that conversation
 *   POST   { conversationId, messageId, rating, reasons?, note? }
 *   DELETE { conversationId, messageId }               take your own rating back
 *
 * Anyone who can open Chats may rate, like reading a transcript. The reply
 * and the customer's message are copied from the stored conversation, never
 * from the request, so a rating always quotes what was really said.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminActor, adminAuthorized } from "@/lib/auth";
import * as store from "@/lib/chat-store";
import { logOpsEvent } from "@/lib/events";
import { chatFeedbackFor, chatFeedbackId, deleteChatFeedback, parseChatRating, replyContext, saveChatFeedback } from "@/lib/chat-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("conversation");
  if (!id) return NextResponse.json({ error: "conversation required" }, { status: 400 });
  const me = adminActor(req);
  const ratings = (await chatFeedbackFor(id)).map((f) => ({
    messageId: f.messageId,
    author: f.author,
    mine: f.author === me,
    rating: f.rating,
    reasons: f.reasons,
    note: f.note,
  }));
  return NextResponse.json({ ratings });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const author = adminActor(req) ?? "unknown";
  const parsed = parseChatRating(await req.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const conv = await store.getConversation(parsed.conversationId);
  if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  const ctx = replyContext(conv.messages, parsed.messageId);
  if (!ctx) return NextResponse.json({ error: "only Jetta's own replies can be rated" }, { status: 400 });
  await saveChatFeedback({
    id: chatFeedbackId(parsed.conversationId, parsed.messageId, author),
    conversationId: parsed.conversationId,
    messageId: parsed.messageId,
    at: new Date().toISOString(),
    author,
    rating: parsed.rating,
    reasons: parsed.reasons,
    ...(parsed.note ? { note: parsed.note } : {}),
    ...ctx,
    ...(conv.app || conv.visitor.app ? { app: conv.app || conv.visitor.app } : {}),
    ...(conv.visitor.name ? { visitorName: conv.visitor.name } : {}),
  });
  await logOpsEvent({
    level: "info",
    event: "chat.feedback",
    source: "console",
    actor: author,
    data: { conversation: parsed.conversationId, rating: parsed.rating, reasons: parsed.reasons.join(",") },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { conversationId?: unknown; messageId?: unknown } | null;
  if (!body || typeof body.conversationId !== "string" || typeof body.messageId !== "string") {
    return NextResponse.json({ error: "conversationId and messageId required" }, { status: 400 });
  }
  await deleteChatFeedback(chatFeedbackId(body.conversationId, body.messageId, adminActor(req) ?? "unknown"));
  return NextResponse.json({ ok: true });
}
