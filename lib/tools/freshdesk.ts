/**
 * Freshdesk tool client — ticket CRUD + KB search.
 *
 * Every function honours STUB_MODE: with no credentials it returns realistic
 * canned data so the Claude loop and webhook path can be exercised end-to-end.
 */
import { config } from "../config";
import { imageDimensions } from "../image-dims";
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

export interface LatestAgentReply {
  /** Plain text (HTML stripped). */
  body: string;
  /** FD agent user id of the author. */
  userId: number;
  createdAt: string;
}

/** Newest outgoing (non-private) agent reply on a ticket, for draft reconciliation. */
export async function getLatestAgentReply(ticketId: string): Promise<LatestAgentReply | null> {
  if (!config.freshdesk.live) {
    return { body: "Stub agent reply body.", userId: 42, createdAt: new Date().toISOString() };
  }
  type FDConversation = {
    body_text?: string;
    body?: string;
    private: boolean;
    incoming: boolean;
    user_id: number;
    created_at: string;
  };
  const ticket = await fd<{ conversations?: FDConversation[] }>(`/tickets/${ticketId}?include=conversations`);
  const replies = (ticket.conversations ?? [])
    .filter((c) => !c.incoming && !c.private)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = replies.pop();
  if (!last) return null;
  return {
    body: last.body_text ?? stripHtml(last.body ?? ""),
    userId: last.user_id,
    createdAt: last.created_at,
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

/** Has the customer replied since the given ISO timestamp? Used by the cron. */
export async function hasCustomerReplySince(ticketId: string, since: string): Promise<boolean> {
  const ticket = await getTicketDetails(ticketId);
  const sinceMs = Date.parse(since);
  return ticket.replies.some(
    (r) => r.author === "customer" && Date.parse(r.createdAt) > sinceMs,
  );
}
