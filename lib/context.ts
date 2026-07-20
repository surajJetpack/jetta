/**
 * Context assembly: pull together the ticket, the customer's FastSpring account,
 * and any existing monday.com Dev items, then shape the conversation history
 * into the message array handed to the Claude loop.
 */
import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { AppProduct, ConversationContext, Product, TaskUsage, Ticket } from "./types";
import { config } from "./config";
import { getModel, modelLabel } from "./llm";
import * as freshdesk from "./tools/freshdesk";
import * as freshchat from "./tools/freshchat";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";

// Context-diet caps for the replayed conversation (lib/tools/freshdesk.ts has
// the equivalent caps for the get_ticket_details tool result).
const MAX_HISTORY_REPLIES = 12;
const REPLY_CHARS = 2000;
const OPENING_CHARS = 4000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…truncated]` : text;
}

/** Cheap heuristic to attribute a ticket to a product. */
export function inferProduct(text: string): Product {
  const t = text.toLowerCase();
  if (/getsign|e-?sign|signature|mapping/.test(t)) return "getsign";
  if (
    /jetpack|marketplace|widget|trackmy|track my|courier|vlookup|extract ai|extract-ai|jobflow|smart column|jetscan|pivot report|triggerly|qr code/.test(t)
  )
    return "jetpackapps";
  if (/monday\.com|board/.test(t)) return "jetpackapps";
  return "unknown";
}

/**
 * Freshdesk's cf_product custom field is ground truth when agents set it.
 * Dropdown values (from the FD ticket form): VLOOKUP Auto-link, Extract,
 * TrackMy, GetSign, JetScan HR, Triggerly, Pivot Reports Pro, Jobflows,
 * Smart Columns, Offsite, Other/ General. "Other/ General" is explicitly
 * not-a-product — fall through to the heuristics for those.
 */
export function productFromHint(hint: string | null | undefined): Product | null {
  const h = hint?.trim().toLowerCase();
  if (!h || /other|general/.test(h)) return null;
  return /getsign/.test(h) ? "getsign" : "jetpackapps";
}

/**
 * Cheap heuristic to attribute a ticket to the *specific* monday.com app it
 * concerns — finer-grained than `inferProduct`, since each app bills through
 * its own separate FastSpring store (confirmed 2026-07-20: VLOOKUP and
 * TrackMy are already two distinct stores, not one shared "jetpackapps" one).
 */
export function inferAppProduct(text: string): AppProduct {
  const t = text.toLowerCase();
  if (/getsign|e-?sign|signature|mapping/.test(t)) return "getsign";
  if (/trackmy|track my|courier|parcel|shipment tracking|tracking number/.test(t)) return "trackmy";
  if (/vlookup/.test(t)) return "vlookup";
  if (/extract ai|extract-ai|\bextract\b/.test(t)) return "extract";
  if (/jobflow/.test(t)) return "jobflows";
  if (/smart column/.test(t)) return "smartcolumns";
  if (/jetscan/.test(t)) return "jetscan";
  if (/pivot report/.test(t)) return "pivotreports";
  if (/triggerly|qr code/.test(t)) return "triggerly";
  return "unknown";
}

/**
 * Freshdesk cf_product dropdown value → AppProduct. Same ground-truth
 * precedence as `productFromHint`, at the finer per-app grain FastSpring
 * routing needs.
 */
export function appProductFromHint(hint: string | null | undefined): AppProduct | null {
  const h = hint?.trim().toLowerCase();
  if (!h || /other|general/.test(h)) return null;
  if (/getsign/.test(h)) return "getsign";
  if (/vlookup/.test(h)) return "vlookup";
  if (/trackmy/.test(h)) return "trackmy";
  if (/extract/.test(h)) return "extract";
  if (/jobflow/.test(h)) return "jobflows";
  if (/smart column/.test(h)) return "smartcolumns";
  if (/jetscan/.test(h)) return "jetscan";
  if (/pivot report/.test(h)) return "pivotreports";
  if (/triggerly/.test(h)) return "triggerly";
  return null;
}

const TRIAGE_SYSTEM = `You triage customer support tickets: attribute them to a product and rate their complexity.

Products:
- "getsign" — GetSign (getsign.io), the e-signature app for monday.com: signing documents, signature requests, templates, field mapping, signed-document sync.
- "jetpackapps" — Jetpack Apps (jetpackapps.io), the monday.com marketplace app portfolio: TrackMy (parcel/courier tracking), VLOOKUP Auto-Link (connect/sync boards), Extract AI (pull data from files/emails into boards), JobFlows (recruiting), Smart Columns (currency converter, mandatory fields, SLA, duplicates, custom IDs, conditional status and other column utilities), JetScan HR (resume scanning), Pivot Reports Pro, Triggerly (QR codes).
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

  // Dev board search needs a product (to pick which board to query) before the
  // async LLM triage below has run. Use the synchronous cf_product/keyword
  // signals only — "unknown" here falls back to the general jetpackapps board.
  const keywordProduct = inferProduct(`${ticket.subject}\n${ticket.description}`);
  const searchProduct = productFromHint(ticket.productHint) ?? keywordProduct;

  // FastSpring lookup needs the specific app (each app has its own store),
  // same synchronous cf_product/keyword precedence as the dev-board search.
  const appProduct =
    appProductFromHint(ticket.productHint) ??
    inferAppProduct(`${ticket.subject}\n${ticket.description}`);

  const [triage, account, relatedDevItems] = await Promise.all([
    contentIsLive
      ? triageTicket(ticket.subject, ticket.description, taskUsage)
      : Promise.resolve<TicketTriage>({ product: "unknown", complexity: "standard" }),
    ticket.requesterEmail
      ? fastspring.getFastSpringAccount(ticket.requesterEmail, appProduct).catch(() => null)
      : Promise.resolve(null),
    monday
      .searchDevBoard(ticket.subject, searchProduct === "unknown" ? "jetpackapps" : searchProduct)
      .catch(() => []),
  ]);

  // Attribution precedence: Freshdesk's cf_product field (ground truth set by
  // agents/forms) > keyword heuristic > LLM triage fallback.
  const product =
    productFromHint(ticket.productHint) ??
    (keywordProduct !== "unknown" ? keywordProduct : triage.product);

  return {
    channel,
    ticket,
    account,
    relatedDevItems,
    product,
    appProduct,
    complexity: triage.complexity,
    taskUsage,
  };
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
          ? `[Live chat — handed off to you by the front-line bot]\n\n${clip(ticket.description, OPENING_CHARS)}`
          : `[New ticket]\nSubject: ${ticket.subject}\n\n${clip(ticket.description, OPENING_CHARS)}`,
    },
  ];

  // Context diet: long threads dominate token spend (the history is re-sent on
  // every tool-loop step). Replay only the newest exchanges; the model can
  // always pull specifics with get_ticket_details.
  const publicReplies = ticket.replies.filter((r) => !r.isPrivate);
  const recent = publicReplies.slice(-MAX_HISTORY_REPLIES);
  if (publicReplies.length > recent.length) {
    messages.push({
      role: "user",
      content: `[system] ${publicReplies.length - recent.length} earlier replies omitted for brevity — use get_ticket_details if you need the full history.`,
    });
  }
  for (const reply of recent) {
    messages.push({
      role: reply.author === "customer" ? "user" : "assistant",
      content: clip(reply.body, REPLY_CHARS),
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
