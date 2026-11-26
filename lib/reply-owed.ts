/**
 * Where a ticket actually stands, read from its thread rather than its status.
 *
 * The Freshdesk status is a label a person set, and people forget: a ticket is
 * resolved with the customer's question unanswered, or parked on "waiting on
 * customer" after they wrote back. The thread cannot be forgotten. The newest
 * public message says whose turn it is.
 *
 * Two kinds of customer message do not make it our turn:
 *  - an autoresponder (away notice, bounce), which nobody wrote;
 *  - a bare acknowledgement ("ok thanks!", "perfect, that worked") after we
 *    replied, which closes a thread rather than opening one.
 * Both are kept narrow on purpose. A missed "thanks" costs one extra row on
 * /today; a real question read as "thanks" hides a waiting customer.
 */
import { looksAutomated } from "./intake";

/** What /today needs to know about one ticket. */
export interface ThreadState {
  /** Freshdesk status label right now. Null when nobody could be asked. */
  status: string | null;
  /** The newest public message is a real one from the customer: our turn. */
  awaitingReply: boolean;
  /** Unix seconds of the newest public customer / agent message. */
  lastCustomerAt: number | null;
  lastAgentAt: number | null;
  /** The newest public customer message, when it is the newest public message at all. */
  lastCustomerText?: string;
}

const ACK_OPENING =
  /^(?:(?:hi|hey|hello)\b[^\n]{0,30}?[,!.\s]+)?(?:ok(?:ay)?|great|perfect|thanks?|thank you|thx|ty|cheers|got it|sounds good|awesome|appreciated?|much appreciated|noted|will do|brilliant|excellent|wonderful|that (?:worked|works|did it|fixed it)|it (?:works|worked)(?: now)?|all good|all set|working now)\b/i;
/** Words that turn a polite opening into a new problem. */
const ACK_BREAKERS =
  /\?|\b(but|however|still|though|although|issue|problem|error|wrong|fail|failing|failed|broken|doesn'?t|does not|didn'?t|did not|isn'?t|is not|can'?t|cannot|won'?t|unable|not working|another|also|one more|question|help)\b/i;

/** "Thanks, that worked!" — a message that ends the exchange. */
export function isAcknowledgement(body: string): boolean {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) return false;
  return ACK_OPENING.test(text) && !ACK_BREAKERS.test(text);
}

/**
 * Outlook / Teams turn an emoji reaction into an email ("Haridini reacted to
 * your message"). It reaches the thread as a customer message; it asks nothing.
 */
const REACTION_NOTICE = /^\s*(?:\[[a-z ]+\]\s*)?\p{Lu}[\p{L}.'-]*(?: \p{Lu}[\p{L}.'-]*){0,4} reacted to your message\b/u;

/** A customer message that does not put the ball in our court. */
export function customerMessageNeedsNoReply(body: string): boolean {
  return looksAutomated(body) || isAcknowledgement(body) || REACTION_NOTICE.test(body.trim().slice(0, 300));
}

/** Statuses that claim the ball is NOT with us. */
const SAYS_NOT_OUR_TURN = new Set(["resolved", "closed", "waiting on customer", "pending"]);
/** Statuses that claim it IS. */
const SAYS_OUR_TURN = new Set(["open", "reopened", "customer responded"]);

/**
 * When the status and the thread disagree, a short phrase saying how; null
 * when they agree or the status says nothing either way ("escalated to dev",
 * "working on it").
 */
export function statusDisagreement(status: string | null, awaitingReply: boolean): string | null {
  if (!status) return null;
  if (awaitingReply && SAYS_NOT_OUR_TURN.has(status)) return `marked ${status}, but the customer wrote last`;
  if (!awaitingReply && SAYS_OUR_TURN.has(status)) return `marked ${status}, but we replied last`;
  return null;
}

// ── Closed tickets: did the customer's last word still need an answer? ──

/**
 * Whether a closed or resolved ticket whose customer wrote last still needs
 * an answer. Keyword rules cannot settle this: on 2026-11-26 every such row
 * on /today was the customer closing it themselves ("This is resolved",
 * "Yes I was able to cancel", "someone called me and provided a solution"),
 * each in words no list anticipated. So a light model reads that one message.
 *
 * Cached per message for 30 days: it runs once when a customer writes on a
 * closed ticket, not on every page load.
 *
 * When the model cannot be asked, the status stands (false). A closed ticket
 * is a decision a person made; overriding it needs evidence, and the first
 * version of this list showed what guessing costs.
 */
export async function closedTicketStillOwed(
  ticketId: string,
  customerAt: number | null,
  customerText: string,
  deps: {
    ask?: (text: string) => Promise<boolean>;
    cacheGet?: (key: string) => Promise<string | null>;
    cacheSet?: (key: string, value: string, ttlS: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const text = customerText.trim();
  if (!text) return false;
  const key = `today:closed-owed:${ticketId}:${customerAt ?? 0}`;
  const kv = deps.cacheGet && deps.cacheSet ? null : await import("./kv");
  const get = deps.cacheGet ?? kv!.kvGet;
  const set = deps.cacheSet ?? kv!.kvSet;
  const hit = await get(key).catch(() => null);
  if (hit === "1" || hit === "0") return hit === "1";
  let owed: boolean;
  try {
    owed = await (deps.ask ?? askModel)(text.slice(0, 2000));
  } catch {
    return false; // not cached: ask again next load
  }
  await set(key, owed ? "1" : "0", 30 * 86_400).catch(() => {});
  return owed;
}

async function askModel(text: string): Promise<boolean> {
  const [{ generateObject }, { z }, { getModel }] = await Promise.all([
    import("ai"),
    import("zod"),
    import("./llm"),
  ]);
  const { object } = await generateObject({
    model: getModel("light"),
    schema: z.object({ needsReply: z.boolean() }),
    system:
      "You read one customer email on a support ticket that an agent has already closed. " +
      "Decide whether support still owes the customer an answer. " +
      "needsReply is true only if the message asks a question, reports a problem that is not fixed, or asks support to do something. " +
      "It is false if the customer says the issue is solved or resolved, thanks the team, confirms they did what was suggested, " +
      "or complains about past service while saying it is now fixed. Ignore signatures and quoted history.",
    prompt: text,
    abortSignal: AbortSignal.timeout(8_000),
  });
  return object.needsReply;
}
