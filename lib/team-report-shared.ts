/**
 * The parts of the daily team report that the console page needs at run time,
 * kept apart from lib/team-report.ts so a client component can import them
 * without pulling the report builder (and through it the Freshdesk client and
 * the server config) into the browser bundle. No imports, on purpose.
 */

/** Past this the ticket is not "reply today" any more: someone has to decide to answer or close it. */
export const STALE_AFTER_H = 14 * 24;

/** A dev-board handback older than this is no longer news; it is counted, not listed. */
export const DEV_FRESH_H = 14 * 24;

/**
 * Support often answers the customer first and sets the dev item's status a
 * few minutes later (ticket #14854: reply 06:30, item marked Not an Issue
 * 06:49; #14868: reply 04:50, Waiting Customer 05:32). A reply from us this
 * close BEFORE the developer's move, with nothing from the customer since,
 * counts as the customer having been told. Without it Jetta asked Sujata to do
 * what she had just done.
 */
export const TOLD_GRACE_MS = 2 * 3_600_000;

/**
 * Has the customer heard from us about a developer move at `at`? Yes when our
 * last public message is after it, or shortly before it (TOLD_GRACE_MS) and
 * the customer has not written since. `lastPublicFrom` is who wrote the
 * ticket's latest public message.
 */
export function customerToldAbout(at: number, lastPublicAt: number | null | undefined, lastPublicFrom: "agent" | "customer" | string | null | undefined): boolean {
  if (lastPublicFrom !== "agent" || lastPublicAt == null || !Number.isFinite(lastPublicAt)) return false;
  return lastPublicAt > at - TOLD_GRACE_MS;
}

/** The lists a count can open. The id is what a link carries (`?list=`). */
export const LIST_LABEL = {
  replies: "Replies to customers",
  notes: "Private notes",
  first: "First replies",
  filed: "Dev items filed",
  comments: "Comments on dev items",
  chats: "Chats taken over",
  chatActions: "Chat messages and actions",
  slack: "Slack messages",
  sent: "Replies Jetta sent herself",
  drafts: "Drafts Jetta wrote",
  escalations: "Slack escalations",
  ticketed: "Chats turned into a ticket",
} as const;
export type ListId = keyof typeof LIST_LABEL;
export const isListId = (v: string | null | undefined): v is ListId => !!v && v in LIST_LABEL;
/** Key of a list in `TeamReport.lists`: whose, and which. */
export const listKey = (who: string, list: ListId) => `${who}:${list}`;
/** Jetta's key in `lists`, and in links. */
export const JETTA_WHO = "jetta";

/** 0.4 → "24 min", 5.25 → "5.3h", 80 → "3.3d", 5587 → "233d". */
export function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  const d = h / 24;
  return d < 10 ? `${Math.round(d * 10) / 10}d` : `${Math.round(d)}d`;
}
