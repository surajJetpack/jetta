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

/**
 * One message is an autoresponder: an away notice or a bounce. Catches what
 * JUNK misses in a body, like #14675's "Thank you for your email. I am now
 * away for the winter season. This inbox will be checked intermittently."
 */
const AUTORESPONDER = new RegExp(
  [
    // How autoresponders open.
    String.raw`^\s*(automatic reply|auto-?reply|out of (the )?office)\b`,
    // Present tense only: "I am out of office" is a notice, "I was out of
    // office last week, the test still fails" is a customer.
    String.raw`\b(i am|i'm|i will be)( now| currently)? (out of (the )?office|away(?! from (my |the )?(desk|computer|keyboard|laptop|phone))|on (annual |parental |maternity )?leave)\b`,
    String.raw`checked intermittently|until my return|limited access to (my )?e-?mail`,
    // Bounces.
    String.raw`undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail`,
  ].join("|"),
  "i",
);

/**
 * Is this one message an autoresponder? For READING a thread (who spoke
 * last), not for the webhook gate. Stricter than JUNK, which is a subject-line
 * test: in a body, "out of office" alone is as often a person explaining a
 * slow reply. Short messages only, since an away notice is a few lines.
 */
export function looksAutomated(body: string): boolean {
  const text = body.trim();
  return text.length > 0 && text.length <= 800 && AUTORESPONDER.test(text);
}

/** Marketing / bulk-mail markers — only trusted when they appear in the body. */
const MARKETING = /unsubscribe|view (this|in) (email )?in your browser|manage (your )?(email )?preferences|you (are )?receiving this (email|because)|no longer wish to receive/i;

/**
 * Sender local-parts/addresses that never belong to a customer asking for help:
 * no-reply mailboxes, bounce handlers, automated notification senders.
 */
const NON_HUMAN_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|notifications?|newsletter|mailchimp|sendgrid|marketing)@/i;

/**
 * The newest public customer reply, when the thread has moved past the opening
 * message, i.e. the message that just arrived on a customer_reply webhook.
 * Null on a brand-new ticket (the description IS the new message) or when the
 * newest public message is ours.
 *
 * The intake gate must judge THIS, not the description. It used to read only
 * the opener, so one opener mislabelled as noise silenced every later reply on
 * the ticket: #14641 (EBSCO) lost eight human replies to "triage:auto_reply"
 * re-judging a "can you suggest a time?" opener. The reverse let a customer's
 * out-of-office through whenever the opener was real.
 */
export function newestCustomerReply(ticket: { replies?: Ticket["replies"] }): string | null {
  const latest = [...(ticket.replies ?? [])].reverse().find((r) => !r.isPrivate);
  return latest?.author === "customer" && latest.body.trim() ? newestRelayEntry(latest.body) : null;
}

/** Zendesk's reply banner — monday.com Support writes to us through it on shared customers. */
const RELAY_BANNER = /^\s*##- Please type your reply above this line -##\s*/i;
const RELAY_SEPARATOR = /(?:^|\n)[ \t]*-{20,}[ \t]*(?=\n|$)/;

/**
 * A help-desk relay (monday.com Support via Zendesk) re-sends the whole thread
 * under a "type your reply above this line" banner, newest entry first. Keep
 * only that newest entry: the banner reads as machine mail to the triage model,
 * which labelled #14583's "any update on Alison's refund?" an auto-reply.
 */
export function newestRelayEntry(body: string): string {
  if (!RELAY_BANNER.test(body)) return body;
  // Freshdesk keeps the email's CRLF line endings.
  const entries = body.replace(/\r\n?/g, "\n").replace(RELAY_BANNER, "").split(RELAY_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  return entries[0] ?? body;
}

/**
 * Return a short reason string when the ticket is UNMISTAKABLY not a customer
 * query, else null. Conservative on purpose — false positives drop real
 * customers, so only clear-cut signals fire here.
 *
 * When `replies` are present and the newest public one is the customer's, it
 * judges that reply alone. The subject belongs to the thread (set by the
 * opener), so it only counts when the opener is what is being judged.
 */
export function obviousNonQuery(
  ticket: Pick<Ticket, "subject" | "description" | "requesterEmail"> & Partial<Pick<Ticket, "replies">>,
): string | null {
  const reply = newestCustomerReply(ticket);
  const subject = reply ? "" : (ticket.subject ?? "");
  const body = reply ?? ticket.description ?? "";
  const email = (ticket.requesterEmail ?? "").trim();

  if (JUNK.test(subject) || JUNK.test(body)) return "auto_reply";
  if (email && NON_HUMAN_SENDER.test(email)) return "non_human_sender";
  if (MARKETING.test(body)) return "marketing";
  return null;
}
