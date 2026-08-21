/**
 * Freshdesk tool client — ticket CRUD + KB search.
 *
 * Every function honours STUB_MODE: with no credentials it returns realistic
 * canned data so the Claude loop and webhook path can be exercised end-to-end.
 */
import { config } from "../config";
import { imageDimensions } from "../image-dims";
import { shiftDayKey, supportTimeZone, zonedDayKey, zonedWeekday } from "../tz";
import type { Attachment, AttachmentFile, Ticket, TicketReply } from "../types";

const FRESHDESK_RESOLVED = 4;
const FRESHDESK_CLOSED = 5;

/**
 * Freshdesk status id → label, including this account's CUSTOM statuses (read
 * from /ticket_fields on 2026-08-12). Only 2-5 were mapped before, so a ticket
 * parked on any custom status reached the model as a bare number — "status: 6"
 * rather than "waiting on customer".
 */
const STATUS_LABELS: Record<number, string> = {
  2: "open",
  3: "pending",
  4: "resolved",
  5: "closed",
  6: "waiting on customer",
  7: "working on it",
  8: "escalated to dev",
  9: "reopened",
  10: "hold - account access",
  11: "validating",
  12: "customer responded",
  9000: "assigned to AI agent",
};

/**
 * Statuses where an autonomous draft is unwanted: the thread is finished. Kept
 * deliberately narrow — "waiting on customer" and "escalated to dev" are LIVE
 * threads where a customer reply is exactly what should trigger a run.
 */
const TERMINAL_STATUSES = new Set(["resolved", "closed"]);

/** True when the ticket is done and should not receive a new autonomous draft. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

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

/**
 * Retry budget for Freshdesk rate limits. Bounded so a run can't outlive its
 * function: worst case is 3 waits of at most 30s. The 30s ceiling is set above
 * the largest Retry-After observed in practice (22s) so we don't retry early and
 * burn an attempt on a second 429.
 */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

/** Exported for read-only scripts (benchmark/analysis); app code uses the typed wrappers below. */
export async function fd<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(fdUrl(path), { ...init, headers: fdHeaders() });

    // A 429 means Freshdesk REJECTED the request without processing it, so this
    // is safe to retry even for POST/PUT — there's no risk of a duplicate reply
    // or note. Without this, one rate-limited call failed an entire webhook run
    // and the customer's message went unanswered (ticket 13654, 2026-08-12).
    if (res.status === 429) {
      if (attempt >= RATE_LIMIT_RETRIES) {
        throw new Error(
          `Freshdesk ${init?.method ?? "GET"} ${path} failed: 429 after ${RATE_LIMIT_RETRIES} retries`,
        );
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000,
        MAX_RETRY_WAIT_MS,
      );
      console.warn(
        `Freshdesk 429 on ${path} — retrying in ${wait}ms (${attempt + 1}/${RATE_LIMIT_RETRIES}).`,
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Freshdesk ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }
}

// HTML → text for conversation bodies (Freshdesk stores rich text).
export function stripHtml(html: string): string {
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

type FDAttachment = {
  id: number;
  name: string;
  content_type: string;
  size: number;
  attachment_url: string;
};

function toAttachment(a: FDAttachment, author: "agent" | "customer"): Attachment {
  return {
    id: String(a.id),
    name: a.name,
    contentType: a.content_type,
    size: a.size,
    url: a.attachment_url,
    author,
  };
}

type FDConversation = {
  body_text?: string;
  body?: string;
  private: boolean;
  incoming: boolean;
  from_email?: string;
  /** FD agent who authored the reply — identifies Jetta's own sends. */
  user_id?: number;
  created_at: string;
  attachments?: FDAttachment[];
};

const CONVERSATIONS_PER_PAGE = 100;
/** Page ceiling — bounds cost on a runaway thread. 500 replies is far past any real ticket. */
const MAX_CONVERSATION_PAGES = 5;

/**
 * Every conversation on a ticket, oldest first.
 *
 * NOT `GET /tickets/:id?include=conversations`: that embeds only the **first 10**
 * — verified on tickets 13901, 13894, 13924 and 13895, where the embedded set was
 * always positions 0-9 of the full thread. It therefore hides the NEWEST replies,
 * which are the ones a reply has to answer, and it silently froze the webhook's
 * "newest customer message" marker so long threads stopped being answered at all.
 */
async function fetchConversations(ticketId: string): Promise<FDConversation[]> {
  const all: FDConversation[] = [];
  for (let page = 1; page <= MAX_CONVERSATION_PAGES; page++) {
    const batch = await fd<FDConversation[]>(
      `/tickets/${ticketId}/conversations?per_page=${CONVERSATIONS_PER_PAGE}&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < CONVERSATIONS_PER_PAGE) break;
  }
  return all;
}

/**
 * Freshdesk serves images pasted INTO a message body (rather than attached to
 * it) from this host, with an access token in the URL and no expiry. These never
 * appear in the API's `attachments[]` — the ticket HTML is the only record.
 */
const INLINE_HOST = "attachment.freshdesk.com";

/**
 * Inline-image floor. Most inline images in support email are not evidence: they
 * are email-signature logos, spacers, and tracking pixels. Measured on ticket
 * 13944, whose description holds three real screenshots (803×615, 570×273,
 * 529×263) plus the sender's signature logo (215×50) — dimensions separate those
 * cleanly, file size does not. The aspect cap catches wide signature banners
 * that would otherwise clear the width and height floors.
 */
const MIN_INLINE_BYTES = 5 * 1024;
const MIN_INLINE_WIDTH = 250;
const MIN_INLINE_HEIGHT = 120;
const MAX_INLINE_ASPECT = 5;

/**
 * How many evidence-sized images are pasted into this HTML.
 *
 * Freshdesk's `<img>` tags carry width/height attributes, so this costs no
 * requests — the same thresholds the download path applies to real pixels are
 * applied here to the declared ones. A tag without dimensions is counted:
 * over-reporting an image is better than staying silent about one.
 */
function countInlineImages(html: string): number {
  let n = 0;
  for (const [tag] of html.matchAll(/<img[^>]*>/gi)) {
    if (!tag.includes(`https://${INLINE_HOST}/`)) continue;
    const w = Number(/\bwidth="(\d+)"/.exec(tag)?.[1] ?? 0);
    const h = Number(/\bheight="(\d+)"/.exec(tag)?.[1] ?? 0);
    if (w && h && (w < MIN_INLINE_WIDTH || h < MIN_INLINE_HEIGHT || w / h > MAX_INLINE_ASPECT)) {
      continue;
    }
    n++;
  }
  return n;
}

/**
 * Tell Jetta an image is there without pretending she can read it.
 *
 * Appended to the message text rather than substituted into it, because
 * getTicketDetails prefers Freshdesk's own `description_text`/`body_text` — which
 * silently omit images — so a placeholder inside stripHtml would never run on a
 * real ticket. (stripHtml is deliberately left alone: it also renders KB article
 * bodies, where "[image]" markers would be noise.)
 */
function withImageNote(text: string, html: string | undefined): string {
  const n = countInlineImages(html ?? "");
  if (!n) return text;
  // Prepended, not appended: the reply cap here and buildMessages' opening cap
  // both truncate the tail, which would silently eat a note placed at the end.
  const it = n === 1 ? "it" : "them";
  return `[system] The customer pasted ${n} image${n === 1 ? "" : "s"} into this message. You cannot view ${it} — never claim you have, and do not ask them to resend ${it}; ${n === 1 ? "it is" : "they are"} forwarded to the Dev board automatically if you escalate.\n\n${text}`;
}

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

  type FDTicket = {
    id: number;
    subject: string;
    description_text?: string;
    description?: string;
    status: number;
    requester_id: number;
    custom_fields?: Record<string, unknown>;
    attachments?: FDAttachment[];
  };
  type FDContact = { name: string; email: string };

  const [ticket, conversations] = await Promise.all([
    fd<FDTicket>(`/tickets/${ticketId}`),
    fetchConversations(ticketId),
  ]);
  let requesterName: string | null = null;
  let requesterEmail: string | null = null;
  try {
    const contact = await fd<FDContact>(`/contacts/${ticket.requester_id}`);
    requesterName = contact.name;
    requesterEmail = contact.email;
  } catch {
    // Contact lookup is best-effort; the reply path can still proceed.
  }

  const statusMap = STATUS_LABELS;
  // Context diet: this result is re-sent into the agent loop on every step, so
  // long threads are capped — newest replies win, bodies truncated. (This slice
  // only actually selects the newest now that fetchConversations returns the
  // whole thread; against the old embedded-10 it was a no-op keeping the oldest.)
  const MAX_REPLIES = 20;
  const REPLY_CHARS = 2000;
  const replies: TicketReply[] = conversations.slice(-MAX_REPLIES).map((c) => {
    // Note pasted images on incoming messages only — our own replies' inline
    // images (signatures, KB screenshots) are not customer evidence.
    const body = c.incoming
      ? withImageNote(c.body_text ?? stripHtml(c.body ?? ""), c.body)
      : (c.body_text ?? stripHtml(c.body ?? ""));
    return {
      author: c.incoming ? "customer" : "agent",
      authorEmail: c.from_email ?? null,
      body: body.length > REPLY_CHARS ? `${body.slice(0, REPLY_CHARS)}\n[…truncated]` : body,
      createdAt: c.created_at,
      isPrivate: c.private,
    };
  });

  // Attachments across the WHOLE thread, not the capped `replies` slice above —
  // an old screenshot is still the one the devs need.
  const attachments: Attachment[] = [
    // Ticket-level attachments came in with the description, i.e. from the requester.
    ...(ticket.attachments ?? []).map((a) => toAttachment(a, "customer")),
    ...conversations.flatMap((c) =>
      (c.attachments ?? []).map((a) => toAttachment(a, c.incoming ? "customer" : "agent")),
    ),
  ];

  return {
    id: String(ticket.id),
    subject: ticket.subject,
    description: withImageNote(
      ticket.description_text ?? stripHtml(ticket.description ?? ""),
      ticket.description,
    ),
    status: statusMap[ticket.status] ?? String(ticket.status),
    requesterName,
    requesterEmail,
    replies,
    productHint: (ticket.custom_fields?.cf_product as string | undefined) ?? null,
    attachments,
  };
}

// ── Full thread reading ────────────────────────────────────────────

export interface TicketMessage {
  /** 0 is the customer's opening message. Indices are stable: new replies append. */
  index: number;
  at: string;
  /** The agent's real name where we could resolve it, else "customer"/"agent". */
  author: string;
  direction: "customer" | "agent";
  /** An internal note — the customer never saw this one. */
  private: boolean;
  body: string;
  /** The body was cut short; ask for a narrower range to read the rest. */
  truncated: boolean;
  attachments: Attachment[];
  /**
   * Images pasted INTO the message body. Deliberately a count and not a list:
   * these never appear in `attachments` (Freshdesk serves them from a different
   * host entirely), so a reader who only sees `attachments: []` concludes there
   * were no screenshots when there were three.
   */
  inlineImages: number;
}

export interface TicketThread {
  id: string;
  subject: string;
  status: string;
  url: string;
  requester: string;
  product?: string;
  /** Every message on the ticket, including the opening one — not just this page. */
  total: number;
  /** The slice returned, inclusive. */
  from: number;
  to: number;
  messages: TicketMessage[];
}

export interface TicketThreadOptions {
  /** First message to return; 0 is the opening message. Omit for the newest page. */
  from?: number;
  limit?: number;
}

const THREAD_PAGE_DEFAULT = 12;
const THREAD_PAGE_MAX = 20;
/** Long enough to read a real reply; short enough that a page stays sendable. */
const THREAD_BODY_CHARS = 2000;

/**
 * A ticket conversation as something a person can actually read, a page at a
 * time, with its attachments named.
 *
 * Separate from `getTicketDetails` rather than an option on it, because the two
 * want opposite things. That one feeds the agent loop, where the result is
 * re-sent on every step: it keeps the newest 20 replies and rewrites incoming
 * bodies with a `[system]` note telling the model it cannot see the images and
 * that they'll be forwarded on escalation. Neither is right for a colleague in
 * Slack who asked what the customer said — they want to page back through the
 * whole thing, and the escalation note is about a workflow that isn't running.
 */
export async function getTicketThread(
  ticketId: string,
  { from, limit = THREAD_PAGE_DEFAULT }: TicketThreadOptions = {},
): Promise<TicketThread> {
  const size = Math.min(Math.max(Math.trunc(limit) || THREAD_PAGE_DEFAULT, 1), THREAD_PAGE_MAX);

  if (!config.freshdesk.live) {
    const t = await getTicketDetails(ticketId);
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      url: freshdeskTicketUrl(ticketId),
      requester: `${t.requesterName ?? "Unknown"} <${t.requesterEmail ?? "unknown"}>`,
      total: 1,
      from: 0,
      to: 0,
      messages: [
        {
          index: 0,
          at: new Date().toISOString(),
          author: t.requesterName ?? "customer",
          direction: "customer",
          private: false,
          body: t.description,
          truncated: false,
          attachments: [],
          inlineImages: 0,
        },
      ],
    };
  }

  type FDTicket = {
    id: number;
    subject: string;
    description_text?: string;
    description?: string;
    status: number;
    created_at: string;
    requester_id: number;
    custom_fields?: Record<string, unknown>;
    attachments?: FDAttachment[];
  };

  const [ticket, conversations] = await Promise.all([
    fd<FDTicket>(`/tickets/${ticketId}`),
    fetchConversations(ticketId),
  ]);

  let requester = `contact ${ticket.requester_id}`;
  try {
    const contact = await fd<{ name: string; email: string }>(`/contacts/${ticket.requester_id}`);
    requester = `${contact.name} <${contact.email}>`;
  } catch {
    // Best-effort, exactly as in getTicketDetails — a missing contact must not
    // cost you the conversation you asked for.
  }

  const opening: TicketMessage = {
    index: 0,
    at: ticket.created_at,
    author: "customer",
    direction: "customer",
    private: false,
    body: ticket.description_text ?? stripHtml(ticket.description ?? ""),
    truncated: false,
    attachments: (ticket.attachments ?? []).map((a) => toAttachment(a, "customer")),
    inlineImages: countInlineImages(ticket.description ?? ""),
  };

  const rest: TicketMessage[] = conversations.map((c, i) => ({
    index: i + 1,
    at: c.created_at,
    author: c.incoming ? "customer" : "agent",
    direction: c.incoming ? "customer" : "agent",
    private: c.private,
    body: c.body_text ?? stripHtml(c.body ?? ""),
    truncated: false,
    attachments: (c.attachments ?? []).map((a) => toAttachment(a, c.incoming ? "customer" : "agent")),
    inlineImages: c.incoming ? countInlineImages(c.body ?? "") : 0,
  }));

  const all = [opening, ...rest];
  const total = all.length;
  // No `from` means "the latest", which is what someone catching up wants.
  const start = Math.min(Math.max(Math.trunc(from ?? total - size), 0), Math.max(total - 1, 0));
  const page = all.slice(start, start + size).map((m) => ({
    ...m,
    body:
      m.body.length > THREAD_BODY_CHARS ? `${m.body.slice(0, THREAD_BODY_CHARS)}\n[…truncated]` : m.body,
    truncated: m.body.length > THREAD_BODY_CHARS,
  }));

  // Real names for the agent side, resolved once per distinct agent from a cache
  // — "Gabriel replied" and "Jetta replied" are different facts, and "agent"
  // hides which one it was on exactly the tickets where it matters.
  const authorIds = new Map<number, number[]>();
  conversations.forEach((c, i) => {
    if (c.incoming || !c.user_id) return;
    const index = i + 1;
    if (index < start || index >= start + size) return;
    authorIds.set(c.user_id, [...(authorIds.get(c.user_id) ?? []), index]);
  });
  await Promise.all(
    [...authorIds].map(async ([userId, indices]) => {
      const name = await getAgentName(userId);
      if (!name) return;
      for (const i of indices) {
        const m = page.find((p) => p.index === i);
        if (m) m.author = name;
      }
    }),
  );

  return {
    id: String(ticket.id),
    subject: ticket.subject,
    status: STATUS_LABELS[ticket.status] ?? String(ticket.status),
    url: freshdeskTicketUrl(ticket.id),
    requester,
    product: (ticket.custom_fields?.cf_product as string | undefined) ?? undefined,
    total,
    from: start,
    to: start + page.length - 1,
    messages: page,
  };
}

/**
 * What we forward to the Dev board: the evidence types monday.com accepts on an
 * update. Deliberately wider than screenshots — a survey of live tickets found
 * customers send screen recordings (.mp4) and documents far more often than
 * PNGs, and a repro video is the single most useful thing a dev can get.
 * message/rfc822 (forwarded .eml) is excluded: monday rejects it.
 */
const FORWARDABLE_TYPES =
  /^(image\/(png|jpe?g|gif|webp|svg\+xml)|video\/mp4|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|vnd\.ms-excel))$/i;
const MAX_FORWARD_FILES = 5;
/** Per file: Freshdesk's own attachment ceiling. Total: keeps peak memory sane. */
const MAX_FORWARD_BYTES = 20 * 1024 * 1024;
const MAX_FORWARD_TOTAL_BYTES = 40 * 1024 * 1024;

/**
 * Every attachment on a ticket, across the entire thread — the leaner path for
 * the forwarding flow, which needs files but none of the rest of the ticket.
 */
export async function listTicketAttachments(ticketId: string): Promise<Attachment[]> {
  if (!config.freshdesk.live) return [];

  const [ticket, conversations] = await Promise.all([
    fd<{ attachments?: FDAttachment[] }>(`/tickets/${ticketId}`),
    fetchConversations(ticketId),
  ]);

  return [
    // Ticket-level attachments came in with the description, i.e. from the requester.
    ...(ticket.attachments ?? []).map((a) => toAttachment(a, "customer")),
    ...conversations.flatMap((c) =>
      (c.attachments ?? []).map((a) => toAttachment(a, c.incoming ? "customer" : "agent")),
    ),
  ];
}

/** Freshdesk-hosted inline image URLs from the customer's own messages. */
async function inlineImageUrls(ticketId: string): Promise<string[]> {
  const [ticket, conversations] = await Promise.all([
    fd<{ description?: string }>(`/tickets/${ticketId}`),
    fetchConversations(ticketId),
  ]);

  const html = [
    ticket.description ?? "",
    // Incoming only — our own replies' inline images are not customer evidence.
    ...conversations.filter((c) => c.incoming).map((c) => c.body ?? ""),
  ].join("\n");

  const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
  // Freshdesk-hosted URLs ONLY. Remote <img> srcs in inbound mail are signature
  // assets and tracking pixels, and fetching an arbitrary URL out of an email
  // would turn this into a request-forgery vector pointed wherever a sender likes.
  return [...new Set(srcs.filter((u) => u.startsWith(`https://${INLINE_HOST}/`)))];
}

/**
 * Download the inline images a customer pasted into a ticket, keeping the ones
 * big enough to be actual evidence. Filename comes from the attachment id inside
 * the URL token, so the same image keeps the same name across runs.
 */
async function downloadInlineImages(ticketId: string, budgetBytes: number): Promise<AttachmentFile[]> {
  const urls = await inlineImageUrls(ticketId);
  const kept: AttachmentFile[] = [];
  let spent = 0;

  for (const url of urls) {
    if (spent >= budgetBytes) break;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const data = await res.arrayBuffer();
      if (data.byteLength < MIN_INLINE_BYTES) continue;

      const dims = imageDimensions(data);
      if (
        dims &&
        (dims.width < MIN_INLINE_WIDTH ||
          dims.height < MIN_INLINE_HEIGHT ||
          dims.width / dims.height > MAX_INLINE_ASPECT)
      ) {
        continue;
      }

      // The token's JWT payload carries Freshdesk's own attachment id.
      let id = String(kept.length + 1);
      try {
        const token = new URL(url).searchParams.get("token") ?? "";
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        if (claims?.id) id = String(claims.id);
      } catch {
        // Token shape changed — the positional fallback name is fine.
      }
      const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";

      kept.push({ name: `inline-${id}.${ext}`, contentType, data });
      spent += data.byteLength;
    } catch (e) {
      console.warn(`Inline image (ticket ${ticketId}) download failed, skipping:`, e);
    }
  }
  return kept;
}

/**
 * Download the files a customer attached to a ticket so they can be forwarded
 * elsewhere (today: the monday Dev board on escalation).
 *
 * Attachment URLs are re-resolved here rather than reusing ones captured when
 * the run started: Freshdesk hands out short-lived pre-signed S3 links and an
 * agent loop can run for a minute or more before it escalates. Per-file failures
 * are logged and skipped — a bad download must never sink the escalation itself.
 */
export async function downloadTicketAttachments(ticketId: string): Promise<AttachmentFile[]> {
  if (!config.freshdesk.live) return [];

  const attachments = await listTicketAttachments(ticketId);
  const forwardable = attachments
    .filter(
      (a) =>
        a.author === "customer" && FORWARDABLE_TYPES.test(a.contentType) && a.size <= MAX_FORWARD_BYTES,
    )
    .slice(-MAX_FORWARD_FILES);

  const files: AttachmentFile[] = [];
  let total = 0;
  for (const a of forwardable) {
    if (total + a.size > MAX_FORWARD_TOTAL_BYTES) {
      console.warn(`Attachment "${a.name}" (ticket ${ticketId}) skipped — total forward budget reached.`);
      continue;
    }
    try {
      // No auth header — attachment_url is already signed, and S3 rejects extras.
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files.push({ name: a.name, contentType: a.contentType, data: await res.arrayBuffer() });
      total += a.size;
    } catch (e) {
      console.warn(`Attachment "${a.name}" (ticket ${ticketId}) download failed, skipping:`, e);
    }
  }

  // Pasted-in screenshots are invisible to the attachments API, so they are a
  // second pass over the ticket HTML. They share the budget with real
  // attachments, and lose the race for it — a deliberately attached file is
  // stronger evidence than something that might be a signature graphic.
  if (files.length < MAX_FORWARD_FILES && total < MAX_FORWARD_TOTAL_BYTES) {
    files.push(...(await downloadInlineImages(ticketId, MAX_FORWARD_TOTAL_BYTES - total)));
  }

  return files.slice(0, MAX_FORWARD_FILES);
}

/** Ceilings for handing files to a colleague. Slack itself allows far more. */
const MAX_SEND_FILES = 10;

export interface TicketFilesRequest {
  /** Attachment names or ids. Empty/omitted means every attachment on the ticket. */
  wanted?: string[];
  /** Also fetch the screenshots pasted into message bodies, which have no filename. */
  includePasted?: boolean;
}

export interface TicketFiles {
  files: AttachmentFile[];
  /** What was left behind and why — reported to the person, never silently dropped. */
  skipped: { name: string; reason: string }[];
}

/**
 * Download a ticket's files so they can be handed to someone.
 *
 * Deliberately NOT `downloadTicketAttachments`, which looks similar and is not:
 * that one implements an escalation policy — customer-authored only, the last
 * five, and filtered to the content types monday.com will accept on an update.
 * Every one of those rules would be wrong here. A colleague asking for "the
 * file on 13943" may well mean the .eml monday rejects, or the one an agent
 * attached, and silently returning four of five files is how you end up
 * debugging the wrong screenshot.
 *
 * Size ceilings are kept, because those are about this process's memory rather
 * than about policy.
 */
export async function downloadTicketFiles(
  ticketId: string,
  { wanted, includePasted = false }: TicketFilesRequest = {},
): Promise<TicketFiles> {
  if (!config.freshdesk.live) return { files: [], skipped: [] };

  const all = await listTicketAttachments(ticketId);
  const skipped: { name: string; reason: string }[] = [];

  // Match on name or id, case- and whitespace-insensitive: the names come back
  // to us through a model that has just rendered them in a Slack message, and
  // "Crop It 2026-8-10 at 19.54.57.png" survives that round trip imperfectly.
  const norm = (s: string) => s.trim().toLowerCase();
  const asked = (wanted ?? []).map(norm).filter(Boolean);
  let chosen = asked.length
    ? all.filter((a) => asked.includes(norm(a.name)) || asked.includes(norm(a.id)))
    : all;

  for (const missing of asked.filter(
    (w) => !all.some((a) => norm(a.name) === w || norm(a.id) === w),
  )) {
    skipped.push({ name: missing, reason: "no attachment on this ticket has that name or id" });
  }

  const oversized = chosen.filter((a) => a.size > MAX_FORWARD_BYTES);
  for (const a of oversized) {
    skipped.push({ name: a.name, reason: `too large to relay (${Math.round(a.size / 1024 / 1024)}MB)` });
  }
  chosen = chosen.filter((a) => a.size <= MAX_FORWARD_BYTES).slice(0, MAX_SEND_FILES);

  const files: AttachmentFile[] = [];
  let total = 0;
  for (const a of chosen) {
    if (total + a.size > MAX_FORWARD_TOTAL_BYTES) {
      skipped.push({ name: a.name, reason: "the total size limit was reached" });
      continue;
    }
    try {
      // No auth header — attachment_url is a pre-signed S3 link and S3 rejects
      // extras. It is also short-lived, which is exactly why the bytes are
      // relayed instead of the URL.
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files.push({ name: a.name, contentType: a.contentType, data: await res.arrayBuffer() });
      total += a.size;
    } catch (e) {
      skipped.push({ name: a.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (includePasted && files.length < MAX_SEND_FILES && total < MAX_FORWARD_TOTAL_BYTES) {
    files.push(...(await downloadInlineImages(ticketId, MAX_FORWARD_TOTAL_BYTES - total)));
  }

  return { files: files.slice(0, MAX_SEND_FILES), skipped };
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

export interface SolutionArticle {
  id: string;
  title: string;
  url: string;
  body: string;
  category: string;
}

/**
 * List every published Solutions article across all categories (General,
 * GetSign, Vlookup Auto-Link, …). Used to ingest the real, multi-product
 * Freshdesk KB into the vector index. Stub returns a small sample.
 */
export async function listAllSolutionArticles(): Promise<SolutionArticle[]> {
  if (!config.freshdesk.live) {
    return [
      {
        id: "stub-1",
        title: "GetSign: Saving column mappings",
        url: "https://support.jetpackapps.io/solution/articles/getsign-saving-mappings",
        body: "Mappings must be saved with the Save button before closing the editor.",
        category: "GetSign",
      },
    ];
  }

  type FDCat = { id: number; name: string };
  type FDFolder = { id: number };
  type FDArticle = { id: number; title: string; status: number; description_text?: string; description?: string };

  const out: SolutionArticle[] = [];
  const cats = await fd<FDCat[]>(`/solutions/categories`);
  for (const cat of cats) {
    const folders = await fd<FDFolder[]>(`/solutions/categories/${cat.id}/folders`).catch(() => []);
    for (const folder of folders) {
      const articles = await fd<FDArticle[]>(`/solutions/folders/${folder.id}/articles`).catch(() => []);
      for (const a of articles) {
        if (a.status !== 2) continue; // published only
        out.push({
          id: String(a.id),
          title: a.title,
          url: `https://${config.freshdesk.domain}/support/solutions/articles/${a.id}`,
          body: (a.description_text ?? stripHtml(a.description ?? "")).slice(0, 4000),
          category: cat.name,
        });
      }
    }
  }
  return out;
}

// ── Solutions write API — publish KB articles to the customer help center ──

export interface SolutionFolder {
  id: string;
  name: string;
  categoryName: string;
}

/** List Solutions folders (targets for the category → folder mapping). */
export async function listSolutionFolders(): Promise<SolutionFolder[]> {
  if (!config.freshdesk.live) {
    return [
      { id: "stub-folder-1", name: "GetSign — How-tos", categoryName: "GetSign" },
      { id: "stub-folder-2", name: "General", categoryName: "General" },
    ];
  }
  type FDCat = { id: number; name: string };
  type FDFolder = { id: number; name: string };
  const out: SolutionFolder[] = [];
  const cats = await fd<FDCat[]>(`/solutions/categories`);
  for (const cat of cats) {
    const folders = await fd<FDFolder[]>(`/solutions/categories/${cat.id}/folders`).catch(() => []);
    for (const f of folders) out.push({ id: String(f.id), name: f.name, categoryName: cat.name });
  }
  return out;
}

/** Plain text / light markdown → simple HTML for the Freshdesk description field. */
export function textToFdHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export interface FdArticleRef {
  id: string;
  url: string;
}

/** Create a Solutions article in a folder. status: 1 = FD draft, 2 = published. */
export async function createSolutionArticle(
  folderId: string,
  a: { title: string; html: string; status?: 1 | 2 },
): Promise<FdArticleRef> {
  if (!config.freshdesk.live) {
    const id = `stub-fd-${Date.now()}`;
    console.log(`[stub] create Solutions article in folder ${folderId}: "${a.title}" (${id})`);
    return { id, url: `https://stub.freshdesk.local/solutions/articles/${id}` };
  }
  type FDArticle = { id: number };
  const created = await fd<FDArticle>(`/solutions/folders/${folderId}/articles`, {
    method: "POST",
    body: JSON.stringify({ title: a.title, description: a.html, status: a.status ?? 2 }),
  });
  return {
    id: String(created.id),
    url: `https://${config.freshdesk.domain}/support/solutions/articles/${created.id}`,
  };
}

/** Update an existing Solutions article. Throws "fd-article-gone" on 404. */
export async function updateSolutionArticle(
  articleId: string,
  a: { title: string; html: string; status?: 1 | 2 },
): Promise<FdArticleRef> {
  if (!config.freshdesk.live) {
    console.log(`[stub] update Solutions article ${articleId}: "${a.title}"`);
    return { id: articleId, url: `https://stub.freshdesk.local/solutions/articles/${articleId}` };
  }
  try {
    await fd(`/solutions/articles/${articleId}`, {
      method: "PUT",
      body: JSON.stringify({ title: a.title, description: a.html, status: a.status ?? 2 }),
    });
  } catch (e) {
    // Deleted on the Freshdesk side — signal the caller to re-create.
    if (e instanceof Error && / 404 /.test(e.message)) throw new Error("fd-article-gone");
    throw e;
  }
  return {
    id: articleId,
    url: `https://${config.freshdesk.domain}/support/solutions/articles/${articleId}`,
  };
}

/**
 * AppProduct → this account's cf_product dropdown label. Freshdesk rejects a
 * value that isn't in the dropdown, so anything unmapped is simply omitted.
 *
 * Labels transcribed from the FD ticket form (see lib/context.ts); they have
 * not been round-tripped through a live create, which is why createTicket
 * retries without the field rather than trusting them.
 */
const CF_PRODUCT_LABELS: Record<string, string> = {
  vlookup: "VLOOKUP Auto-link",
  extract: "Extract",
  trackmy: "TrackMy",
  getsign: "GetSign",
  jetscan: "JetScan HR",
  triggerly: "Triggerly",
  pivotreports: "Pivot Reports Pro",
  jobflows: "Jobflows",
  smartcolumns: "Smart Columns",
};

export function cfProductLabel(app: string | null | undefined): string | undefined {
  return app ? CF_PRODUCT_LABELS[app] : undefined;
}

export interface NewTicket {
  subject: string;
  /** Ticket body — plain text; converted to HTML here. */
  description: string;
  /**
   * Pre-rendered HTML body, used VERBATIM in place of converting `description`.
   *
   * For bodies that are a layout rather than a paragraph — the chat transcript
   * arrives as bubbles (lib/chat-transcript-html.ts), which `textToFdHtml`
   * would escape into visible angle brackets. Anything passed here has already
   * escaped its own untrusted parts; `description` stays populated as the
   * plain-text version, which is what the stub path logs and what any future
   * non-HTML consumer should read.
   */
  descriptionHtml?: string;
  email: string;
  name?: string;
  /** AppProduct slug; mapped to the cf_product dropdown label when known. */
  productHint?: string | null;
  /** Freshdesk source id. 7 = chat, which is what a JettaChat hand-off is. */
  source?: number;
  /**
   * Files to attach — the visitor's chat screenshots. Sent as multipart, which
   * is the only way Freshdesk accepts them on ticket creation.
   */
  attachments?: AttachmentFile[];
}

export interface CreatedTicket {
  id: string;
  url: string;
}

/** Fallback used when FRESHDESK_DOMAIN is unset. */
const DEFAULT_FD_DOMAIN = "jetpackwork.freshdesk.com";

/**
 * Agent-side URL for a ticket.
 *
 * One helper because this was being rebuilt in five places with two DIFFERENT
 * fallback domains — four said jetpackwork, one said jetpackapps — so a
 * missing env var would have sent people to somebody else's helpdesk from one
 * screen and the right one from the rest.
 */
export function freshdeskDomain(): string {
  return config.freshdesk.domain ?? DEFAULT_FD_DOMAIN;
}

export function freshdeskTicketUrl(ticketId: string | number): string {
  return `https://${freshdeskDomain()}/a/tickets/${ticketId}`;
}

/**
 * Create a ticket with files attached.
 *
 * Freshdesk takes attachments only as multipart, and its multipart parser is
 * not the JSON one: nested objects have to be flattened into bracket keys
 * (`custom_fields[cf_product]`) and there is no Content-Type header to set —
 * fetch must write the boundary itself.
 */
async function postTicketMultipart(
  body: Record<string, unknown>,
  files: AttachmentFile[],
): Promise<{ id: number }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v != null) form.append(`${key}[${k}]`, String(v));
      }
    } else {
      form.append(key, String(value));
    }
  }
  for (const f of files) {
    form.append("attachments[]", new Blob([f.data], { type: f.contentType }), f.name);
  }

  const token = Buffer.from(`${config.freshdesk.apiKey}:X`).toString("base64");
  const res = await fetch(fdUrl("/tickets"), {
    method: "POST",
    // Authorization only: adding Content-Type here would override the boundary
    // fetch generates and Freshdesk would reject the body as malformed.
    headers: { Authorization: `Basic ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Freshdesk POST /tickets (multipart) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: number };
}

/**
 * Open a new ticket. Used by the JettaChat hand-off: when Jetta can't resolve a
 * chat, the conversation becomes a Freshdesk ticket carrying the transcript —
 * the same destination an unanswered chat reaches today, just with the context
 * already attached.
 *
 * Status 2 ("open") and the chat source keep these visibly distinct from email
 * intake in Freshdesk views.
 */
export async function createTicket(t: NewTicket): Promise<CreatedTicket> {
  if (!config.freshdesk.live) {
    const id = `stub-${Date.now()}`;
    console.log(`[stub] create_ticket for ${t.email}: "${t.subject}"\n${t.description}`);
    return { id, url: `https://stub.freshdesk.local/a/tickets/${id}` };
  }
  const base = {
    subject: t.subject,
    description: t.descriptionHtml ?? textToFdHtml(t.description),
    email: t.email,
    name: t.name,
    status: 2,
    priority: 1,
    source: t.source ?? 7,
    // Required when the account has Freshdesk Products enabled, which this one
    // does. Its absence is what made every chat hand-off fail: Freshdesk
    // rejected the ticket outright, the customer was told there was "a
    // technical issue", and nothing recorded why.
    ...(config.freshdesk.productId ? { product_id: Number(config.freshdesk.productId) } : {}),
  };
  const cfProduct = cfProductLabel(t.productHint);

  const files = (t.attachments ?? []).slice(0, MAX_FORWARD_FILES);

  const post = (body: Record<string, unknown>) =>
    files.length
      ? postTicketMultipart(body, files)
      : fd<{ id: number }>("/tickets", { method: "POST", body: JSON.stringify(body) });

  let created: { id: number };
  try {
    created = await post(cfProduct ? { ...base, custom_fields: { cf_product: cfProduct } } : base);
  } catch (e) {
    // Attribution is a nicety; the hand-off is not. If cf_product is rejected
    // (label drift on the dropdown), open the ticket without it rather than
    // dropping a customer who was told their question would reach the team.
    //
    // But ONLY for that error. This used to retry on any 400, which meant a
    // missing product_id was reported as "cf_product rejected" and then failed
    // again for the real reason — the fallback hid the diagnosis for as long
    // as the feature was broken.
    const message = e instanceof Error ? e.message : String(e);
    if (!cfProduct || !/cf_product/i.test(message)) throw e;
    console.warn(`createTicket: cf_product "${cfProduct}" rejected, retrying without it:`, e);
    created = await post(base);
  }

  return { id: String(created.id), url: freshdeskTicketUrl(created.id) };
}

/**
 * Just the status label, in one GET.
 *
 * getTicketDetails would answer this too, but it also pulls the whole
 * conversation thread and the contact record — three requests and a full
 * transcript to read one field. This is called on the chat path, where a
 * visitor is watching a typing indicator.
 *
 * Returns null when the lookup fails, and callers are expected to fail OPEN on
 * that: "I could not reach Freshdesk" must not be treated as "the ticket is
 * closed".
 */
export async function getTicketStatus(ticketId: string): Promise<string | null> {
  if (!config.freshdesk.live) return "open";
  try {
    const t = await fd<{ status: number }>(`/tickets/${ticketId}`);
    return STATUS_LABELS[t.status] ?? String(t.status);
  } catch (e) {
    console.warn(`getTicketStatus(${ticketId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
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

/**
 * Add an agent-only note.
 *
 * `text` is PLAIN text and is converted here. The notes field is HTML, so
 * passing raw text through meant every line break collapsed — a five-line note
 * arrived as one paragraph — and any "<" in model-written text went into an
 * HTML field unescaped. Callers that have already built HTML pass `html: true`.
 */
export async function addPrivateNote(
  ticketId: string,
  text: string,
  opts: { html?: boolean; attachments?: AttachmentFile[] } = {},
): Promise<void> {
  if (!config.freshdesk.live) {
    console.log(
      `[stub] add_private_note #${ticketId}` +
        (opts.attachments?.length ? ` (+${opts.attachments.length} file(s))` : "") +
        `:\n${text}`,
    );
    return;
  }
  const body = opts.html ? text : textToFdHtml(text);
  const files = (opts.attachments ?? []).slice(0, MAX_FORWARD_FILES);
  if (files.length) {
    // Same multipart shape as postTicketMultipart, and for the same reason:
    // Freshdesk takes files only as multipart, and fetch must be left to write
    // its own boundary. A note is where a chat's later screenshots land — the
    // ticket was created before the customer sent them.
    await postNoteMultipart(ticketId, body, files);
    return;
  }
  await fd(`/tickets/${ticketId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body, private: true }),
  });
}

async function postNoteMultipart(
  ticketId: string,
  bodyHtml: string,
  files: AttachmentFile[],
): Promise<void> {
  const form = new FormData();
  form.append("body", bodyHtml);
  form.append("private", "true");
  for (const f of files) {
    form.append("attachments[]", new Blob([f.data], { type: f.contentType }), f.name);
  }
  const token = Buffer.from(`${config.freshdesk.apiKey}:X`).toString("base64");
  const res = await fetch(fdUrl(`/tickets/${ticketId}/notes`), {
    method: "POST",
    headers: { Authorization: `Basic ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Freshdesk POST /tickets/${ticketId}/notes (multipart) failed: ${res.status} ${await res.text()}`,
    );
  }
}

export interface LatestAgentReply {
  /** Plain text (HTML stripped). */
  body: string;
  /** FD agent user id of the author. */
  userId: number;
  createdAt: string;
}

/** Newest outgoing (non-private) agent reply on a ticket, for draft reconciliation. */
/**
 * The FIRST public agent reply sent at or after `sinceIso` — the reply that
 * answers a given draft.
 *
 * Not "the latest reply": when reconciling a draft that is hours or weeks old
 * (the cron and the backfill both do), the newest reply on the thread may belong
 * to a completely different exchange, which would score as unrelated and record
 * a false "ignored" verdict.
 *
 * Uses fetchConversations, so it sees the whole thread. The previous
 * `?include=conversations` version only ever saw the OLDEST 10 conversations, so
 * on any long ticket it returned an early reply and called it the latest.
 */
export async function getAgentReplyAfter(
  ticketId: string,
  sinceIso: string,
): Promise<LatestAgentReply | null> {
  if (!config.freshdesk.live) {
    return { body: "Stub agent reply body.", userId: 42, createdAt: new Date().toISOString() };
  }

  const conversations = await fetchConversations(ticketId);
  const reply = conversations
    .filter((c) => !c.incoming && !c.private && c.created_at >= sinceIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!reply) return null;

  return {
    body: reply.body_text ?? stripHtml(reply.body ?? ""),
    userId: reply.user_id ?? 0,
    createdAt: reply.created_at,
  };
}

// Agents change rarely — cache name lookups for the life of the instance.
const agentNameCache = new Map<number, string>();

/** Display name of an FD agent, or null when the lookup fails. */
export async function getAgentName(agentId: number): Promise<string | null> {
  if (!config.freshdesk.live) return "Stub Agent";
  const cached = agentNameCache.get(agentId);
  if (cached) return cached;
  try {
    const agent = await fd<{ contact?: { name?: string } }>(`/agents/${agentId}`);
    const name = agent.contact?.name ?? null;
    if (name) agentNameCache.set(agentId, name);
    return name;
  } catch {
    return null;
  }
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

// ── Ticket search ──────────────────────────────────────────────────

export interface TicketSearchRow {
  id: string;
  subject: string;
  status: string;
  /** As Freshdesk stores it: UTC. */
  createdAt: string;
  /** Calendar day and weekday in the support timezone — the terms the question was asked in. */
  day: string;
  weekday: string;
  product?: string;
  url: string;
}

export interface TicketSearchResult {
  timezone: string;
  /** The window applied, inclusive, in `timezone`. */
  from: string;
  to: string;
  tickets: TicketSearchRow[];
  /**
   * Freshdesk matched more than it will page out, so `tickets` is a slice and
   * any count taken from it is a floor, not a total.
   */
  truncated: boolean;
}

/** Freshdesk's filter API: 30 results per page, 10 pages, hard stop at 300. */
const SEARCH_PER_PAGE = 30;
const SEARCH_MAX_PAGES = 10;

export interface TicketSearchOptions {
  /** Inclusive first day, "YYYY-MM-DD", in the support timezone. */
  from: string;
  /** Inclusive last day. */
  to: string;
  weekendsOnly?: boolean;
}

/**
 * Tickets CREATED in a date window — all of them, not just the ones Jetta
 * touched. This is the intake question ("what came in over the weekend"), which
 * her run history cannot answer and which had no route at all before.
 *
 * Two behaviours of Freshdesk's filter API drive the shape here, both probed
 * against the live account on 2026-08-16:
 *
 *  - `created_at` takes a DATE, not a timestamp: `'2026-08-14T00:00:00Z'` is
 *    rejected outright with a validation error.
 *  - both `>` and `<` are INCLUSIVE of the day named. `created_at:>'2026-08-15'`
 *    returns tickets from the 15th, and `created_at:<'2026-05-13'` returns
 *    tickets created at 23:42 on the 13th. Treating `<` as exclusive would
 *    silently swallow a day.
 *
 * So the query is deliberately a day wider at each end than asked for, and the
 * exact window is applied here against real timestamps in the support zone. The
 * spare day costs one page at most; losing half a Saturday to a UTC offset is a
 * wrong answer nobody would catch.
 */
export async function searchTickets({
  from,
  to,
  weekendsOnly = false,
}: TicketSearchOptions): Promise<TicketSearchResult> {
  const timezone = supportTimeZone();

  if (!config.freshdesk.live) {
    const at = `${from}T09:12:44Z`;
    return {
      timezone,
      from,
      to,
      tickets: [
        {
          id: "13988",
          subject: "GetSign — signature request stuck at 'sending'",
          status: "open",
          createdAt: at,
          day: zonedDayKey(new Date(at), timezone),
          weekday: zonedWeekday(new Date(at), timezone),
          url: freshdeskTicketUrl("13988"),
        },
      ],
      truncated: false,
    };
  }

  type FDSearchTicket = {
    id: number;
    subject: string;
    status: number;
    created_at: string;
    custom_fields?: Record<string, unknown>;
  };

  const query = `"created_at:>'${shiftDayKey(from, -1)}' AND created_at:<'${shiftDayKey(to, 1)}'"`;
  const found: FDSearchTicket[] = [];
  let total = 0;

  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const d = await fd<{ total: number; results: FDSearchTicket[] }>(
      `/search/tickets?query=${encodeURIComponent(query)}&page=${page}`,
    );
    total = d.total;
    found.push(...d.results);
    if (d.results.length < SEARCH_PER_PAGE) break;
    if (page * SEARCH_PER_PAGE >= Math.min(total, SEARCH_PER_PAGE * SEARCH_MAX_PAGES)) break;
  }

  const tickets = found
    .map((t): TicketSearchRow => {
      const at = new Date(t.created_at);
      return {
        id: String(t.id),
        subject: t.subject,
        status: STATUS_LABELS[t.status] ?? String(t.status),
        createdAt: t.created_at,
        day: zonedDayKey(at, timezone),
        weekday: zonedWeekday(at, timezone),
        // cf_product holds the label itself, not a slug — it is the same field
        // getTicketDetails reads as productHint, and it is often unset.
        product: (t.custom_fields?.cf_product as string | undefined) ?? undefined,
        url: freshdeskTicketUrl(t.id),
      };
    })
    .filter((t) => t.day >= from && t.day <= to)
    .filter((t) => !weekendsOnly || t.weekday === "Sat" || t.weekday === "Sun")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    timezone,
    from,
    to,
    tickets,
    // Counted on the widened window, before the filtering above — which is the
    // honest direction to be wrong in: it claims uncertainty slightly too often
    // rather than reporting a partial count as complete.
    truncated: total > SEARCH_PER_PAGE * SEARCH_MAX_PAGES,
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
