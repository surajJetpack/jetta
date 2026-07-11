/**
 * Context assembly: pull together the ticket, the customer's FastSpring account,
 * and any existing monday.com Dev items, then shape the conversation history
 * into the message array handed to the Claude loop.
 */
import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { ConversationContext, Product, TaskUsage, Ticket } from "./types";
import { config } from "./config";
import { getModel, modelLabel } from "./llm";
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

const TRIAGE_SYSTEM = `You triage customer support tickets: attribute them to a product and rate their complexity.

Products:
- "getsign" — GetSign (getsign.io), the e-signature app for monday.com: signing documents, signature requests, templates, field mapping, signed-document sync.
- "jetpackapps" — Jetpack Apps (jetpackapps.io), the monday.com marketplace app portfolio: widgets, dashboards, integrations and other marketplace apps.
- "unknown" — genuinely impossible to tell from the text (pure billing/account questions with no product hints, empty tickets).

Pick the single most likely product from the ticket's content and phrasing. Prefer a product over "unknown" when the text leans one way, even without an explicit product name.

Complexity:
- "simple" — a single, clearly-stated question likely answerable from documentation: a how-to, a pricing/plan question, a plain factual billing lookup.
- "standard" — anything else: multiple issues, technical debugging, error reports, angry or escalation-prone tone, refunds needing judgment, or unclear requests. When in doubt, "standard".`;

export interface TicketTriage {
  product: Product;
  complexity: "simple" | "standard";
}

/**
 * One light-model call per ticket: product attribution (fallback when the
 * keyword heuristic can't decide) + a complexity rating used for model
 * routing and analytics. Fails soft to {unknown, standard} — failures must
 * never block a run, and unknown complexity routes to the strong model.
 */
export async function triageTicket(
  subject: string,
  description: string,
  usageSink?: TaskUsage[],
): Promise<TicketTriage> {
  try {
    const { object, usage } = await generateObject({
      model: getModel("light"),
      schema: z.object({
        product: z.enum(["getsign", "jetpackapps", "unknown"]),
        complexity: z.enum(["simple", "standard"]),
      }),
      system: TRIAGE_SYSTEM,
      prompt: `Subject: ${subject}\n\n${description.slice(0, 2000)}`,
    });
    usageSink?.push({
      task: "triage",
      model: modelLabel("light"),
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });
    return object;
  } catch (e) {
    console.warn("Ticket triage failed, using {unknown, standard}:", e);
    return { product: "unknown", complexity: "standard" };
  }
}

/** Back-compat wrapper: product-only triage (used by tests/scripts). */
export async function classifyProduct(subject: string, description: string): Promise<Product> {
  return (await triageTicket(subject, description)).product;
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
  // Triage runs for every live ticket (keyed to the channel's live flag, not
  // global STUB_MODE, so staged rollouts work) — in parallel with the account
  // and dev-item lookups so its latency hides behind them.
  const contentIsLive = channel === "freshchat" ? config.freshchat.live : config.freshdesk.live;
  const taskUsage: TaskUsage[] = [];

  const [triage, account, relatedDevItems] = await Promise.all([
    contentIsLive
      ? triageTicket(ticket.subject, ticket.description, taskUsage)
      : Promise.resolve<TicketTriage>({ product: "unknown", complexity: "standard" }),
    ticket.requesterEmail
      ? fastspring.getFastSpringAccount(ticket.requesterEmail).catch(() => null)
      : Promise.resolve(null),
    monday.searchDevBoard(ticket.subject).catch(() => []),
  ]);

  // The keyword heuristic wins when it recognizes the product; the LLM triage
  // fills in only when it can't (exactly the old fallback behavior).
  const keywordProduct = inferProduct(`${ticket.subject}\n${ticket.description}`);
  const product = keywordProduct !== "unknown" ? keywordProduct : triage.product;

  return { channel, ticket, account, relatedDevItems, product, complexity: triage.complexity, taskUsage };
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
