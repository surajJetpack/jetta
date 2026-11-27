/**
 * The team's 👍 / 👎 on Jetta's replies in JettaChat, given on the console's
 * Chats page.
 *
 * Chat replies go to the customer with no review first (docs/jettachat.md);
 * reading the transcript afterwards is the review. This is where that review
 * leaves a mark. A 👎 also lands on the Feedback page with the customer's
 * message and her reply, so it can be followed up and marked handled. A rating
 * changes nothing about how she answers by itself.
 *
 * Each person rates each reply once (id = conversation, message, rater): a
 * changed mind overwrites, two colleagues can disagree. The exchange is copied
 * in, because conversations expire from the chat store and the rating should
 * outlive them.
 *
 * One Redis hash, read whole, like lib/feedback.ts: a team of ten rates a
 * handful of replies a day.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import { CHAT_FEEDBACK_REASONS, type ChatFeedbackReason } from "./chat-feedback-reasons";

export { CHAT_FEEDBACK_REASONS, type ChatFeedbackReason };

const KEY = "jetta:chat-feedback:v1";

export interface ChatFeedback {
  /** `${conversationId}:${messageId}:${author}` */
  id: string;
  conversationId: string;
  messageId: string;
  /** ISO. */
  at: string;
  author: string;
  rating: "up" | "down";
  reasons: ChatFeedbackReason[];
  note?: string;
  /** What the customer wrote since Jetta last spoke; empty when she spoke first. */
  customer: string;
  /** Her reply as the customer saw it. */
  reply: string;
  app?: string;
  visitorName?: string;
  doneAt?: string;
  doneBy?: string;
}

/** The fields the server copies from the conversation, never from the browser. */
export interface ReplyContext {
  customer: string;
  reply: string;
  app?: string;
  visitorName?: string;
}

interface Msg {
  id: string;
  author: "visitor" | "agent";
  via?: "jetta" | "human";
  system?: boolean;
  text: string;
}

/**
 * The reply a rating is about, and what the customer had said before it. Pure.
 * Null when the message is not one of Jetta's own replies: a teammate's
 * message or a system line cannot be rated here.
 */
export function replyContext(messages: Msg[], messageId: string): Pick<ReplyContext, "customer" | "reply"> | null {
  const i = messages.findIndex((m) => m.id === messageId);
  const m = messages[i];
  if (!m || m.system || m.author !== "agent" || m.via === "human") return null;
  const asked: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const p = messages[j]!;
    if (p.system) continue;
    if (p.author === "agent") break;
    if (p.text.trim()) asked.unshift(p.text.trim());
  }
  return { customer: asked.join("\n").slice(0, 4000), reply: m.text.slice(0, 6000) };
}

/** The rating a request body describes, or an error. Pure. */
export function parseChatRating(
  body: unknown,
): { conversationId: string; messageId: string; rating: "up" | "down"; reasons: ChatFeedbackReason[]; note?: string } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body required" };
  const b = body as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "string" && /^[\w-]{1,80}$/.test(v);
  if (!ok(b.conversationId) || !ok(b.messageId)) return { error: "conversationId and messageId required" };
  if (b.rating !== "up" && b.rating !== "down") return { error: "rating must be up or down" };
  const reasons =
    b.rating === "down" && Array.isArray(b.reasons)
      ? [...new Set(b.reasons.filter((r): r is ChatFeedbackReason => typeof r === "string" && r in CHAT_FEEDBACK_REASONS))]
      : [];
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 2000) : undefined;
  return {
    conversationId: b.conversationId as string,
    messageId: b.messageId as string,
    rating: b.rating,
    reasons,
    ...(note ? { note } : {}),
  };
}

export function chatFeedbackId(conversationId: string, messageId: string, author: string): string {
  return `${conversationId}:${messageId}:${author}`;
}

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
/**
 * Without Redis (tests, local dev) ratings live in memory. On globalThis,
 * because the dev server loads each route's copy of this module separately.
 */
const mem: Map<string, ChatFeedback> = ((globalThis as { __jettaChatFeedback?: Map<string, ChatFeedback> }).__jettaChatFeedback ??=
  new Map());

export async function saveChatFeedback(entry: ChatFeedback): Promise<void> {
  const r = client();
  if (!r) return void mem.set(entry.id, entry);
  await r.hset(KEY, { [entry.id]: entry });
}

export async function deleteChatFeedback(id: string): Promise<void> {
  const r = client();
  if (r) await r.hdel(KEY, id);
  else mem.delete(id);
}

async function all(): Promise<ChatFeedback[]> {
  const r = client();
  return r ? Object.values((await r.hgetall<Record<string, ChatFeedback>>(KEY)) ?? {}) : [...mem.values()];
}

/** Open 👎 first, then the rest; newest first inside each. */
export async function listChatFeedback(): Promise<ChatFeedback[]> {
  const rank = (f: ChatFeedback) => (f.rating === "down" && !f.doneAt ? 0 : 1);
  return (await all()).sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}

/** Every rating on one conversation, for its transcript. */
export async function chatFeedbackFor(conversationId: string): Promise<ChatFeedback[]> {
  return (await all()).filter((f) => f.conversationId === conversationId);
}

export async function setChatFeedbackDone(id: string, done: boolean, by: string): Promise<ChatFeedback | null> {
  const r = client();
  const found = r ? await r.hget<ChatFeedback>(KEY, id) : mem.get(id);
  if (!found) return null;
  const next: ChatFeedback = { ...found, doneAt: done ? new Date().toISOString() : undefined, doneBy: done ? by : undefined };
  await saveChatFeedback(next);
  return next;
}
