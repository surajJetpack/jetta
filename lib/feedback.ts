/**
 * Feedback for Jetta, left by the team on a dev item or in a Freshdesk
 * private note.
 *
 * Jetta posts on monday from Suraj's account, so "tagging Jetta" notified
 * Suraj and reached her as one more developer comment: she answered it as
 * if it were about the ticket, and nothing kept it. A comment that starts
 * with "Jetta feedback:" is now kept here instead, shown on the console's
 * Feedback page, and acknowledged in the thread. It starts no ticket run.
 *
 * One Redis hash, read whole: a team of ten writes a handful a week.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";

const KEY = "jetta:feedback:v1";

export interface FeedbackEntry {
  /**
   * The monday update id of the comment, or `fd:<conversation id>` for a
   * Freshdesk note, so a redelivery or a re-sync overwrites itself.
   */
  id: string;
  /** Where it was written. Missing on entries from before Freshdesk notes counted: monday. */
  source?: "monday" | "freshdesk";
  /** ISO. */
  at: string;
  author: string;
  /** The monday item id, or the Freshdesk ticket id. */
  itemId: string;
  itemName?: string;
  itemUrl?: string;
  /** The comment, without the "Jetta feedback:" opener. */
  text: string;
  /** Set when someone marks it handled on the console. */
  doneAt?: string;
  doneBy?: string;
}

/**
 * The opener, optionally after one @mention ("@Suraj Malla Jetta feedback: …"),
 * which is how the team was told to tag her. The colon or dash is required:
 * "Jetta feedback was useful here" is a sentence, not an entry.
 */
const OPENER = /^\s*(?:@[^\n:]{1,40}?\s+)?(?:jetta\s+feedback|feedback\s+(?:for|to)\s+jetta)\s*[:\-–—]\s*/i;

/** The feedback in a comment, or null when the comment is not feedback. Pure. */
export function feedbackText(comment: string): string | null {
  const m = OPENER.exec(comment);
  if (!m) return null;
  const rest = comment.slice(m[0].length).trim();
  return rest ? rest : null;
}

/**
 * Feedback in a Freshdesk conversation, or null. Pure.
 *
 * Only a private note written by a person counts: a public reply goes to the
 * customer, and an incoming message is the customer's. Her own notes never
 * count, whatever they quote. A note older than `maxAgeDays` is left alone,
 * so a full re-sync of an old thread does not refile it.
 */
export function feedbackFromNote(
  note: { id: number; body_text?: string; private: boolean; incoming: boolean; user_id?: number; created_at: string },
  ctx: { ticketId: number; subject?: string; author?: string; domain?: string; selfAgentId?: string; now?: number; maxAgeDays?: number },
): FeedbackEntry | null {
  if (!note.private || note.incoming) return null;
  if (ctx.selfAgentId && String(note.user_id) === ctx.selfAgentId) return null;
  const age = (ctx.now ?? Date.now()) - Date.parse(note.created_at);
  if (!(age < (ctx.maxAgeDays ?? 7) * 86_400_000)) return null;
  const text = feedbackText(note.body_text ?? "");
  if (!text) return null;
  return {
    id: `fd:${note.id}`,
    source: "freshdesk",
    at: note.created_at,
    author: ctx.author || "A colleague",
    itemId: String(ctx.ticketId),
    itemName: ctx.subject ? `#${ctx.ticketId} ${ctx.subject}` : `Ticket #${ctx.ticketId}`,
    ...(ctx.domain ? { itemUrl: `https://${ctx.domain}/a/tickets/${ctx.ticketId}` } : {}),
    text: text.slice(0, 4000),
  };
}

/**
 * Save a Freshdesk feedback note unless it is already saved. Its handled
 * state must survive the ticket being synced again.
 */
export async function saveFeedbackOnce(entry: FeedbackEntry): Promise<boolean> {
  const r = client();
  const exists = r ? await r.hexists(KEY, entry.id) : mem.has(entry.id);
  if (exists) return false;
  await saveFeedback(entry);
  return true;
}

/** What she answers in the thread. Pure. */
export const FEEDBACK_ACK = "Thank you, noted. This is saved to my feedback list for Suraj to review.";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, FeedbackEntry>();

export async function saveFeedback(entry: FeedbackEntry): Promise<void> {
  const r = client();
  if (!r) return void mem.set(entry.id, entry);
  await r.hset(KEY, { [entry.id]: entry });
}

/** Open ones first, newest first inside each. */
export async function listFeedback(): Promise<FeedbackEntry[]> {
  const r = client();
  const all = r ? Object.values((await r.hgetall<Record<string, FeedbackEntry>>(KEY)) ?? {}) : [...mem.values()];
  return all.sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || b.at.localeCompare(a.at));
}

/** Mark one handled, or open again. Null when there is no such entry. */
export async function setFeedbackDone(id: string, done: boolean, by: string): Promise<FeedbackEntry | null> {
  const r = client();
  const found = r ? await r.hget<FeedbackEntry>(KEY, id) : mem.get(id);
  if (!found) return null;
  const next: FeedbackEntry = { ...found, doneAt: done ? new Date().toISOString() : undefined, doneBy: done ? by : undefined };
  await saveFeedback(next);
  return next;
}
