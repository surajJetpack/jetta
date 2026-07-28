/**
 * Intake pre-filter — decide whether a ticket is a genuine customer query worth
 * drafting a reply for, or noise Jetta should skip (out-of-office / auto-replies,
 * bounces, no-reply notifications, marketing/newsletters).
 *
 * `obviousNonQuery` is the CHEAP, DETERMINISTIC half of the intake gate (the
 * light-model triage in lib/context.ts is the other half). It only fires on
 * unmistakable patterns so it can never drop a real customer — anything
 * ambiguous is left for triage (which itself defaults to "customer_query").
 */
import type { Ticket } from "./types";

/**
 * Subjects/bodies of automated system mail — out-of-office autoresponders,
 * bounces, delivery-status notifications. High precision: a human writing in
 * for support does not put "out of office" or "undeliverable" in their subject.
 * Shared with the retrospective benchmark + human-reply mining (which use it to
 * drop the same junk from their ticket samples).
 */
export const JUNK =
  /automatic reply|auto-?reply|out of office|automatisch antwoord|abwesenheit|undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|read receipt/i;

/** Marketing / bulk-mail markers — only trusted when they appear in the body. */
const MARKETING = /unsubscribe|view (this|in) (email )?in your browser|manage (your )?(email )?preferences|you (are )?receiving this (email|because)|no longer wish to receive/i;

/**
 * Sender local-parts/addresses that never belong to a customer asking for help:
 * no-reply mailboxes, bounce handlers, automated notification senders.
 */
const NON_HUMAN_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|notifications?|newsletter|mailchimp|sendgrid|marketing)@/i;

/**
 * Return a short reason string when the ticket is UNMISTAKABLY not a customer
 * query, else null. Conservative on purpose — false positives drop real
 * customers, so only clear-cut signals fire here.
 */
export function obviousNonQuery(ticket: Ticket): string | null {
  const subject = ticket.subject ?? "";
  const body = ticket.description ?? "";
  const email = (ticket.requesterEmail ?? "").trim();

  if (JUNK.test(subject) || JUNK.test(body)) return "auto_reply";
  if (email && NON_HUMAN_SENDER.test(email)) return "non_human_sender";
  if (MARKETING.test(body)) return "marketing";
  return null;
}
