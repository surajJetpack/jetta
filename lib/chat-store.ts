/**
 * JettaChat conversation store.
 *
 * Every other channel Jetta works has a vendor holding the conversation —
 * Freshdesk holds tickets, Freshchat holds chats. JettaChat has no vendor, so
 * this module *is* the system of record: the widget writes visitor turns here,
 * the agent writes its replies here, and the SSE stream reads from here.
 *
 * Storage: Upstash Redis under `jetta:chat:`, with the same single-process
 * in-memory fallback as kv.ts / kb-store.ts so credential-less STUB runs work.
 *
 * Two non-obvious pieces live here rather than in the routes:
 *
 *   1. **Conversation tokens.** The widget is unauthenticated by nature — an
 *      anonymous visitor on a marketing page has nothing to sign in with. The
 *      conversation id alone therefore cannot be the key to the transcript, or
 *      anyone could read another visitor's chat by guessing one. Every session
 *      gets an HMAC token bound to its id; the read/write routes require it.
 *
 *   2. **Turn tracking.** `pendingTurn` records the newest visitor message id
 *      so a debounced run can ask "am I still the latest?" before spending an
 *      agent loop, and `runActive` drives the typing indicator. Both are short
 *      TTL keys — they describe an in-flight moment, not durable state.
 */
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { getChatSettings } from "./chat-settings";
import { textWithAttachments } from "./chat-files";
import type { ChatAttachment, ChatConversation, ChatMessage, ChatSurface, ChatVisitor } from "./types";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}

// In-memory fallback (single-process only, mirrors kv.ts).
const memChats = new Map<string, ChatConversation>();
const memFlags = new Map<string, { value: string; expiresAt: number }>();

const convKey = (id: string) => `jetta:chat:${id}`;
const CHAT_INDEX = "jetta:chats";
const runKey = (id: string) => `jetta:chat:run:${id}`;
const turnKey = (id: string) => `jetta:chat:turn:${id}`;

/**
 * Conversations are kept for the retention window, refreshed on each write.
 * Async because retention is console-configurable: a change should apply to the
 * next write rather than waiting for a deploy.
 */
const ttlSeconds = async () => Math.max(1, (await getChatSettings()).retentionDays) * 86400;

const nowIso = () => new Date().toISOString();

// ── Conversation tokens ────────────────────────────────────────────

/**
 * HMAC of the conversation id. Not a session cookie and deliberately not
 * expiring: a visitor who reloads the page mid-chat must be able to resume,
 * and the token's only claim is "whoever created this conversation" — the
 * transcript expires with the conversation itself.
 */
export function signToken(conversationId: string): string {
  const secret = config.jettachat.secret;
  if (!secret) throw new Error("JETTACHAT_SECRET is not set — refusing to issue a conversation token.");
  return crypto.createHmac("sha256", secret).update(conversationId).digest("base64url");
}

/** Constant-time token check. Returns false rather than throwing on bad input. */
export function verifyToken(conversationId: string, token: string | null | undefined): boolean {
  if (!token || !config.jettachat.secret) return false;
  let expected: string;
  try {
    expected = signToken(conversationId);
  } catch {
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Conversations ──────────────────────────────────────────────────

export interface NewConversation {
  surface: ChatSurface;
  visitor: ChatVisitor;
  pageUrl?: string;
}

export async function createConversation(init: NewConversation): Promise<ChatConversation> {
  const at = nowIso();
  const conv: ChatConversation = {
    id: crypto.randomUUID(),
    createdAt: at,
    lastActivityAt: at,
    status: "open",
    surface: init.surface,
    pageUrl: init.pageUrl,
    visitor: init.visitor,
    messages: [],
  };
  await save(conv);
  return conv;
}

export async function getConversation(id: string): Promise<ChatConversation | null> {
  const r = client();
  if (r) return await r.get<ChatConversation>(convKey(id));
  return memChats.get(id) ?? null;
}

/**
 * Serialise read-modify-write on one conversation.
 *
 * Every mutation here is GET → change → SET of the whole document, so two
 * writers that overlap silently discard one another's change. Observed, not
 * theorised: converting a chat to a ticket while Jetta was mid-reply produced
 * a ticket and a status change, and her save — from a copy read moments
 * earlier — dropped the line telling the visitor it had happened.
 *
 * The same window can drop a customer's message when they type while a reply
 * is being written, which is the version of this bug that actually matters.
 *
 * A short NX lock rather than Lua or a message list: it is contained, needs no
 * change to how conversations are stored, and the worst case is bounded — the
 * lock self-expires, and a caller that cannot get it proceeds anyway after a
 * second of trying. Losing a message is worse than writing one out of order.
 */
const lockKey = (id: string) => `jetta:chat:lock:${id}`;

async function withConversationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const r = client();
  if (!r) return await fn(); // in-memory fallback is single-process by definition

  for (let attempt = 0; attempt < 12; attempt++) {
    const got = await r.set(lockKey(id), "1", { nx: true, px: 5000 });
    if (got) {
      try {
        return await fn();
      } finally {
        await r.del(lockKey(id)).catch(() => {});
      }
    }
    await new Promise((res) => setTimeout(res, 40 + attempt * 15));
  }
  console.warn(`chat ${id}: proceeding without the write lock after 12 attempts.`);
  return await fn();
}

/** Persist and re-index. Every write refreshes the retention TTL. */
async function save(conv: ChatConversation): Promise<void> {
  const r = client();
  if (r) {
    await r.set(convKey(conv.id), conv, { ex: await ttlSeconds() });
    await r.zadd(CHAT_INDEX, { score: Date.parse(conv.lastActivityAt), member: conv.id });
    return;
  }
  memChats.set(conv.id, conv);
}

/**
 * Append a turn. Returns the stored message, or null if the conversation is
 * gone (expired mid-session) — callers surface that as a dead session rather
 * than silently dropping the visitor's message.
 */
export async function appendMessage(
  conversationId: string,
  author: ChatMessage["author"],
  text: string,
  meta: Pick<ChatMessage, "via" | "authorName" | "system" | "attachments"> = {},
): Promise<ChatMessage | null> {
  return withConversationLock(conversationId, () => appendMessageLocked(conversationId, author, text, meta));
}

async function appendMessageLocked(
  conversationId: string,
  author: ChatMessage["author"],
  text: string,
  meta: Pick<ChatMessage, "via" | "authorName" | "system" | "attachments">,
): Promise<ChatMessage | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    author,
    // Agent messages default to Jetta: she wrote every one that predates
    // handoff, and a human's are always tagged explicitly at the call site.
    ...(author === "agent" ? { via: meta.via ?? "jetta" } : {}),
    ...(meta.authorName ? { authorName: meta.authorName } : {}),
    ...(meta.system ? { system: true } : {}),
    ...(meta.attachments?.length ? { attachments: meta.attachments } : {}),
    text,
    createdAt: nowIso(),
  };
  conv.messages.push(msg);
  conv.lastActivityAt = msg.createdAt;
  await save(conv);
  return msg;
}

type ConversationPatch = Partial<
  Pick<
    ChatConversation,
    | "status"
    | "ticketId"
    | "previousTicketIds"
    | "ticketedAt"
    | "lastTicketSyncAt"
    | "humanRequestedAt"
    | "humanAgent"
  >
> & { visitor?: Partial<ChatVisitor> };

/** Patch conversation-level fields (status, ticket link, learned identity). */
export async function updateConversation(
  conversationId: string,
  patch: ConversationPatch,
): Promise<ChatConversation | null> {
  return withConversationLock(conversationId, () => updateConversationLocked(conversationId, patch));
}

async function updateConversationLocked(
  conversationId: string,
  patch: ConversationPatch,
): Promise<ChatConversation | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  if (patch.status) conv.status = patch.status;
  /*
   * Stamp the hand-off moment here rather than at the two call sites.
   *
   * Both Jetta's create_support_ticket and the console's convert button set
   * status: "ticketed", and add_to_ticket needs to know where the transcript
   * already sent to Freshdesk ends. Making each caller remember to stamp it is
   * the shape of bug chat-ticket.ts exists to prevent — the ticket carries the
   * screenshots when the bot opens it and not when a person does. One path.
   *
   * Only on the transition: re-patching a ticketed conversation must not move
   * the mark and re-send the whole transcript as a "delta".
   */
  if (patch.status === "ticketed" && !conv.ticketedAt) {
    conv.ticketedAt = nowIso();
    /*
     * A floor, not the answer. The accurate mark is `openTicketForConversation`'s
     * `syncMark` — the end of the transcript Freshdesk actually received — and
     * every caller passes it below.
     *
     * This clock reading cannot be that value and must not be mistaken for it:
     * it is taken after the create call returns, so it sits PAST anything the
     * visitor typed during the upload, and those messages would then appear in
     * no delta at all. It stands here only so `since` is never undefined, which
     * would re-send the entire transcript as a "delta" — a louder failure, and
     * the one this line was originally added to prevent.
     */
    conv.lastTicketSyncAt ??= conv.ticketedAt;
  }
  // Explicit patches win over the stamp above: replacing a closed ticket with a
  // fresh one re-bases both marks, and the transition guard would not fire
  // because the conversation is already `ticketed`.
  if (patch.ticketedAt) conv.ticketedAt = patch.ticketedAt;
  if (patch.lastTicketSyncAt) conv.lastTicketSyncAt = patch.lastTicketSyncAt;
  // `in` rather than an undefined check: handing a conversation back passes
  // humanAgent: undefined to CLEAR it, and an undefined check would silently
  // keep the previous person's name on a conversation they had left.
  if ("humanRequestedAt" in patch) conv.humanRequestedAt = patch.humanRequestedAt;
  if ("humanAgent" in patch) conv.humanAgent = patch.humanAgent;
  if (patch.ticketId) conv.ticketId = patch.ticketId;
  if (patch.previousTicketIds) conv.previousTicketIds = patch.previousTicketIds;
  if (patch.visitor) conv.visitor = { ...conv.visitor, ...patch.visitor };
  conv.lastActivityAt = nowIso();
  await save(conv);
  return conv;
}

/**
 * Has this conversation been idle too long for the widget to resume it?
 *
 * The visitor's claim on a conversation never expires on its own — the token
 * is a plain HMAC with no timestamp, and the id sits in the embedding page's
 * localStorage indefinitely. So without this, someone who chatted a month ago
 * and comes back with a completely different problem lands in the old thread,
 * and cannot get out of it: `conversationToTicket` derives the subject and
 * description from the FIRST visitor message, permanently, however many turns
 * have happened since.
 *
 * Stale means "start a new conversation", NOT "delete this one". The transcript
 * lives out its retention window and stays in the console either way; only the
 * widget stops picking it back up.
 */
export function isStale(conv: ChatConversation, idleHours: number): boolean {
  const last = Date.parse(conv.lastActivityAt);
  // An unparseable timestamp is a corrupt record, not an old one. Resuming is
  // the safe answer: the worst case is a stale thread, and the alternative
  // silently discards a conversation that may be seconds old.
  if (!Number.isFinite(last)) return false;
  return Date.now() - last > Math.max(1, idleHours) * 3_600_000;
}

/** Newest-first conversation list for the console. */
export async function listConversations(limit = 100): Promise<ChatConversation[]> {
  const r = client();
  if (r) {
    const ids = await r.zrange<string[]>(CHAT_INDEX, 0, limit - 1, { rev: true });
    if (!ids.length) return [];
    const raw = await Promise.all(ids.map((id) => r.get<ChatConversation>(convKey(id))));
    // Conversations expire before the index entry does; prune as we read.
    const live: ChatConversation[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (raw[i]) live.push(raw[i]!);
      else await r.zrem(CHAT_INDEX, ids[i]);
    }
    return live;
  }
  return [...memChats.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, limit);
}

// ── Short-lived run state (typing indicator + debounce) ────────────

async function setFlag(key: string, value: string, ttl: number): Promise<void> {
  const r = client();
  if (r) {
    await r.set(key, value, { ex: ttl });
    return;
  }
  memFlags.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

async function getFlag(key: string): Promise<string | null> {
  const r = client();
  if (r) return await r.get<string>(key);
  const hit = memFlags.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    memFlags.delete(key);
    return null;
  }
  return hit.value;
}

async function delFlag(key: string): Promise<void> {
  const r = client();
  if (r) {
    await r.del(key);
    return;
  }
  memFlags.delete(key);
}

/**
 * Record the newest visitor message id for this conversation. A debounced run
 * compares against this before starting: if a newer message arrived during the
 * wait, this run is stale and the later one will cover the whole thought.
 */
export async function setPendingTurn(conversationId: string, messageId: string): Promise<void> {
  await setFlag(turnKey(conversationId), messageId, 300);
}

export async function isLatestTurn(conversationId: string, messageId: string): Promise<boolean> {
  return (await getFlag(turnKey(conversationId))) === messageId;
}

/**
 * Typing indicator. TTL'd well above a normal run so a crashed run can't leave
 * the widget showing "Jetta is typing" forever.
 */
export async function markRunActive(conversationId: string): Promise<void> {
  await setFlag(runKey(conversationId), "1", 180);
}

export async function clearRunActive(conversationId: string): Promise<void> {
  await delFlag(runKey(conversationId));
}

export async function isRunActive(conversationId: string): Promise<boolean> {
  /*
   * Presence, not value — and that is load-bearing.
   *
   * This used to compare `=== "1"`, which was false on every Redis-backed
   * deployment: Upstash JSON-parses on read, so the "1" written above comes
   * back as the NUMBER 1 and the comparison never matched. The typing
   * indicator therefore never turned on in production; it worked only in the
   * in-memory fallback, which is where it was written and tested.
   *
   * The neighbouring turn-id check survives the same round trip by accident —
   * a UUID is not valid JSON, so it comes back as the string it went in as.
   * Anything storing a JSON-parseable scalar here needs this treatment.
   */
  return (await getFlag(runKey(conversationId))) != null;
}

/**
 * Plain-text transcript, used for the Freshdesk hand-off and the console.
 *
 * Attachments appear as their description, not just a filename: the agent
 * picking this ticket up gets the files themselves, but the transcript has to
 * read correctly on its own — "here's the error" followed by nothing is not a
 * hand-off.
 */
export function transcriptText(conv: ChatConversation): string {
  return conv.messages
    .map((m) => {
      const who = m.author === "visitor" ? "Customer" : (m.via === "human" ? (m.authorName ?? "Support") : "Jetta");
      return `[${m.createdAt}] ${who}: ${textWithAttachments(m.text, m.attachments)}`;
    })
    .join("\n\n");
}

/**
 * The part of the transcript said after `sinceIso` — what add_to_ticket pushes
 * onto an existing Freshdesk ticket.
 *
 * Same rendering as transcriptText, and deliberately the same source: the note
 * carries what was ACTUALLY said, not the model's account of it. A summary is
 * offered alongside, never instead — the agent picking the ticket up has to be
 * able to read the customer's own words.
 *
 * Strictly after, not at-or-after: the mark is the timestamp of the last
 * message already sent, so an inclusive comparison would repeat it.
 */
export function transcriptSince(conv: ChatConversation, sinceIso: string | undefined): string {
  return transcriptText({ ...conv, messages: messagesSince(conv, sinceIso) });
}

/**
 * Turns said after `sinceIso`. Shared by the note text and the file forwarding
 * so the two can never disagree about what "new" means — a note describing a
 * screenshot it did not carry is the bug this whole path exists to avoid.
 */
export function messagesSince(conv: ChatConversation, sinceIso: string | undefined): ChatMessage[] {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  return conv.messages.filter((m) => Date.parse(m.createdAt) > since);
}

/** Every stored file across a conversation, oldest first. */
export function conversationAttachments(conv: ChatConversation): ChatAttachment[] {
  return conv.messages.flatMap((m) => m.attachments ?? []);
}
