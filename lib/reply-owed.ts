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
