/**
 * Context assembly: pull together the ticket, the customer's FastSpring account,
 * and any existing monday.com Dev items, then shape the conversation history
 * into the message array handed to the Claude loop.
 */
import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { ConversationContext, Product, Ticket } from "./types";
import { config } from "./config";
import { getModel } from "./llm";
import * as freshdesk from "./tools/freshdesk";
import * as freshchat from "./tools/freshchat";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";

/** Cheap heuristic to attribute a ticket to a product. */
export function inferProduct(text: string): Product {
  const t = text.toLowerCase();
  if (/getsign|e-?sign|signature|mapping/.test(t)) return "getsign";
  if (/jetpack|monday\.com|marketplace|widget|board/.test(t)) return "jetpackapps";
  return "unknown";
}

const CLASSIFY_SYSTEM = `You attribute customer support tickets to a product.

Products:
- "getsign" — GetSign (getsign.io), the e-signature app for monday.com: signing documents, signature requests, templates, field mapping, signed-document sync.
- "jetpackapps" — Jetpack Apps (jetpackapps.io), the monday.com marketplace app portfolio: widgets, dashboards, integrations and other marketplace apps.
- "unknown" — genuinely impossible to tell from the text (pure billing/account questions with no product hints, empty tickets).

Pick the single most likely product from the ticket's content and phrasing. Prefer a product over "unknown" when the text leans one way, even without an explicit product name.`;

/**
 * LLM fallback when the keyword heuristic can't attribute the ticket — many
 * tickets never name the product ("can't log in", "refund please"), so the
 * model decides from the request context instead. Fails soft to "unknown".
 */
export async function classifyProduct(subject: string, description: string): Promise<Product> {
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: z.object({
        product: z.enum(["getsign", "jetpackapps", "unknown"]),
      }),
      system: CLASSIFY_SYSTEM,
      prompt: `Subject: ${subject}\n\n${description.slice(0, 2000)}`,
    });
    return object.product;
  } catch (e) {
    console.warn("Product classification failed, keeping 'unknown':", e);
    return "unknown";
  }
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
  const ticket =
    channel === "freshchat"
      ? await freshchat.getConversationAsTicket(ticketId)
      : await freshdesk.getTicketDetails(ticketId);
  let product = inferProduct(`${ticket.subject}\n${ticket.description}`);
  if (product === "unknown" && !config.stubMode) {
    product = await classifyProduct(ticket.subject, ticket.description);
  }

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
export function buildMessages(
  ticket: Ticket,
  channel: "freshdesk" | "freshchat" = "freshdesk",
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content:
        channel === "freshchat"
          ? `[Live chat — handed off to you by the front-line bot]\n\n${ticket.description}`
          : `[New ticket]\nSubject: ${ticket.subject}\n\n${ticket.description}`,
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
