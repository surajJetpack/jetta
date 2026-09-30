/**
 * Jetta's read-only toolkit — what she can LOOK UP, with nothing that changes
 * anything anywhere.
 *
 * Shared by every surface where a colleague, not a ticket, is on the other end:
 * the Slack DM assistant and the console voice assistant. Built fresh rather
 * than filtered out of `buildTools` (lib/tools/index.ts): a filter is one
 * careless edit away from letting a write tool back in, whereas a tool that was
 * never constructed cannot be called. Anything added here must be a pure read.
 *
 * The retrieval is deliberately the SAME path the ticket agent uses (vector +
 * rerank, keyword fallback), so an answer given to a colleague is grounded in
 * exactly what she would have used on a ticket.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { searchPublishedKb } from "./kb-store";
import { queryVector, vectorEnabled, type VectorHit } from "./vector";
import { rerankHits } from "./rerank";
import { getRunLogsByTicket, getOutcomes } from "./kv";
import { appName } from "./types";
import * as freshdesk from "./tools/freshdesk";
import * as fastspring from "./tools/fastspring";
import * as monday from "./tools/monday";

/** Keep tool results small: the whole transcript is re-sent on every step. */
const BODY_CHARS = 1200;

export function readOnlyTools(): ToolSet {
  return {
    look_up_ticket: tool({
      description:
        "A ticket at a glance: subject, status, requester, the opening message and the last few replies, shortened. Use whenever a ticket number is mentioned in passing. For the conversation in full, or to page back through a long one, use get_ticket_thread instead.",
      inputSchema: z.object({ ticket_id: z.string().describe("The ticket number, digits only.") }),
      execute: async ({ ticket_id }) => {
        const t = await freshdesk.getTicketDetails(ticket_id).catch(() => null);
        if (!t) return `No ticket ${ticket_id} found (or Freshdesk is unavailable).`;
        return JSON.stringify({
          id: t.id,
          subject: t.subject,
          status: t.status,
          requester: t.requesterName ?? t.requesterEmail,
          description: t.description.slice(0, BODY_CHARS),
          replies: t.replies.slice(-6).map((r) => ({
            author: r.author,
            private: r.isPrivate,
            body: r.body.slice(0, 600),
          })),
          // Named here even though this is the summary tool: asked "what did
          // they attach", she answered from this result and reported one pasted
          // image on a ticket carrying three PNGs, because the files were simply
          // absent from what she could see. A count she can act on beats a
          // silence she cannot.
          ...(t.attachments?.length
            ? { files: t.attachments.map((a) => `${a.name} (${a.contentType}, from ${a.author})`) }
            : {}),
        });
      },
    }),

    get_ticket_thread: tool({
      description:
        "Read a ticket's conversation as it actually happened — every message in order, who wrote it, whether it was an internal note, and which files came with it. Use when someone asks what the customer said, what they were promised, or wants the history rather than your summary of it. Returns one page: omit from_message for the most recent messages, then page backwards. look_up_ticket is the cheaper choice when a summary will do.",
      inputSchema: z.object({
        ticket_id: z.string().describe("The ticket number, digits only."),
        from_message: z
          .number()
          .optional()
          .describe(
            "Index of the first message to return; 0 is the customer's opening message. Omit for the most recent page.",
          ),
        limit: z.number().optional().describe("How many messages to return, 1-20. Defaults to 12."),
      }),
      execute: async ({ ticket_id, from_message, limit }) => {
        const t = await freshdesk
          .getTicketThread(ticket_id, { from: from_message, limit })
          .catch(() => null);
        if (!t) return `No ticket ${ticket_id} found (or Freshdesk is unavailable).`;
        return JSON.stringify({
          ticket: t.id,
          subject: t.subject,
          status: t.status,
          requester: t.requester,
          product: t.product,
          url: t.url,
          showing: `messages ${t.from}-${t.to} of ${t.total}`,
          ...(t.from > 0
            ? {
                earlier: `${t.from} earlier message(s) exist — call again with from_message: ${Math.max(0, t.from - 12)} to read them.`,
              }
            : {}),
          messages: t.messages.map((m) => ({
            i: m.index,
            at: m.at,
            from: m.author,
            direction: m.direction,
            ...(m.private ? { internal_note: true } : {}),
            body: m.body,
            // Names and sizes only. The download URL is a short-lived signed
            // link that dies within the hour, and a dead link pasted into Slack
            // is worse than no link — it reads as delivery.
            ...(m.attachments.length
              ? {
                  files: m.attachments.map((a) => ({
                    id: a.id,
                    name: a.name,
                    type: a.contentType,
                    kb: Math.round(a.size / 1024),
                  })),
                }
              : {}),
            ...(m.inlineImages
              ? { pasted_images: m.inlineImages, note: "Screenshots pasted into the message. You cannot open them." }
              : {}),
          })),
        });
      },
    }),

    search_tickets: tool({
      description:
        "Every ticket CREATED in a date window — the whole intake, not only the ones you handled. Use for 'what came in over the weekend', 'how many tickets on Saturday', 'anything new since Friday'. Both dates are included. Returns subject, status, weekday and a link per ticket.",
      inputSchema: z.object({
        from: z.string().describe('First day to include, "YYYY-MM-DD".'),
        to: z.string().describe('Last day to include, "YYYY-MM-DD". The same value as `from` for a single day.'),
        weekends_only: z
          .boolean()
          .describe("Keep only tickets created on a Saturday or Sunday. False for a plain date range."),
      }),
      execute: async ({ from, to, weekends_only }) => {
        let res;
        try {
          res = await freshdesk.searchTickets({ from, to, weekendsOnly: weekends_only });
        } catch (e) {
          // Returned rather than swallowed: Freshdesk rejects a malformed date
          // with a message naming the field, and she can fix the call and retry
          // — where a bare "nothing found" would be reported as an empty
          // weekend, which is a wrong answer rather than a failed one.
          return `Ticket search failed: ${e instanceof Error ? e.message : String(e)}`;
        }

        const window = `${res.from} to ${res.to} (${res.timezone})`;
        if (!res.tickets.length) {
          return JSON.stringify({
            window,
            count: 0,
            note: "Nothing was created in that window. That is the answer — do not substitute your own recent activity for it.",
          });
        }
        const MAX_ROWS = 40;
        return JSON.stringify({
          window,
          count: res.tickets.length,
          ...(res.truncated
            ? { note: "Freshdesk caps this search at 300 tickets, so the count is a floor — say so rather than reporting it as a total." }
            : {}),
          ...(res.tickets.length > MAX_ROWS ? { listed: MAX_ROWS, omitted: res.tickets.length - MAX_ROWS } : {}),
          tickets: res.tickets.slice(0, MAX_ROWS).map((t) => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            when: `${t.weekday} ${t.day}`,
            product: t.product,
            url: t.url,
          })),
        });
      },
    }),

    search_knowledge_base: tool({
      description:
        "Search the knowledge base. Returns the top published articles with title, URL and body. Use before answering anything about how a product behaves.",
      inputSchema: z.object({ keyword: z.string().describe("Search terms.") }),
      execute: async ({ keyword }) => {
        const hits = vectorEnabled()
          ? await rerankHits(keyword, await queryVector(keyword, 12).catch(() => [] as VectorHit[]), 5)
          : await searchPublishedKb(keyword, 5).catch(() => []);
        if (!hits.length) return "No knowledge base articles matched. Say so rather than inventing product behaviour.";
        return JSON.stringify(
          hits.map((h) => ({ title: h.title, url: h.url, body: h.body?.slice(0, BODY_CHARS) })),
        );
      },
    }),

    look_up_account: tool({
      description:
        "Look up a customer's billing account by email across the FastSpring stores: plan, status, subscription id.",
      inputSchema: z.object({ email: z.string().describe("Customer email address.") }),
      execute: async ({ email }) => {
        const found = await fastspring.findAccountAcrossStores(email).catch(() => null);
        if (!found) return `No billing account found for ${email}. They may be billed through monday instead.`;
        return JSON.stringify({ app: appName(found.appProduct), account: found.account });
      },
    }),

    search_dev_board: tool({
      description:
        "Search the monday dev board for items matching an error or symptom. Returns the board's own status (\"Working on it\", \"ToDo\", \"Waiting Customer\"…), who it is assigned to, its priority and when it last moved. A status of \"unknown\" means the board has no progress value on it — say that rather than guessing at one.",
      inputSchema: z.object({
        symptom: z.string().describe("Short description of the error or symptom."),
        product: z.enum(["getsign", "jetpackapps"]).describe("Which board to search."),
      }),
      execute: async ({ symptom, product }) =>
        JSON.stringify(await monday.searchDevBoard(symptom, product).catch(() => [])),
    }),

    read_dev_item_comments: tool({
      description:
        "Read the comments and replies on a monday dev board item — what engineering has actually said about it, newest first. Use for 'what did the devs say', 'any update on that item', or checking whether an escalation has moved. Take the item id from search_dev_board or from a link like /pulses/12790471510.",
      inputSchema: z.object({ item_id: z.string().describe("The dev board item id, digits only.") }),
      execute: async ({ item_id }) => {
        const item = await monday.getItemUpdates(item_id, 15).catch(() => null);
        if (!item) return `No dev board item ${item_id} found (or monday is unavailable).`;
        if (!item.updates.length) {
          return JSON.stringify({
            item: item.name,
            url: item.url,
            note: "The item exists but has no comments yet — nobody has posted an update on it.",
          });
        }
        return JSON.stringify({
          item: item.name,
          url: item.url,
          updates: item.updates.map((u) => ({
            at: u.at,
            author: u.author,
            text: u.text.slice(0, BODY_CHARS),
            replies: u.replies.map((r) => ({ at: r.at, author: r.author, text: r.text.slice(0, 600) })),
          })),
        });
      },
    }),

    my_history_on_ticket: tool({
      description:
        "What YOU did on a ticket previously — which tools you called, whether you replied or escalated, and the reply you wrote. Use for 'why did you…' questions about your own behaviour.",
      inputSchema: z.object({ ticket_id: z.string() }),
      execute: async ({ ticket_id }) => {
        const runs = await getRunLogsByTicket(ticket_id, 5).catch(() => []);
        if (!runs.length) return `No recorded runs for ticket ${ticket_id}.`;
        return JSON.stringify(
          runs.map((r) => ({
            at: new Date(r.at * 1000).toISOString(),
            model: r.model,
            app: r.app,
            topic: r.topic,
            toolsUsed: r.trace?.map((t) => t.tool) ?? [],
            replied: r.replied,
            escalated: r.escalated,
            reply: r.reply?.slice(0, BODY_CHARS),
            error: r.error,
          })),
        );
      },
    }),

    recent_activity: tool({
      description:
        "Recent tickets YOU handled, newest first — subject, app, topic, and whether it was escalated or reopened. Use for 'what have you been working on' and for your own escalation/reopen rate. NOT for intake: this is your share of the queue, not the queue. For 'what came in', use search_tickets.",
      inputSchema: z.object({
        limit: z.number().describe("How many recent tickets to return, 1-50."),
      }),
      execute: async ({ limit }) => {
        const outcomes = await getOutcomes(Math.min(Math.max(limit, 1), 50)).catch(() => []);
        return JSON.stringify(
          outcomes.map((o) => ({
            ticketId: o.ticketId,
            subject: o.subject,
            app: o.app,
            topic: o.topic,
            escalated: o.escalated,
            kind: o.kind,
            at: new Date(o.at * 1000).toISOString(),
          })),
        );
      },
    }),
  };
}
