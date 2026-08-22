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
import { openTicketForConversation, suggestedSubject } from "@/lib/chat-ticket";
import { logOpsEvent } from "@/lib/events";
import { chatBrandKey } from "@/lib/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read side for the console.
 *   ?id=…    one conversation, polled while someone has it open
 *   ?waiting=1  how many visitors are waiting for a person, for the nav badge
 *
 * Polled rather than streamed: the visitor-facing SSE route exists because a
 * widget must feel instant, while a colleague reading a transcript is served
 * fine by a few seconds' delay — and polling costs nothing to keep alive
 * across a serverless boundary.
 */
export async function GET(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const conv = await store.getConversation(id);
    if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ conversation: { ...conv, brandKey: chatBrandKey(conv) } });
  }
  if (req.nextUrl.searchParams.get("waiting")) {
    const convs = await store.listConversations(100);
    return NextResponse.json({
      waiting: convs.filter((c) => c.status === "waiting_human").length,
      live: convs.filter((c) => c.status === "human").length,
    });
  }
  const conversations = await store.listConversations(100);
  return NextResponse.json({
    conversations: conversations.map((c) => ({ ...c, brandKey: chatBrandKey(c) })),
  });
}

export async function POST(req: NextRequest) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = adminActor(req) ?? "console";

  const { conversationId, action, text, subject, notify } = (await req.json().catch(() => ({}))) as {
    conversationId?: string;
    action?: "join" | "send" | "release" | "ticket";
    text?: string;
    subject?: string;
    notify?: boolean;
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
    await store.appendMessage(conversationId, "agent", `${actor} has joined the chat.`, {
      via: "human",
      authorName: actor,
      system: true,
    });
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
    await store.appendMessage(conversationId, "agent", body, { via: "human", authorName: actor });
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

  if (action === "ticket") {
    // Already converted: hand back the existing ticket rather than opening a
    // second one. Two tickets for one conversation is worse than none — the
    // customer gets two threads and the team argues about which is live.
    if (conv.ticketId) {
      return NextResponse.json({ ok: true, ticketId: conv.ticketId, alreadyTicketed: true });
    }
    const email = conv.visitor.email?.trim();
    if (!email) {
      return NextResponse.json(
        { error: "This visitor never gave an email address, so a ticket would have nobody to reply to." },
        { status: 400 },
      );
    }

    let created;
    try {
      created = await openTicketForConversation(conv, {
        email,
        subject: (subject ?? "").trim() || suggestedSubject(conv),
        summary: (text ?? "").trim() || "Converted from a live chat by the support team.",
        actor,
      });
    } catch (e) {
      // Surfaced to the person who pressed the button, verbatim. The whole
      // reason this button exists is that a ticket failure used to be visible
      // only as Jetta apologising to a customer.
      const message = e instanceof Error ? e.message : String(e);
      await logOpsEvent({
        level: "error",
        event: "chat.ticket_failed",
        source: "console",
        actor,
        ticketId: conversationId,
        data: { error: message.slice(0, 600) },
      });
      return NextResponse.json({ error: `Freshdesk refused the ticket: ${message}` }, { status: 502 });
    }

    // syncMark, not "now": a visitor typing while Freshdesk took the ticket is
    // in neither the transcript it carries nor a delta measured from the clock.
    // Same rule as Jetta's own create path — the whole reason chat-ticket.ts
    // has one function is that this button and that tool must not drift.
    await store.updateConversation(conversationId, {
      status: "ticketed",
      ticketId: created.id,
      lastTicketSyncAt: created.syncMark,
    });

    // Jetta keeps answering a ticketed conversation, but she will not announce
    // a ticket she did not open — so without this the visitor never learns
    // their question moved, and the chat quietly changes meaning underneath
    // them. The message says it plainly, and says the chat is still open.
    if (notify !== false) {
      await store.appendMessage(
        conversationId,
        "agent",
        `${actor} has passed this to the support team — they'll reply by email to ${email}. ` +
          `You can carry on here in the meantime.`,
        { via: "human", authorName: actor, system: true },
      );
    }

    await logOpsEvent({
      level: "info",
      event: "chat.ticketed_by_human",
      source: "console",
      actor,
      ticketId: conversationId,
      data: { freshdeskTicket: created.id, notified: notify !== false },
    });
    return NextResponse.json({ ok: true, ticketId: created.id, url: created.url });
  }

  if (action === "release") {
    // Back to the state she was in before a person took it. A conversation
    // that already has a ticket must return to `ticketed`, not `open`: the
    // status is what the console filters and /today read, and demoting it
    // would resurrect a row that duplicates the Freshdesk ticket. Jetta answers
    // in both states — the difference is which escalation tool she holds, and
    // that keys off the ticket id, not the status.
    const conv = await store.getConversation(conversationId);
    await store.updateConversation(conversationId, {
      status: conv?.ticketId ? "ticketed" : "open",
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
    return NextResponse.json({ ok: true, status: conv?.ticketId ? "ticketed" : "open" });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
