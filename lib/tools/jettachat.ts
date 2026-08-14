/**
 * JettaChat tool client — first-party chat conversations adapted into the
 * `Ticket` shape, so the whole agent pipeline (context → messages → tools)
 * works unchanged on this channel, exactly as the Freshchat adapter does.
 *
 * The difference from every other adapter in this directory: there is no
 * external API. The conversation lives in our own Redis (lib/chat-store.ts),
 * so there is no `*_LIVE` stub path to fall back to — the store's own
 * in-memory fallback already covers credential-less runs, and reads/writes
 * here are always "real".
 */
import { config } from "../config";
import * as store from "../chat-store";
import { toChatText } from "./freshchat";
import { textWithAttachments } from "../chat-files";
import type { ChatConversation, Ticket, TicketReply } from "../types";

/** Re-exported so callers have one import for the chat text flattening. */
export { toChatText };

/**
 * Adapt a stored conversation into the `Ticket` shape:
 * - subject     = first visitor message, one line, truncated, prefixed [Chat]
 * - description = full first visitor message
 * - replies     = every later turn
 * - productHint = the monday app the widget is embedded in, when known
 *
 * That last line is the whole reason this channel is worth owning. On monday
 * the widget knows which app the visitor is sitting in, so `productHint` gets
 * populated the same way Freshdesk's cf_product field does — and the existing
 * attribution precedence in buildContext treats it as ground truth, routing
 * the billing lookup and dev-board search correctly on the first turn.
 */
export function conversationToTicket(conv: ChatConversation): Ticket {
  const visitorTurns = conv.messages.filter((m) => m.author === "visitor");
  // Attachments are folded into the message text as their description. That is
  // how they reach the model at all: the answering tier is not assumed to be
  // multimodal, so the image was turned into words at upload time and travels
  // as part of the turn that carried it.
  const opening = visitorTurns[0]
    ? textWithAttachments(visitorTurns[0].text, visitorTurns[0].attachments)
    : "";
  // Subject comes from what the visitor TYPED. A chat that opens with a bare
  // screenshot would otherwise be titled with the vision pass's description,
  // which reads as a sentence about a dialog box rather than a support request.
  const typedLine = (visitorTurns.find((m) => m.text.trim())?.text ?? "").split("\n")[0] ?? "";
  const openingLine = typedLine.trim() || (visitorTurns[0]?.attachments?.length ? "Screenshot from a chat" : "");
  const subject = `[Chat] ${openingLine.slice(0, 80)}${openingLine.length > 80 ? "…" : ""}`;

  const firstVisitorId = visitorTurns[0]?.id;
  const replies: TicketReply[] = conv.messages
    .filter((m) => m.id !== firstVisitorId)
    .map((m) => ({
      author: m.author === "visitor" ? ("customer" as const) : ("agent" as const),
      authorEmail: m.author === "visitor" ? (conv.visitor.email ?? null) : null,
      body: textWithAttachments(m.text, m.attachments),
      createdAt: m.createdAt,
      isPrivate: false,
    }))
    .filter((r) => r.body.length > 0);

  return {
    id: conv.id,
    subject,
    description: opening || "(no message text)",
    status: conv.status === "open" ? "open" : conv.status,
    requesterName: conv.visitor.name ?? null,
    requesterEmail: conv.visitor.email ?? null,
    productHint: conv.visitor.app && conv.visitor.app !== "unknown" ? conv.visitor.app : null,
    replies,
  };
}

/** Fetch + adapt. Throws when the conversation has expired or never existed. */
export async function getConversationAsTicket(conversationId: string): Promise<Ticket> {
  const conv = await store.getConversation(conversationId);
  if (!conv) throw new Error(`JettaChat conversation ${conversationId} not found (expired?)`);
  return conversationToTicket(conv);
}

/**
 * Send a customer-visible chat message. Markdown is flattened to plain text —
 * the widget renders text, and the model writes ticket-flavored markdown by
 * default however firmly the prompt asks otherwise.
 */
export async function replyToConversation(conversationId: string, body: string): Promise<void> {
  const stored = await store.appendMessage(conversationId, "agent", toChatText(body));
  if (!stored) throw new Error(`JettaChat conversation ${conversationId} not found — message not delivered.`);
}

/** Mark the conversation resolved. */
export async function resolveConversation(conversationId: string): Promise<void> {
  await store.updateConversation(conversationId, { status: "resolved" });
}

/** Deep link to the transcript in Jetta's own console (for escalations). */
export function conversationUrl(conversationId: string): string {
  return config.appUrl
    ? `${config.appUrl}/chats/${conversationId}`
    : `(jettachat conversation ${conversationId})`;
}
