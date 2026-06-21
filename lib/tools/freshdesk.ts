/**
 * Freshdesk tool client — ticket CRUD + KB search.
 *
 * Every function honours STUB_MODE: with no credentials it returns realistic
 * canned data so the Claude loop and webhook path can be exercised end-to-end.
 */
import { config } from "../config";
import type { Ticket, TicketReply } from "../types";

const FRESHDESK_RESOLVED = 4;
const FRESHDESK_CLOSED = 5;

function fdHeaders(): HeadersInit {
  // Freshdesk uses Basic auth: "<api_key>:X" base64-encoded.
  const token = Buffer.from(`${config.freshdesk.apiKey}:X`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json",
  };
}

function fdUrl(path: string): string {
  return `https://${config.freshdesk.domain}/api/v2${path}`;
}

async function fd<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(fdUrl(path), { ...init, headers: fdHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Freshdesk ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

// HTML → text for conversation bodies (Freshdesk stores rich text).
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface KbArticle {
  title: string;
  url: string;
  /** Full article text (HTML stripped) so Jetta can ground answers in it. */
  body: string;
}

/** Cap on per-article body length included in the tool result. */
const KB_BODY_CHARS = 2500;

export async function getTicketDetails(ticketId: string): Promise<Ticket> {
  if (!config.freshdesk.live) {
    return {
      id: ticketId,
      subject: "Column mappings reset after closing the editor",
      description:
        "Hi, every time I close the mapping editor in GetSign my column mappings are gone. Using the latest version.",
      status: "open",
      requesterName: "Sam Rivera",
      requesterEmail: "sam@example.com",
      replies: [],
    };
  }

  type FDConversation = {
    body_text?: string;
    body?: string;
    private: boolean;
    incoming: boolean;
    from_email?: string;
    created_at: string;
  };
  type FDTicket = {
    id: number;
    subject: string;
    description_text?: string;
    description?: string;
    status: number;
    requester_id: number;
    conversations?: FDConversation[];
  };
  type FDContact = { name: string; email: string };

  const ticket = await fd<FDTicket>(`/tickets/${ticketId}?include=conversations`);
  let requesterName: string | null = null;
  let requesterEmail: string | null = null;
  try {
    const contact = await fd<FDContact>(`/contacts/${ticket.requester_id}`);
    requesterName = contact.name;
    requesterEmail = contact.email;
  } catch {
    // Contact lookup is best-effort; the reply path can still proceed.
  }

  const statusMap: Record<number, string> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };
  const replies: TicketReply[] = (ticket.conversations ?? []).map((c) => ({
    author: c.incoming ? "customer" : "agent",
    authorEmail: c.from_email ?? null,
    body: c.body_text ?? stripHtml(c.body ?? ""),
    createdAt: c.created_at,
    isPrivate: c.private,
  }));

  return {
    id: String(ticket.id),
    subject: ticket.subject,
    description: ticket.description_text ?? stripHtml(ticket.description ?? ""),
    status: statusMap[ticket.status] ?? String(ticket.status),
    requesterName,
    requesterEmail,
    replies,
  };
}

export async function searchKnowledgeBase(keyword: string): Promise<KbArticle[]> {
  if (!config.freshdesk.live) {
    if (/mapping|map|column/i.test(keyword)) {
      return [
        {
          title: "GetSign: Saving column mappings",
          url: "https://support.jetpackapps.io/solution/articles/getsign-saving-mappings",
          body: "Mappings must be confirmed with the Save button before closing the editor; they are not auto-saved on close. Click Save before closing. Confirmed in v2.3+.",
        },
      ];
    }
    return [];
  }

  type FDArticle = { id: number; title: string; description_text?: string; description?: string };
  // Freshdesk's keyword search is noisy and ranks loosely, so we return the
  // FULL body of the top matches and let Jetta judge relevance and ground her
  // answer in the actual text (rather than us pre-truncating to a blurb).
  const articles = await fd<FDArticle[]>(
    `/search/solutions?term=${encodeURIComponent(keyword)}`,
  );
  return articles.slice(0, 5).map((a) => ({
    title: a.title,
    url: `https://${config.freshdesk.domain}/support/solutions/articles/${a.id}`,
    body: (a.description_text ?? stripHtml(a.description ?? "")).slice(0, KB_BODY_CHARS),
  }));
}

export async function replyToTicket(ticketId: string, body: string): Promise<void> {
  if (!config.freshdesk.live) {
    console.log(`[stub] reply_to_ticket #${ticketId}:\n${body}`);
    return;
  }
  await fd(`/tickets/${ticketId}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function addPrivateNote(ticketId: string, body: string): Promise<void> {
  if (!config.freshdesk.live) {
    console.log(`[stub] add_private_note #${ticketId}:\n${body}`);
    return;
  }
  await fd(`/tickets/${ticketId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body, private: true }),
  });
}

export async function closeTicket(ticketId: string, resolveOnly = false): Promise<void> {
  if (!config.freshdesk.live) {
    console.log(`[stub] close_ticket #${ticketId} (status=${resolveOnly ? "resolved" : "closed"})`);
    return;
  }
  await fd(`/tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify({ status: resolveOnly ? FRESHDESK_RESOLVED : FRESHDESK_CLOSED }),
  });
}

export interface OpenTicketsSummary {
  count: number;
  oldestAgeHours: number | null;
  overdue48h: { id: string; subject: string; ageHours: number }[];
}

/** Summary of open tickets for the Slack admin `open tickets` command. */
export async function listOpenTickets(): Promise<OpenTicketsSummary> {
  if (!config.freshdesk.live) {
    return {
      count: 3,
      oldestAgeHours: 61,
      overdue48h: [
        { id: "12031", subject: "GetSign export failing on large CSVs", ageHours: 61 },
      ],
    };
  }

  type FDTicket = { id: number; subject: string; created_at: string; status: number };
  // Freshdesk status 2 = open, 3 = pending.
  const tickets = await fd<FDTicket[]>(`/tickets?filter=new_and_my_open&per_page=100`);
  const now = Date.now();
  const ageHours = (t: FDTicket) => (now - Date.parse(t.created_at)) / 3_600_000;
  const open = tickets.filter((t) => t.status === 2 || t.status === 3);
  const overdue48h = open
    .filter((t) => ageHours(t) > 48)
    .map((t) => ({ id: String(t.id), subject: t.subject, ageHours: Math.round(ageHours(t)) }));
  return {
    count: open.length,
    oldestAgeHours: open.length ? Math.round(Math.max(...open.map(ageHours))) : null,
    overdue48h,
  };
}

/** Has the customer replied since the given ISO timestamp? Used by the cron. */
export async function hasCustomerReplySince(ticketId: string, since: string): Promise<boolean> {
  const ticket = await getTicketDetails(ticketId);
  const sinceMs = Date.parse(since);
  return ticket.replies.some(
    (r) => r.author === "customer" && Date.parse(r.createdAt) > sinceMs,
  );
}
