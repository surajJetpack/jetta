/**
 * Context assembly: pull together the ticket, the customer's FastSpring account,
 * and any existing monday.com Dev items, then shape the conversation history
 * into the message array handed to the Claude loop.
 */
import type { ModelMessage } from "ai";
import type { ConversationContext, Product, Ticket } from "./types";
import * as freshdesk from "./tools/freshdesk";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";

/** Cheap heuristic to attribute a ticket to a product. */
export function inferProduct(text: string): Product {
  const t = text.toLowerCase();
  if (/getsign|e-?sign|signature|mapping/.test(t)) return "getsign";
  if (/jetpack|monday\.com|marketplace|widget|board/.test(t)) return "jetpackapps";
  return "unknown";
}

/**
 * Assemble full context for a Freshdesk/Freshchat ticket.
 * Account and dev-item lookups are best-effort — a failure there shouldn't block
 * Jetta from replying.
 */
export async function buildContext(
  ticketId: string,
  channel: "freshdesk" | "freshchat" = "freshdesk",
): Promise<ConversationContext> {
  const ticket = await freshdesk.getTicketDetails(ticketId);
  const product = inferProduct(`${ticket.subject}\n${ticket.description}`);

  const account = ticket.requesterEmail
    ? await fastspring.getFastSpringAccount(ticket.requesterEmail).catch(() => null)
    : null;

  const relatedDevItems = await monday
    .searchDevBoard(ticket.subject)
    .catch(() => []);

  return { channel, ticket, account, relatedDevItems, product };
}

/**
 * Build the conversation message array from the ticket.
 *
 * The opening message carries the ticket subject + description as the customer's
 * first turn. Subsequent public replies are mapped to user/assistant turns;
 * private notes are dropped (they are internal and would confuse the model).
 */
export function buildMessages(ticket: Ticket): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `[New ticket]\nSubject: ${ticket.subject}\n\n${ticket.description}`,
    },
  ];

  for (const reply of ticket.replies) {
    if (reply.isPrivate) continue;
    messages.push({
      role: reply.author === "customer" ? "user" : "assistant",
      content: reply.body,
    });
  }

  // The API requires the conversation to end on a user turn for Jetta to act.
  // If the last public message was Jetta's own, append a nudge so she
  // re-evaluates rather than the request being rejected.
  const last = messages[messages.length - 1];
  if (last.role === "assistant") {
    messages.push({
      role: "user",
      content: "[system] Re-evaluate this ticket and take the next appropriate action.",
    });
  }

  return messages;
}
