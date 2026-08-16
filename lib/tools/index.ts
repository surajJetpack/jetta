/**
 * Tool registry: builds the AI SDK ToolSet Jetta is given each turn.
 *
 * Tools are built per-request via `buildTools(ctx, signals)` so each tool's
 * `execute` closes over the assembled context — ticket id and account are
 * sourced from context, never from model-supplied values, so an action can't be
 * misrouted to the wrong ticket or account.
 *
 * `signals` is a small mutable object the loop reads afterwards: when Jetta logs
 * a resolution via add_private_note, we flip `resolutionSent` so the webhook
 * schedules the 24h follow-up.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ConversationContext } from "../types";
import { config } from "../config";
import * as freshdesk from "./freshdesk";
import * as freshchat from "./freshchat";
import * as jettachat from "./jettachat";
import * as chatStoreForTools from "../chat-store";
import { openTicketForConversation } from "../chat-ticket";
import * as fastspring from "./fastspring";
import * as monday from "./monday";
import * as mondayMonetization from "./monday-monetization";
import * as slack from "./slack";
import * as events from "../events";
import { searchPublishedKb } from "../knowledge/dynamic-kb";
import { vectorEnabled, queryVector, type VectorHit } from "../vector";
import { rerankHits } from "../rerank";
import { recordKbHits, markEventSeen } from "../kv";
import { submitMonetApproval } from "../monetization-approvals";

/** Standard trial extension length Jetta grants — fixed policy, not customer-chosen. */
const TRIAL_EXTENSION_DAYS = 7;

export interface AgentSignals {
  resolutionSent: boolean;
}

export interface ToolOptions {
  /** When true, mutating tools record what they WOULD do but make no external call. */
  dryRun?: boolean;
  /**
   * Draft mode: reply_to_ticket and close_ticket return their normal success
   * strings without sending, so the model behaves exactly as in autonomous mode
   * and the trace records what it would have done. All other tools run live.
   */
  holdCustomerWrites?: boolean;
}

const ticketUrl = freshdesk.freshdeskTicketUrl;

function accountUrl(ctx: ConversationContext): string {
  return ctx.account?.accountId
    ? `https://app.fastspring.com/account/${ctx.account.accountId}`
    : "(no linked billing account)";
}

export function buildTools(
  ctx: ConversationContext,
  signals: AgentSignals,
  opts: ToolOptions = {},
): ToolSet {
  const ticketId = ctx.ticket?.id;
  const requesterEmail = ctx.ticket?.requesterEmail ?? undefined;
  const dry = opts.dryRun === true;
  const held = opts.holdCustomerWrites === true;
  // Two chat channels now: Freshchat (vendor-hosted, Jetta as backline) and
  // JettaChat (first-party widget, Jetta as front line). They differ in where
  // the conversation lives, not in how Jetta should behave — so `isChat` gates
  // the conversational tool descriptions and `chatClient` picks the backend.
  const isOwnChat = ctx.channel === "jettachat";
  const isChat = ctx.channel === "freshchat" || isOwnChat;
  const chatClient = isOwnChat ? jettachat : freshchat;
  // Escalations/dev items should deep-link to the actual interaction — the
  // relevant chat console for chats, the Freshdesk ticket otherwise.
  const interactionUrl = (id: string) =>
    isChat ? chatClient.conversationUrl(id) : ticketUrl(id);
  // Set by create_dev_item/add_plus_one so send_escalation can attach the Dev
  // board item link automatically, the same way ticket/account URLs are.
  let mondayItemUrl: string | undefined;

  /**
   * The customer's own evidence (screenshots, screen recordings, documents),
   * downloaded to forward onto the Dev board. Not model-supplied and not
   * model-selected: whatever the customer attached to this ticket goes with the
   * escalation, so devs stop having to ask for it. Freshdesk-only (Freshchat
   * attachments come through a different API), and best-effort — a download
   * failure must not block filing the bug.
   */
  const customerAttachments = async () =>
    ticketId && !isChat
      ? await freshdesk.downloadTicketAttachments(ticketId).catch((e) => {
          console.warn(`Attachment forwarding skipped for ticket ${ticketId}:`, e);
          return [];
        })
      : [];

  /** Tell Jetta exactly what got attached, so her private note reflects reality. */
  const filesNote = (names: string[]) =>
    names.length
      ? ` Forwarded ${names.length} customer file${names.length === 1 ? "" : "s"} to the item: ${names.join(", ")}.`
      : "";

  return {
    // ── Freshdesk ──
    get_ticket_details: tool({
      description:
        "Fetch the full current ticket: subject, description, all replies, requester name and email, and status. The active ticket is already in context; call this to refresh if needed.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!ticketId) return "No active ticket in this context.";
        return JSON.stringify(
          isChat
            ? await chatClient.getConversationAsTicket(ticketId)
            : await freshdesk.getTicketDetails(ticketId),
        );
      },
    }),

    search_knowledge_base: tool({
      description:
        "Search the Freshdesk knowledge base by keyword. ALWAYS call this before composing your first reply to a technical issue. Returns the top articles with their TITLE, public URL, and FULL body text. Results are loosely ranked — judge relevance yourself from the body, and ground any product-specific answer in the actual article text. Try a second search with different keywords if the first returns nothing relevant.",
      inputSchema: z.object({
        keyword: z.string().describe("Search terms drawn from the user's issue."),
      }),
      execute: async ({ keyword }) => {
        let merged: { id: string; title: string; url: string; body?: string; source?: string }[];
        if (vectorEnabled()) {
          // RAG path: over-fetch from the index (only PUBLISHED articles live
          // there), then let the reranker pick the best 5. Rerank failure
          // falls back to fusion order — retrieval never fails on it.
          const candidates = await queryVector(keyword, 12).catch(() => [] as VectorHit[]);
          merged = await rerankHits(keyword, candidates, 5, ctx.taskUsage);
        } else {
          // Keyword fallback over published articles in the unified store.
          merged = await searchPublishedKb(keyword, 5).catch(() => []);
        }
        // Usage counters — a metric write must never break the agent loop.
        recordKbHits(merged.map((h) => h.id)).catch(() => {});
        // Context diet: full bodies for the top hits, title+snippet beyond —
        // the tool result is re-sent into the loop on every subsequent step.
        const FULL_BODY_HITS = 3;
        const SNIPPET_CHARS = 300;
        return merged.length
          ? JSON.stringify(
              merged.map((h, i) => ({
                title: h.title,
                url: h.url,
                body:
                  i < FULL_BODY_HITS || !h.body || h.body.length <= SNIPPET_CHARS
                    ? h.body
                    : `${h.body.slice(0, SNIPPET_CHARS)}… [snippet — likely less relevant than the articles above]`,
                source: h.source,
              })),
            )
          : "No knowledge base articles matched. Do not invent product steps — ask the user for specifics or escalate.";
      },
    }),

    // On JettaChat the model's final text IS the customer-visible message, so
    // there is no reply tool to forget to call. Everywhere else the reply has
    // to be an explicit API call (a Freshdesk ticket reply, a Freshchat
    // message), so the tool is the only way to send one.
    //
    // This asymmetry is deliberate. Requiring a tool call on our own transport
    // bought nothing and cost delivery: chat-tuned models answer in prose and
    // repeatedly ended turns having researched the answer, logged a note
    // claiming they had sent it, and sent nothing. Prompt hardening did not
    // move glm-5.2. Removing the tool removes the failure mode instead of
    // catching it.
    ...(isOwnChat
      ? {}
      : {
          reply_to_ticket: tool({
            description: isChat
              ? "Send a chat message to the customer. Keep it short and conversational; plain text (no headings), links as bare URLs. This is the customer-visible response."
              : "Post a reply to the current ticket as the Jetta agent. Accepts markdown. This is the customer-visible response.",
            inputSchema: z.object({ body: z.string().describe("The reply, in markdown.") }),
            execute: async ({ body }) => {
              if (!ticketId) return "No active ticket to reply to.";
              if (dry) return `[dry-run] would post reply:\n${body}`;
              // Draft mode: report success so downstream behavior (private note,
              // resolution logging) matches autonomous mode; the webhook turns the
              // trace into a ReplyDraft for human approval.
              if (held) return isChat ? "Chat message sent to the customer." : "Reply posted to the ticket.";
              if (isChat) {
                await chatClient.replyToConversation(ticketId, body);
                return "Chat message sent to the customer.";
              }
              await freshdesk.replyToTicket(ticketId, body);
              return "Reply posted to the ticket.";
            },
          }),
        }),

    add_private_note: tool({
      description: isChat
        ? "Log an internal agent-only note about this conversation (stored in Jetta's run log — the customer never sees it). Use 'resolution_sent' as the status immediately after you send a fix."
        : "Add an internal agent-only note to the current ticket. Use 'resolution_sent' as the status immediately after you send a fix, so the 24h follow-up is scheduled.",
      inputSchema: z.object({
        body: z.string().describe("The internal note."),
        status: z
          .enum(["resolution_sent", "info"])
          .optional()
          .describe("Use 'resolution_sent' right after sending a fix to schedule the 24h follow-up."),
      }),
      execute: async ({ body, status }) => {
        if (!ticketId) return "No active ticket for a note.";
        if (status === "resolution_sent") signals.resolutionSent = true;
        if (dry) {
          return `[dry-run] would add private note${status === "resolution_sent" ? " (resolution_sent → schedules follow-up)" : ""}:\n${body}`;
        }
        if (isChat) {
          // Freshchat conversations have no private notes; the note text is
          // preserved verbatim in the run trace, so nothing is lost.
          return "Internal note logged (chat channel — recorded in Jetta's run log only).";
        }
        await freshdesk.addPrivateNote(ticketId, body);
        return status === "resolution_sent"
          ? "Private note added. Follow-up scheduled."
          : "Private note added.";
      },
    }),

    close_ticket: tool({
      description: isChat
        ? "Resolve the chat conversation. Only call after the customer confirms the issue is fixed or clearly ends the chat."
        : "Mark the current ticket resolved. Only call after the user has explicitly confirmed the issue is fixed.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!ticketId) return "No active ticket to close.";
        if (dry) return `[dry-run] would mark the ${isChat ? "conversation" : "ticket"} resolved.`;
        if (held) return isChat ? "Conversation marked resolved." : "Ticket marked resolved.";
        if (isChat) {
          await chatClient.resolveConversation(ticketId);
          return "Conversation marked resolved.";
        }
        await freshdesk.closeTicket(ticketId);
        return "Ticket marked resolved.";
      },
    }),

    // ── JettaChat hand-off ──
    // Only on our own widget, and only when the console says a person can
    // actually be fetched. `handoffEnabled` was a setting nothing read: the
    // checkbox said "let Jetta hand a live chat to a person" and turning it
    // off changed nothing, which is the same class of bug as a hidden button
    // that still works.
    ...(isOwnChat && ctx.chat?.handoffEnabled !== false
      ? {
          request_human: tool({
            description:
              "Ask a member of the team to join this chat, right now. Use ONLY when the customer explicitly asks for a person, or is angry enough that a human should take over. It pings the team in Slack and you then go SILENT — do not send anything further, they are taking over. Nobody may be free: if no one joins within a few minutes the conversation comes back to you automatically, so do not promise the customer a person will definitely appear. For anything that can be answered by email later, use create_support_ticket instead.",
            inputSchema: z.object({
              reason: z
                .string()
                .describe("One line for the team: why this needs a person, not a ticket."),
            }),
            execute: async ({ reason }) => {
              if (!ticketId) return "No active conversation.";
              if (dry) return `[dry-run] would ask the team to join chat ${ticketId}.`;
              const conv = await chatStoreForTools.getConversation(ticketId);
              if (!conv) return "This conversation no longer exists.";
              if (conv.status === "human" || conv.status === "waiting_human") {
                return "The team has already been asked to join — say nothing further and wait.";
              }
              await chatStoreForTools.updateConversation(ticketId, {
                status: "waiting_human",
                humanRequestedAt: Date.now(),
              });
              const last = [...conv.messages].reverse().find((m) => m.author === "visitor");
              await slack
                .notifyChatHandoff({
                  conversationId: ticketId,
                  visitor: [conv.visitor.name, conv.visitor.email].filter(Boolean).join(" · ") || "unknown visitor",
                  reason,
                  lastMessage: last?.text ?? "(no message)",
                  consoleUrl: config.jettachat.consoleUrl,
                })
                .catch((e) =>
                  console.warn(`chat handoff ping failed for ${ticketId}:`, e instanceof Error ? e.message : e),
                );
              await events.logOpsEvent({
                level: "info",
                event: "chat.human_requested",
                source: "jettachat",
                ticketId,
                data: { reason: reason.slice(0, 200) },
              });
              return "The team has been pinged. Tell the customer you are getting someone, then STOP — send nothing else.";
            },
          }),

        }
      : {}),

    ...(isOwnChat
      ? {
          create_support_ticket: tool({
            description:
              "Open a Freshdesk ticket so the team can pick this up by email, and tell the customer you have done it. Use this for anything that needs a reply LATER — it is the right choice unless the customer specifically wants someone now (for that, use request_human). Use it when the knowledge base has no answer, the request needs account changes you cannot make, the customer is upset or wants a refund, or they ask for a human. REQUIRES the customer's email address: ask for it first if you don't have it. The full chat transcript is attached automatically — summarize, don't re-type it.",
            inputSchema: z.object({
              email: z
                .string()
                .describe("The customer's email address, as they gave it in the chat."),
              subject: z
                .string()
                .describe("Short ticket subject naming the actual problem, no 'chat' prefix."),
              summary: z
                .string()
                .describe(
                  "What the customer needs and what you already established or ruled out, in a short paragraph for the agent picking this up.",
                ),
            }),
            execute: async ({ email, subject, summary }) => {
              if (!ticketId) return "No active conversation to escalate.";
              // Basic shape check only — a typo'd address is better than none,
              // but a sentence in the email field would create a broken ticket.
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                return "That doesn't look like a valid email address. Ask the customer to confirm it, then call this again.";
              }
              if (dry) return `[dry-run] would open a Freshdesk ticket for ${email}: "${subject}".`;

              const conv = await chatStoreForTools.getConversation(ticketId);
              if (!conv) return "This conversation has expired — no ticket was created.";
              // Shared with the console's convert button, so a ticket carries
              // the same transcript, files and back-link however it was made.
              const created = await openTicketForConversation(conv, {
                email: email.trim(),
                subject,
                summary,
                productHint: ctx.appProduct,
              });
              await chatStoreForTools.updateConversation(ticketId, {
                status: "ticketed",
                ticketId: created.id,
                visitor: { email: email.trim() },
              });

              return `Ticket #${created.id} created for ${email.trim()}. Tell the customer their question has gone to the team and they'll get a reply by email — do NOT give them the ticket number or this URL. INTERNAL: ${created.url}`;
            },
          }),
        }
      : {}),

    // ── FastSpring ──
    // When billing isn't connected (FASTSPRING_LIVE unset), every billing tool
    // says so explicitly. Plausible stub data must never reach a customer
    // draft, and "no subscription on file" would read as a fact about the
    // customer rather than about our system.
    get_fastspring_account: tool({
      description:
        "Look up the customer's FastSpring billing account by email. ALWAYS call before answering a billing question or handling a cancellation. Returns plan, billing cycle, next charge date, card last four, recent-activity flag, and invoices.",
      inputSchema: z.object({
        email: z.string().optional().describe("Defaults to the ticket requester's email if omitted."),
      }),
      execute: async ({ email }) => {
        if (!config.fastspring.live) {
          return "Billing system is NOT connected in this environment — account data is unavailable. Do not state any plan, price, charge date, or card details. For billing questions, ask the customer for specifics from their receipt/invoice email, or escalate to a human.";
        }
        const addr = email ?? requesterEmail;
        if (!addr) return "No email available to look up the account.";
        return JSON.stringify(await fastspring.getFastSpringAccount(addr, ctx.appProduct));
      },
    }),

    get_invoice_url: tool({
      description: "Get a signed download URL for a specific invoice.",
      inputSchema: z.object({ invoice_id: z.string() }),
      execute: async ({ invoice_id }) => {
        if (!config.fastspring.live) {
          return "Billing system is NOT connected — invoice links cannot be generated. Escalate billing document requests to a human.";
        }
        return await fastspring.getInvoiceUrl(invoice_id, ctx.appProduct);
      },
    }),

    apply_discount: tool({
      description:
        "Apply the one-time retention coupon to the customer's subscription. Only in the churn flow, only for accounts with recent activity, before discussing cancellation.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!config.fastspring.live) {
          return "Billing system is NOT connected — no discount was applied. Do not tell the customer a discount was applied; escalate to a human for billing actions.";
        }
        const sub = ctx.account?.subscriptionId;
        if (!sub) return "No subscription on file to discount.";
        if (dry) return `[dry-run] would apply retention coupon ${config.fastspring.retentionCoupon}.`;
        const r = await fastspring.applyDiscount(sub, config.fastspring.retentionCoupon, ctx.appProduct);
        return `Discount applied. New price ${r.newPrice}, effective ${r.effectiveDate}.`;
      },
    }),

    cancel_subscription: tool({
      description:
        "Cancel the subscription at end of the current billing period. Only after the user EXPLICITLY confirms cancellation. Never cancel on silence.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!config.fastspring.live) {
          return "Billing system is NOT connected — nothing was cancelled. Do not confirm any cancellation; escalate to a human for billing actions.";
        }
        const sub = ctx.account?.subscriptionId;
        if (!sub) return "No subscription on file to cancel.";
        if (dry) return "[dry-run] would cancel the subscription at end of billing period.";
        const r = await fastspring.cancelSubscription(sub, ctx.appProduct);
        return `Subscription cancelled. Access ends ${r.accessEndsDate}.`;
      },
    }),

    // ── monday.com ──
    search_dev_board: tool({
      description:
        "Search the Dev board for open items matching the error/symptom. ALWAYS call before create_dev_item. Returns matching item id, title, status, and URL.",
      inputSchema: z.object({ symptom: z.string().describe("Short description of the error/symptom.") }),
      // Mapped explicitly rather than passed through: searchDevBoard also
      // returns who the item is assigned to, and this toolset writes to
      // CUSTOMERS. An engineer's name has no business in the context of a
      // reply, and the surest way to keep it out is not to put it there.
      // The Slack assistant, which answers colleagues, gets the whole object.
      execute: async ({ symptom }) =>
        JSON.stringify(
          (await monday.searchDevBoard(symptom, ctx.product)).map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            url: i.url,
          })),
        ),
    }),

    read_dev_item_comments: tool({
      description:
        "Read the comments engineering has left on a Dev board item. Call this BEFORE add_plus_one on an existing item — it may already be fixed, or a dev may have asked for information you can collect from the customer now. STRICTLY INTERNAL: these are engineers talking to each other. Never quote them, never name an engineer, and never repeat a version, date or sprint from them to the customer.",
      inputSchema: z.object({ item_id: z.string().describe("Dev board item id, digits only.") }),
      execute: async ({ item_id }) => {
        const item = await monday.getItemUpdates(item_id, 10).catch(() => null);
        if (!item) return `No Dev board item ${item_id} found.`;
        if (!item.updates.length) {
          return `Dev item "${item.name}" exists but has no comments yet — nobody has posted an update. Do not tell the customer anything about progress.`;
        }
        return JSON.stringify({
          item: item.name,
          updates: item.updates.map((u) => ({
            at: u.at,
            author: u.author,
            text: u.text.slice(0, 1200),
            replies: u.replies.map((r) => ({ author: r.author, text: r.text.slice(0, 500) })),
          })),
          reminder:
            "INTERNAL engineering notes. Use them to decide what to do and what to ask. Do not quote, name anyone, or promise a timeline.",
        });
      },
    }),

    create_dev_item: tool({
      description:
        "Create a new Dev board item with full context. Only after search_dev_board finds no existing master item.",
      inputSchema: z.object({
        title: z.string(),
        error_description: z.string(),
        repro_steps: z.string(),
      }),
      execute: async ({ title, error_description, repro_steps }) => {
        if (dry) return `[dry-run] would create Dev board item: "${title}".`;
        const item = await monday.createDevItem({
          title,
          product: ctx.product,
          accountUrl: accountUrl(ctx),
          errorDescription: error_description,
          reproSteps: repro_steps,
          freshdeskTicketUrl: ticketId ? interactionUrl(ticketId) : "(no ticket)",
          attachments: await customerAttachments(),
        });
        mondayItemUrl = item.url;
        return `Created Dev board item "${item.title}".${filesNote(item.filesAttached)} INTERNAL URL — put in the private note ONLY, never the customer reply: ${item.url}`;
      },
    }),

    add_plus_one: tool({
      description:
        "Add a +1 note to an existing Dev board item when a DIFFERENT customer reports the same issue. Do NOT call this for the customer whose report created the item — that double-counts one person as two and inflates the apparent impact of the bug. The team prioritises by +1 count, so a wrong +1 is worse than no +1.",
      inputSchema: z.object({
        item_id: z.string(),
        symptom: z
          .string()
          .describe(
            "One line on what THIS customer actually saw, in their terms. The assignee may have no Freshdesk access, so this is all they get — 'bulk-uploaded tracking IDs never update' not 'same issue'.",
          ),
      }),
      execute: async ({ item_id, symptom }) => {
        const boardId = monday.boardIdFor(ctx.product);
        const url = `${config.monday.accountUrl}/boards/${boardId}/pulses/${item_id}`;
        mondayItemUrl = url;
        if (dry) return `[dry-run] would add +1 to Dev board item ${item_id}. INTERNAL item URL (private note only): ${url}`;
        if (!ticketId) return "No active ticket — cannot attribute a +1.";

        // Guard 1: is this the ticket that created the item? Jetta's own
        // search_dev_board surfaces the item its current ticket spawned, and
        // the model reads that as a match. Observed on item 12757964338: one
        // ticket +1'd its own item, twice.
        if (await monday.itemMentionsTicket(item_id, ticketId)) {
          return `That Dev item already references this same ticket (#${ticketId}) — it is this customer's own report, not a second one. No +1 was added. Do not call add_plus_one again for this item; link it in your private note instead.`;
        }

        // Guard 2: one +1 per (ticket, item), ever. Without this, every
        // customer reply on a linked ticket fires another webhook run and
        // another +1 — the same pair posted twice 62 minutes apart.
        const fresh = await markEventSeen(`plusone:${ticketId}:${item_id}`, 180 * 86400);
        if (!fresh) {
          return `A +1 from this ticket is already recorded on that Dev item. Nothing further was added — mention the link in your private note instead.`;
        }

        const r = await monday.addPlusOne({
          itemId: item_id,
          ticketUrl: interactionUrl(ticketId),
          product: ctx.product,
          symptom,
          accountLabel: requesterEmail ?? ctx.account?.accountId ?? undefined,
          attachments: await customerAttachments(),
        });
        return `Added +1 to the Dev board item.${filesNote(r.filesAttached)} INTERNAL item URL — put in the private note ONLY, never the customer reply: ${r.url}`;
      },
    }),

    extend_trial: tool({
      description:
        "REQUEST the standard 7-day trial extension for the customer's monday.com app (a human on the team approves it in Slack before it takes effect — it is NOT applied immediately). Extensions are always 7 days — do not offer a different length even if the customer asks for more. Requires their monday account (their monday URL, e.g. https://acme.monday.com, or account slug) — ask for it if you don't have it.",
      inputSchema: z.object({
        account: z.string().describe("The customer's monday URL or account slug."),
      }),
      execute: async ({ account }) => {
        const slug = mondayMonetization.parseAccountSlug(account);
        if (!slug) return "That doesn't look like a monday account URL or slug — ask the customer for their monday URL (e.g. https://acme.monday.com).";
        const days = TRIAL_EXTENSION_DAYS; // standard, fixed
        if (dry) return `[dry-run] would request approval to extend ${slug}'s trial by the standard ${days} days.`;
        const { id, deduped, flagged } = await submitMonetApproval({
          action: "trial", app: ctx.appProduct, accountSlug: slug, days, ticketId,
          summary: `extend trial by ${days} days`,
          ticketUrl: ticketId ? interactionUrl(ticketId) : undefined,
        });
        const flagNote = flagged ? ` (Heads up: flagged for review — ${flagged})` : "";
        return `${deduped ? `A trial-extension request for this account is already pending approval (ref ${id})` : `Trial-extension request sent to the team for approval (ref ${id})`}${flagNote}. It is NOT applied yet — the extension is a standard ${days} days. Tell the customer their request is being processed and will be confirmed shortly — do NOT say the trial has been extended, and do NOT promise a specific number of days.`;
      },
    }),

    apply_monday_discount: tool({
      description:
        "REQUEST a monday Marketplace discount for the customer's account (a human approves it in Slack before it takes effect — NOT applied immediately). Requires their monday account (URL or slug). Only in the churn/retention flow, framed as a one-time offer. This is the discount tool for CURRENT (monday-billed) customers; the separate apply_discount tool is only for legacy FastSpring accounts.",
      inputSchema: z.object({
        account: z.string().describe("The customer's monday URL or account slug."),
        percent: z.number().int().describe("Percent off, 1-100."),
        days_valid: z.number().int().describe("How many days the discount stays valid."),
        period: z.enum(["MONTHLY", "YEARLY"]).describe("Which billing period the discount applies to."),
      }),
      execute: async ({ account, percent, days_valid, period }) => {
        const slug = mondayMonetization.parseAccountSlug(account);
        if (!slug) return "That doesn't look like a monday account URL or slug — ask the customer for their monday URL.";
        if (dry) return `[dry-run] would request approval for a ${percent}% ${period.toLowerCase()} discount to ${slug} for ${days_valid} days.`;
        const { id, deduped } = await submitMonetApproval({
          action: "discount", app: ctx.appProduct, accountSlug: slug,
          percent, daysValid: days_valid, period, ticketId,
          summary: `${percent}% off ${period.toLowerCase()}, valid ${days_valid} days (one-time)`,
          ticketUrl: ticketId ? interactionUrl(ticketId) : undefined,
        });
        return `${deduped ? `A matching discount request is already pending approval (ref ${id})` : `Discount request sent to the team for approval (ref ${id})`}. It is NOT applied yet. Tell the customer the offer is being processed and will be confirmed shortly — do NOT say a discount has been applied.`;
      },
    }),

    // ── Slack ──
    send_escalation: tool({
      description:
        "Post an escalation to the dev team's Slack channel. The channel message is deliberately SHORT — only your headline and question appear there; the summary and already_tried go in a thread reply the team expands. Ticket and account links, plus the Dev board item if one was created/linked this turn, are attached automatically.",
      inputSchema: z.object({
        headline: z
          .string()
          .describe(
            "Scannable one-liner, max 80 chars, naming the actual failure. No ticket number, no app name (both are added automatically), no 'user reports that' preamble. e.g. 'Signed docs stop syncing to monday for one account'.",
          ),
        summary: z
          .string()
          .describe(
            "One full paragraph of context: what happens, when it started, scope (one account or many), and anything you ruled out. Thread-only, so be complete rather than terse.",
          ),
        already_tried: z
          .string()
          .describe(
            "What you already tried, ONE ATTEMPT PER LINE, each a short phrase with its result. e.g. 'Verified board/column mapping — correct'. Include KB gaps.",
          ),
        question: z
          .string()
          .describe(
            "One specific, answerable question for the team, max ~150 chars — the single thing you need from them to move forward.",
          ),
      }),
      execute: async ({ headline, summary, already_tried, question }) => {
        if (dry) {
          return `[dry-run] would escalate to Slack:\nHeadline: ${headline}\nQuestion: ${question}\n-- thread reply --\nSummary: ${summary}\nTried: ${already_tried}${mondayItemUrl ? `\nDev board item: ${mondayItemUrl}` : ""}`;
        }
        const r = await slack.sendEscalation({
          freshdeskTicketUrl: ticketId ? interactionUrl(ticketId) : "(no ticket)",
          userAccountUrl: accountUrl(ctx),
          mondayItemUrl,
          headline,
          app: ctx.appProduct,
          // Lets item ids the model wrote in prose resolve to the right board.
          devBoardId: monday.boardIdFor(ctx.product),
          // Short human label for the channel line — accountUrl() is a long
          // FastSpring href and is absent entirely for monday-billed customers.
          accountLabel: requesterEmail ?? ctx.account?.accountId ?? undefined,
          ticketRef: ticketId ? `#${ticketId}` : undefined,
          summary,
          alreadyTried: already_tried,
          question,
        });
        return `Escalation posted to the dev team (ts ${r.ts}).`;
      },
    }),

    notify_partner_manager: tool({
      description:
        "Notify the partnerships channel when the user mentions an external consultant or implementation partner.",
      inputSchema: z.object({ partner_mention: z.string() }),
      execute: async ({ partner_mention }) => {
        if (dry) return `[dry-run] would notify partnerships about: ${partner_mention}`;
        await slack.notifyPartnerManager(
          ticketId ? interactionUrl(ticketId) : "(no ticket)",
          partner_mention,
        );
        return "Partnerships team notified.";
      },
    }),
  };
}
