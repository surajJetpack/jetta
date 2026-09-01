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
import { openTicketForConversation, routeTicketUpdate, suggestedSubject } from "../chat-ticket";
import * as chatFiles from "../chat-files";
import * as fastspring from "./fastspring";
import * as monday from "./monday";
import * as mondayMonetization from "./monday-monetization";
import * as slack from "./slack";
import * as events from "../events";
import { searchPublishedKb } from "../knowledge/dynamic-kb";
import { vectorEnabled, queryVector, type VectorHit } from "../vector";
import { rerankHits } from "../rerank";
import { profileFor } from "../profiles";
import { recordKbHits, clearEscalation } from "../kv";
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
  // Set by create_dev_item so send_escalation can attach the Dev board item
  // link automatically, the same way ticket/account URLs are.
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
        // Brand scope. Empty for the portfolio bot — it keeps the whole index,
        // GetSign articles included — and non-empty only on GetSign's own
        // surface, where the other apps' articles must not be reachable at all.
        const scopes = config.kbScopeEnabled
          ? profileFor(ctx.product, ctx.productSource).kbScopes
          : [];
        let merged: { id: string; title: string; url: string; body?: string; source?: string }[];
        if (vectorEnabled()) {
          // RAG path: over-fetch from the index (only PUBLISHED articles live
          // there), then let the reranker pick the best 5. Rerank failure
          // falls back to fusion order — retrieval never fails on it.
          const candidates = await queryVector(keyword, 12, scopes).catch(() => [] as VectorHit[]);
          merged = await rerankHits(keyword, candidates, 5, ctx.taskUsage);
        } else {
          // Keyword fallback over published articles in the unified store.
          merged = await searchPublishedKb(keyword, 5, scopes).catch(() => []);
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

    /**
     * Ticket channels only.
     *
     * On a chat this tool did nothing — no note is stored anywhere, the string
     * it returns says as much, and the 24h follow-up it exists to schedule
     * doesn't run on this channel. What it DID do was give the model somewhere
     * to put an answer that isn't the customer: observed twice in the eval,
     * researching a question, logging a note about it, and sending no reply —
     * so the customer got silence, or the crash apology on top of it.
     *
     * This is the same failure that removed `reply_to_ticket` from this channel
     * (see docs/jettachat.md): "glm-5.2 repeatedly researched an answer, logged
     * a note claiming it had sent it, and sent nothing. Two rounds of prompt
     * hardening didn't move it." Prompt hardening didn't fix it there either.
     * Removing the tool removes the failure mode rather than catching it.
     *
     * The resolution signal it carried moves to close_ticket below, which on
     * this channel has a real effect and cannot stand in for talking.
     */
    ...(isChat
      ? {}
      : {
    add_private_note: tool({
      description:
        "Add an internal agent-only note to the current ticket. Use 'resolution_sent' as the status immediately after you send a fix, so the 24h follow-up is scheduled.",
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
        await freshdesk.addPrivateNote(ticketId, body);
        return status === "resolution_sent"
          ? "Private note added. Follow-up scheduled."
          : "Private note added.";
      },
    }),
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
        // Close the escalation thread with the ticket. If this ticket is ever
        // reopened it is a new problem, and it should reach the team as its own
        // escalation rather than as an update buried under a resolved one.
        await clearEscalation(ticketId).catch(() => {});
        if (isChat) {
          // Carries the resolution signal on this channel, now that
          // add_private_note (which used to) isn't offered here. Resolving a
          // conversation IS the resolution on chat, and unlike a note it has a
          // real effect — so it cannot be used as a substitute for answering.
          signals.resolutionSent = true;
          await chatClient.resolveConversation(ticketId);
          return "Conversation marked resolved.";
        }
        await freshdesk.closeTicket(ticketId);
        return "Ticket marked resolved.";
      },
    }),

    // ── JettaChat identity ──
    // The pre-chat form is gone: conversations start anonymous and Jetta
    // collects name and email in the chat (the prompt carries the mandatory
    // rule while ctx.chat.needsIdentity is true). This tool is how what the
    // visitor typed becomes the conversation's identity — and it stays
    // available after that, so a mistyped address can be corrected.
    ...(isOwnChat
      ? {
          save_visitor_identity: tool({
            description:
              "Record the visitor's name and/or email address the moment they give them in the chat. While the visitor is anonymous this is MANDATORY — ask early, save immediately. Pass EXACTLY what they typed; either field may be omitted if they only gave one. Also use it to correct a previously mistyped address.",
            inputSchema: z.object({
              name: z.string().optional().describe("The visitor's name, as they gave it."),
              email: z
                .string()
                .optional()
                .describe("The visitor's email address, exactly as they typed it."),
            }),
            execute: async ({ name, email }) => {
              if (!ticketId) return "No active conversation.";
              const cleanName = name?.trim().slice(0, 120) || undefined;
              const cleanEmail = email?.trim().slice(0, 200) || undefined;
              if (!cleanName && !cleanEmail) {
                return "Nothing to save — pass the name and/or email the visitor gave.";
              }
              // Same shape check as ticket creation: a sentence in the email
              // field would poison every follow-up path that keys on it.
              if (cleanEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(cleanEmail)) {
                return "That doesn't look like a valid email address. Ask the visitor to re-check it, then save again — do not correct it yourself.";
              }
              if (dry) {
                return `[dry-run] would save visitor identity${cleanName ? ` name "${cleanName}"` : ""}${cleanEmail ? ` email ${cleanEmail}` : ""}.`;
              }
              const conv = await chatStoreForTools.getConversation(ticketId);
              if (!conv) return "This conversation has expired.";
              await chatStoreForTools.updateConversation(ticketId, {
                visitor: {
                  ...(cleanName ? { name: cleanName } : {}),
                  ...(cleanEmail ? { email: cleanEmail } : {}),
                },
              });
              await events.logOpsEvent({
                level: "info",
                event: "chat.identity_saved",
                source: "jettachat",
                ticketId,
                data: { hasName: !!cleanName, hasEmail: !!cleanEmail },
              });
              const saved = [cleanName && "name", cleanEmail && "email"].filter(Boolean).join(" and ");
              return `Saved the visitor's ${saved}.${!cleanEmail && !conv.visitor.email ? " You still need their email address — keep helping, and ask for it." : " Thank them briefly and carry on helping."}`;
            },
          }),
        }
      : {}),

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

    /*
     * ── The escalation path ──
     *
     * create_support_ticket is always here. add_to_ticket joins it only once a
     * ticket exists, and the pair encodes the distinction that matters to the
     * team: ONE TICKET PER ISSUE, not one per conversation.
     *
     * Both halves are failure modes. Two tickets for the SAME problem gives the
     * customer two notification emails and the team an argument about which
     * thread is live. One ticket for TWO problems gives them a thread they
     * cannot close — the second issue rides along in a note under a subject
     * about something else, and gets forgotten when the first is resolved.
     *
     * The tools cannot tell these apart; only the model can, so the line is
     * drawn in both descriptions and again in the prompt. What the tool DOES
     * enforce is the race below: a ticket that appeared during this turn was
     * not the model's decision, and is always the same issue.
     */
    ...(isOwnChat
      ? {
          create_support_ticket: tool({
            description:
              "Open a Freshdesk ticket so the team can pick this up by email, and tell the customer you have done it. Use this for anything that needs a reply LATER — it is the right choice unless the customer specifically wants someone now (for that, use request_human). Use it when the knowledge base has no answer, the request needs account changes you cannot make, the customer is upset or wants a refund, or they ask for a human. REQUIRES the customer's email address: ask for it first if you don't have it. The full chat transcript is attached automatically — summarize, don't re-type it. If this conversation ALREADY has a ticket, use this ONLY for a genuinely separate problem — one a different person would work, or that would be closed on its own. For anything about the issue that ticket is already about, use add_to_ticket.",
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
              // A ticket that appeared DURING this turn — a console operator
              // converting the chat while the loop ran — was not a decision the
              // model made, and is by definition about the issue in front of
              // it. Refuse that one. A ticket that was already there when the
              // turn started is different: holding both tools, the model chose
              // this one, and that choice is the "separate issue" judgement the
              // pair exists to allow.
              if (conv.ticketId && !ctx.chat?.ticketId) {
                return "Someone on the team just opened a ticket for this conversation, so no second one was created. Tell the customer their question is with the team and they'll get a reply by email — do not mention a ticket number.";
              }
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
                // Where the transcript Freshdesk just received ends. It comes
                // from openTicketForConversation because only that function saw
                // the snapshot it sent — anything the visitor typed during the
                // upload is AFTER this mark, and so reaches the team on the
                // first add_to_ticket instead of vanishing between the two.
                lastTicketSyncAt: created.syncMark,
                // The one it supersedes moves to the history, so the console
                // and any later lookup can still find it. Only the newest is
                // "active" — see ChatConversation.previousTicketIds.
                ...(conv.ticketId
                  ? {
                      previousTicketIds: [...(conv.previousTicketIds ?? []), conv.ticketId],
                      ticketedAt: new Date().toISOString(),
                    }
                  : {}),
                visitor: { email: email.trim() },
              });

              return `Ticket #${created.id} created for ${email.trim()}. Tell the customer their question has gone to the team and they'll get a reply by email — do NOT give them the ticket number or this URL. INTERNAL: ${created.url}`;
            },
          }),
        }
      : {}),

    /*
     * Once the ticket exists, this replaces it.
     *
     * The reason it has to exist at all: the ticket carries a SNAPSHOT of the
     * transcript taken the moment it was opened. Everything the customer says
     * afterwards lives only in our Redis, and the agent who picks the ticket up
     * never sees it. "Oh, and it only happens in Safari" — said thirty seconds
     * after the hand-off — was invisible to the only person who could act on
     * it. This is the pipe from the still-running chat to the ticket.
     *
     * A private note, not a reply: a public reply would email the customer a
     * copy of a conversation they are currently having, and the ticket's public
     * thread belongs to the agent who will answer it, not to Jetta.
     */
    ...(isOwnChat && ctx.chat?.ticketId
      ? {
          add_to_ticket: tool({
            description:
              "Add new information to the support ticket this conversation already has. Use it whenever the customer tells you something the team does not yet know ABOUT THAT SAME ISSUE: a new symptom, the answer to a question you asked, a screenshot, that it has become urgent, or that they changed their mind. The new chat messages and any files they have sent since the ticket was opened go with it automatically — write what CHANGED, do not re-type the conversation. This does not email the customer; it is how the agent handling their ticket finds out. If the customer has raised a genuinely DIFFERENT problem — one a different person would work, or that would be closed on its own — that needs its own ticket: use create_support_ticket instead, and never bundle it into this note.",
            inputSchema: z.object({
              note: z
                .string()
                .describe(
                  "What the team needs to know that they didn't when the ticket was opened, in a sentence or two.",
                ),
            }),
            execute: async ({ note }) => {
              if (!ticketId) return "No active conversation.";
              const conv = await chatStoreForTools.getConversation(ticketId);
              if (!conv) return "This conversation has expired.";
              if (!conv.ticketId) {
                return "This conversation has no ticket yet — use create_support_ticket instead.";
              }
              if (dry) return `[dry-run] would add a note to ticket #${conv.ticketId}: "${note}".`;

              // Everything said since the last push. The mark starts at the
              // moment of ticketing, so the first call carries exactly what the
              // ticket's own transcript is missing.
              const since = conv.lastTicketSyncAt ?? conv.ticketedAt;
              const fresh = chatStoreForTools.messagesSince(conv, since);

              /*
               * Is the ticket still alive?
               *
               * The widget's session never expires — the token is a plain HMAC
               * with no timestamp and the conversation id sits in the embedding
               * page's localStorage — so a visitor who chatted three weeks ago
               * and comes back RESUMES this conversation, ticket and all. A
               * note on a ticket a colleague closed a fortnight ago lands
               * somewhere nobody is watching, and Freshdesk does not reopen a
               * ticket because a note arrived. She would tell the customer
               * their message reached the team; it would not have.
               *
               * Fail OPEN on a failed lookup: "I could not reach Freshdesk" is
               * not "the ticket is closed", and noting a live ticket wrongly
               * costs nothing while opening a duplicate costs the team a thread.
               */
              const route = routeTicketUpdate(
                await freshdesk.getTicketStatus(conv.ticketId),
                conv.visitor.email,
              );
              if (route.kind === "needs_email") {
                return `The previous ticket is ${route.status} and this needs a new one, but there is no email address on file. Ask the customer for their email address, then call this again.`;
              }
              if (route.kind === "replace") {
                const status = route.status;
                // The whole transcript and every file, not just the delta: a
                // fresh ticket has to stand on its own, and the agent picking
                // it up has none of the history the closed one carried.
                const reopened = await openTicketForConversation(conv, {
                  email: route.email,
                  subject: suggestedSubject({ ...conv, messages: fresh }),
                  summary: [
                    `Follow-up from a live chat, after ticket #${conv.ticketId} was ${status}.`,
                    note.trim(),
                  ].join("\n\n"),
                  productHint: ctx.appProduct,
                }).catch((e) => {
                  console.warn(`add_to_ticket: replacement ticket failed:`, e);
                  return null;
                });
                if (!reopened) {
                  return "The previous ticket is closed and a new one could not be opened just now. Do NOT tell the customer their message reached the team. Answer what you can and say you'll make sure someone picks this up.";
                }
                await chatStoreForTools.updateConversation(ticketId, {
                  ticketId: reopened.id,
                  ticketedAt: new Date().toISOString(),
                  // The replacement carries the FULL transcript, so nothing is
                  // outstanding against it — the mark goes to the end of what
                  // it sent, not to the end of the delta. Same rule, same
                  // source, as the create path above.
                  lastTicketSyncAt: reopened.syncMark,
                });
                await events.logOpsEvent({
                  level: "info",
                  event: "chat.ticket_replaced",
                  source: "jettachat",
                  ticketId,
                  data: { closedTicket: conv.ticketId, closedStatus: status, newTicket: reopened.id },
                });
                return `The previous ticket was ${status}, so a new ticket #${reopened.id} was opened carrying this whole conversation. Tell the customer their follow-up has gone to the team and they'll get a reply by email — do NOT give them the ticket number or this URL. INTERNAL: ${reopened.url}`;
              }

              const delta = chatStoreForTools.transcriptSince(conv, since);
              const files = await chatFiles.collectForHandoff({ messages: fresh }).catch(() => []);

              const body = [
                `From the live chat, which is still running: ${note.trim()}`,
                delta ? `\n— New chat messages —\n${delta}` : "",
                files.length ? `\nFiles attached: ${files.map((f) => f.name).join(", ")}` : "",
                `\nConversation: ${jettachat.conversationUrl(conv.id)}`,
              ]
                .filter(Boolean)
                .join("\n");

              try {
                await freshdesk.addPrivateNote(conv.ticketId, body, { attachments: files });
              } catch (e) {
                // Unlike the note on ticket CREATION, this note is the whole
                // action — swallowing the failure would have her tell the
                // customer their update reached the team when it did not.
                const message = e instanceof Error ? e.message : String(e);
                console.warn(`add_to_ticket failed on #${conv.ticketId}:`, message);
                return "Could not reach the ticket system just now, so this has NOT been added. Do not tell the customer it has. Answer what you can and say you'll make sure the team sees the rest.";
              }

              // Advance the mark only on success, and to the last message we
              // actually sent rather than to "now": a message that landed while
              // the note was in flight belongs to the next push, not to a gap.
              const mark = fresh.at(-1)?.createdAt;
              if (mark) {
                await chatStoreForTools
                  .updateConversation(ticketId, { lastTicketSyncAt: mark })
                  .catch((e) => console.warn(`add_to_ticket: sync mark not advanced:`, e));
              }

              await events.logOpsEvent({
                level: "info",
                event: "chat.added_to_ticket",
                source: "jettachat",
                ticketId,
                data: {
                  freshdeskTicket: conv.ticketId,
                  messages: fresh.length,
                  files: files.length,
                },
              });

              return `Added to ticket #${conv.ticketId}. Tell the customer you've passed the new detail to the team handling their ticket — do NOT give them the ticket number, and do not say a new ticket was opened.`;
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
        "Search the Dev board for items matching the error/symptom. ALWAYS call before create_dev_item. Every hit carries a `confidence`: \"strong\" means it IS this issue in different words; \"possible\" means an overlap worth your glance and NOTHING more — do not treat a possible match as the same bug, do not tell the customer it is already tracked, and file a new item anyway (a human can merge them; you cannot un-merge). `state` says whether the board still has it in flight. An empty result is a normal, useful answer.",
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
            confidence: i.confidence,
            state: i.state,
          })),
        ),
    }),

    read_dev_item_comments: tool({
      description:
        "Read the comments engineering has left on a Dev board item. Call this on a strong match from search_dev_board before you answer — it may already be fixed, or a dev may have asked for information you can collect from the customer now. STRICTLY INTERNAL: these are engineers talking to each other. Never quote them, never name an engineer, and never repeat a version, date or sprint from them to the customer.",
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

    /*
     * Dev board WRITES are off the chat channel entirely.
     *
     * Reads stay: knowing a bug is already tracked, and what engineering last
     * said about it, changes the answer a visitor gets. Writes do not — they
     * change a board the visitor cannot see, and on this channel there is
     * nobody between them and the write.
     *
     * A judged eval of ten chat conversations called create_dev_item six
     * times, twice for a bare "ok 👍". With MONDAY_ALLOW_WRITES armed that is
     * six real items and six Slack pings from ten chats, filed autonomously on
     * an endpoint any anonymous visitor can reach.
     *
     * The escalation path from a chat is create_support_ticket: it is visible
     * to the customer, it can be replied to, and a person reads it before
     * anything reaches the board. Nothing is lost — the ticket carries the
     * transcript, and whoever works it files the dev item with a human's
     * judgement about whether it is one bug or five.
     */
    ...(isChat
      ? {}
      : {
    create_dev_item: tool({
      description:
        "Create a new Dev board item with full context. Call search_dev_board first: skip creating ONLY when it returned a strong match that is still open — anything less than that, file the item and mention the possible duplicate in your private note, because a human can merge two items and nobody can unpick a report attached to the wrong bug.",
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
        urgent: z
          .boolean()
          .optional()
          .describe(
            "True ONLY when the team needs to see this within minutes: the customer is on a live call, waiting in chat right now, or newly and completely blocked. Not for frustration, not for 'important', not for a bug that can wait for the next working day. Matters when this ticket has escalated before — an urgent follow-up is announced in the channel, a normal one only updates the thread.",
          ),
      }),
      execute: async ({ headline, summary, already_tried, question, urgent }) => {
        if (dry) {
          return `[dry-run] would escalate to Slack${urgent ? " (urgent)" : ""}:\nHeadline: ${headline}\nQuestion: ${question}\n-- thread reply --\nSummary: ${summary}\nTried: ${already_tried}${mondayItemUrl ? `\nDev board item: ${mondayItemUrl}` : ""}`;
        }
        const r = await slack.sendEscalation({
          freshdeskTicketUrl: ticketId ? interactionUrl(ticketId) : "(no ticket)",
          userAccountUrl: accountUrl(ctx),
          // One escalation thread per ticket: a later run adds to it instead of
          // opening a second one, and `urgent` decides whether that update is
          // announced in the channel or left in the thread.
          ticketId,
          urgent,
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
        return r.updated
          ? `This ticket already had an open escalation, so your context was added to that thread as an update rather than posted as a second escalation${urgent ? ", and announced in the channel because you marked it urgent" : ""} — the team sees it either way. Do not call send_escalation again for this ticket. To the customer this is still "escalated to the team"; do not describe it as an update or mention a thread.`
          : `Escalation posted to the dev team (ts ${r.ts}).`;
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
