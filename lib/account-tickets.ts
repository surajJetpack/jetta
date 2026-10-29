/**
 * Earlier tickets on the chat visitor's monday account.
 *
 * A JettaChat run used to know only the conversation in front of it. On
 * 2026-10-28 a visitor asked "did my template get fixed?" from inside GetSign;
 * a colleague had opened ticket #14652 about exactly that from the same account
 * two days earlier, and engineering had just fixed it. Jetta asked the visitor
 * what the problem was.
 *
 * The account is the link: the in-app view tells us which monday account the
 * visitor is in, and the chat that became the ticket recorded the same one
 * (lib/chat-store.ts, accountTicketIds). This turns those tickets into a short
 * brief: subject, status, our last public reply, and its dev item's progress.
 *
 * Read on every chat turn, so it is cached per conversation: the ticket reads
 * spend Freshdesk's shared 40/min quota, and a chat is many turns.
 */
import { accountTicketIds, trustedSlug } from "./chat-store";
import { kvGet, kvSet } from "./kv";
import * as freshdesk from "./tools/freshdesk";
import * as monday from "./tools/monday";
import type { ChatConversation } from "./types";

/** Newest tickets shown. Enough for "the one about X"; more is noise. */
const MAX_TICKETS = 3;
const CACHE_SECONDS = 15 * 60;
const REPLY_CHARS = 500;

export interface AccountTicket {
  id: string;
  subject: string;
  status: string;
  /** Who opened it. INTERNAL — the visitor may be a colleague, not this person. */
  requesterName: string | null;
  /** Opened by the visitor in front of us (same email), or by someone else on the account. */
  openedByVisitor: boolean;
  /** Our newest public reply on it. */
  lastReply?: { at: string; text: string };
  devItems: { title: string; status: string; inFlight: boolean }[];
}

const cacheKey = (conversationId: string) => `jetta:chat:account-context:${conversationId}`;

/**
 * Null when the account isn't one a monday app view vouches for: an editable
 * support link must not show one customer another's tickets.
 */
export async function accountTicketsForChat(conv: ChatConversation): Promise<AccountTicket[] | null> {
  const slug = trustedSlug(conv);
  if (!slug) return null;

  const cached = await kvGet(cacheKey(conv.id)).catch(() => null);
  // Upstash hands a JSON value back already parsed.
  if (cached) return (typeof cached === "string" ? JSON.parse(cached) : cached) as AccountTicket[];

  const ids = (await accountTicketIds(slug)).filter((id) => id !== conv.ticketId).slice(0, MAX_TICKETS);
  const visitorEmail = conv.visitor.email?.trim().toLowerCase();
  const rows = await Promise.all(
    ids.map(async (id): Promise<AccountTicket | null> => {
      const [ticket, items] = await Promise.all([
        freshdesk.getTicketDetails(id).catch(() => null),
        monday.devItemsForTicket(id).catch(() => []),
      ]);
      if (!ticket) return null;
      const reply = [...ticket.replies].reverse().find((r) => r.author === "agent" && !r.isPrivate);
      return {
        id,
        subject: ticket.subject,
        status: ticket.status,
        requesterName: ticket.requesterName,
        openedByVisitor: !!visitorEmail && ticket.requesterEmail?.toLowerCase() === visitorEmail,
        lastReply: reply ? { at: reply.createdAt, text: reply.body.replace(/\s+/g, " ").trim().slice(0, REPLY_CHARS) } : undefined,
        devItems: items.map((i) => ({ title: i.title, status: i.status, inFlight: i.state === "open" })),
      };
    }),
  );
  const tickets = rows.filter((t): t is AccountTicket => t !== null);
  await kvSet(cacheKey(conv.id), JSON.stringify(tickets), CACHE_SECONDS).catch(() => {});
  return tickets;
}
