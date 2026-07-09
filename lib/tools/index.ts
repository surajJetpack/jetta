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
import * as fastspring from "./fastspring";
import * as monday from "./monday";
import * as slack from "./slack";
import { searchPublishedKb } from "../knowledge/dynamic-kb";
import { vectorEnabled, queryVector, type VectorHit } from "../vector";
import { rerankHits } from "../rerank";
import { recordKbHits } from "../kv";

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

function ticketUrl(ticketId: string): string {
  return `https://${config.freshdesk.domain ?? "jetpackapps.freshdesk.com"}/a/tickets/${ticketId}`;
}

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
  const isChat = ctx.channel === "freshchat";
  // Escalations/dev items should deep-link to the actual interaction — the
  // Freshchat console for chats, the Freshdesk ticket otherwise.
  const interactionUrl = (id: string) =>
    isChat ? freshchat.conversationUrl(id) : ticketUrl(id);
  // Set by create_dev_item/add_plus_one so send_escalation can attach the Dev
  // board item link automatically, the same way ticket/account URLs are.
  let mondayItemUrl: string | undefined;

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
            ? await freshchat.getConversationAsTicket(ticketId)
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
          merged = await rerankHits(keyword, candidates, 5);
        } else {
          // Keyword fallback over published articles in the unified store.
          merged = await searchPublishedKb(keyword, 5).catch(() => []);
        }
        // Usage counters — a metric write must never break the agent loop.
        recordKbHits(merged.map((h) => h.id)).catch(() => {});
        return merged.length
          ? JSON.stringify(merged.map((h) => ({ title: h.title, url: h.url, body: h.body, source: h.source })))
          : "No knowledge base articles matched. Do not invent product steps — ask the user for specifics or escalate.";
      },
    }),

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
          await freshchat.replyToConversation(ticketId, body);
          return "Chat message sent to the customer.";
        }
        await freshdesk.replyToTicket(ticketId, body);
        return "Reply posted to the ticket.";
      },
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
          await freshchat.resolveConversation(ticketId);
          return "Conversation marked resolved.";
        }
        await freshdesk.closeTicket(ticketId);
        return "Ticket marked resolved.";
      },
    }),

    // ── FastSpring ──
    get_fastspring_account: tool({
      description:
        "Look up the customer's FastSpring billing account by email. ALWAYS call before answering a billing question or handling a cancellation. Returns plan, billing cycle, next charge date, card last four, recent-activity flag, and invoices.",
      inputSchema: z.object({
        email: z.string().optional().describe("Defaults to the ticket requester's email if omitted."),
      }),
      execute: async ({ email }) => {
        const addr = email ?? requesterEmail;
        if (!addr) return "No email available to look up the account.";
        return JSON.stringify(await fastspring.getFastSpringAccount(addr));
      },
    }),

    get_invoice_url: tool({
      description: "Get a signed download URL for a specific invoice.",
      inputSchema: z.object({ invoice_id: z.string() }),
      execute: async ({ invoice_id }) => await fastspring.getInvoiceUrl(invoice_id),
    }),

    apply_discount: tool({
      description:
        "Apply the one-time retention coupon to the customer's subscription. Only in the churn flow, only for accounts with recent activity, before discussing cancellation.",
      inputSchema: z.object({}),
      execute: async () => {
        const sub = ctx.account?.accountId;
        if (!sub) return "No subscription on file to discount.";
        if (dry) return `[dry-run] would apply retention coupon ${config.fastspring.retentionCoupon}.`;
        const r = await fastspring.applyDiscount(sub, config.fastspring.retentionCoupon);
        return `Discount applied. New price ${r.newPrice}, effective ${r.effectiveDate}.`;
      },
    }),

    cancel_subscription: tool({
      description:
        "Cancel the subscription at end of the current billing period. Only after the user EXPLICITLY confirms cancellation. Never cancel on silence.",
      inputSchema: z.object({}),
      execute: async () => {
        const sub = ctx.account?.accountId;
        if (!sub) return "No subscription on file to cancel.";
        if (dry) return "[dry-run] would cancel the subscription at end of billing period.";
        const r = await fastspring.cancelSubscription(sub);
        return `Subscription cancelled. Access ends ${r.accessEndsDate}.`;
      },
    }),

    // ── monday.com ──
    search_dev_board: tool({
      description:
        "Search the Dev board for open items matching the error/symptom. ALWAYS call before create_dev_item. Returns matching item id, title, status, and URL.",
      inputSchema: z.object({ symptom: z.string().describe("Short description of the error/symptom.") }),
      execute: async ({ symptom }) => JSON.stringify(await monday.searchDevBoard(symptom)),
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
        });
        mondayItemUrl = item.url;
        return `Created Dev board item "${item.title}". INTERNAL URL — put in the private note ONLY, never the customer reply: ${item.url}`;
      },
    }),

    add_plus_one: tool({
      description:
        "Add a +1 note to an existing Dev board item when another user is affected by the same issue.",
      inputSchema: z.object({ item_id: z.string() }),
      execute: async ({ item_id }) => {
        const url = `${config.monday.accountUrl}/boards/${config.monday.devBoardId}/pulses/${item_id}`;
        mondayItemUrl = url;
        if (dry) return `[dry-run] would add +1 to Dev board item ${item_id}. INTERNAL item URL (private note only): ${url}`;
        const r = await monday.addPlusOne(item_id, ticketId ? interactionUrl(ticketId) : "(no ticket)");
        return `Added +1 to the Dev board item. INTERNAL item URL — put in the private note ONLY, never the customer reply: ${r.url}`;
      },
    }),

    extend_trial: tool({
      description: "Extend a user's trial by a number of days.",
      inputSchema: z.object({ email: z.string().optional(), days: z.number().int() }),
      execute: async ({ email, days }) => {
        if (dry) return `[dry-run] would extend trial for ${email ?? requesterEmail ?? "?"} by ${days} days.`;
        const r = await monday.extendTrial(email ?? requesterEmail ?? "", days);
        return `Trial extended. New end date ${r.newTrialEndDate}.`;
      },
    }),

    apply_platform_discount: tool({
      description: "Grant a monday Marketplace platform-level discount.",
      inputSchema: z.object({ email: z.string().optional(), percent: z.number().int() }),
      execute: async ({ email, percent }) => {
        if (dry) return `[dry-run] would apply ${percent}% platform discount for ${email ?? requesterEmail ?? "?"}.`;
        await monday.applyPlatformDiscount(email ?? requesterEmail ?? "", percent);
        return "Platform discount applied.";
      },
    }),

    // ── Slack ──
    send_escalation: tool({
      description:
        "Post an escalation to the dev team's Slack channel. Provide a one-paragraph summary, what you already tried, and a specific question (the ticket and account URLs, plus the Dev board item link if one was created/linked this turn, are attached automatically).",
      inputSchema: z.object({
        summary: z.string(),
        already_tried: z.string(),
        question: z.string(),
      }),
      execute: async ({ summary, already_tried, question }) => {
        if (dry) {
          return `[dry-run] would escalate to Slack:\nSummary: ${summary}\nTried: ${already_tried}\nQuestion: ${question}${mondayItemUrl ? `\nDev board item: ${mondayItemUrl}` : ""}`;
        }
        const r = await slack.sendEscalation({
          freshdeskTicketUrl: ticketId ? interactionUrl(ticketId) : "(no ticket)",
          userAccountUrl: accountUrl(ctx),
          mondayItemUrl,
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
