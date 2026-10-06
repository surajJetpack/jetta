/**
 * Should the follow-up cron close this ticket? Pure, so the rule is testable
 * without Freshdesk, Redis or monday (scripts/followup-guard-test.ts).
 *
 * The cron's message is "I haven't heard back, so I'll assume this is
 * resolved" — true only when the ball is in the CUSTOMER's court. "No customer
 * reply since the resolution" is not enough to know that: on ticket 14453 the
 * last public message was ours promising an update from engineering, the
 * status was "escalated to dev", and the cron closed it anyway.
 *
 * So closing is an allowlist: only the statuses that mean "waiting on the
 * customer". Everything else — escalated, working on it, on hold, already
 * resolved — leaves the ticket alone. An open escalation thread blocks too:
 * the dev team has it, whatever the status says (agents don't always set it).
 *
 * And the dev board has the last word. The Slack escalation key is a proxy for
 * "engineering has this" that fails in both directions — a person filing the
 * item by hand never sets it, and it expires after 90 days — while the board
 * item itself says exactly whether the work is still in flight. An item for
 * this ticket that engineering has not finished means the issue is not
 * resolved, and a ticket whose issue is not resolved is never closed for
 * silence.
 */

const CLOSEABLE_STATUSES = new Set(["open", "pending", "waiting on customer"]);

/** What the cron needs to know about a dev item to refuse to close over it. */
export interface OpenDevItemRef {
  id: string;
  title: string;
  /** The board's Dev Status ("Working on it", "Testing Failed"…). */
  status: string;
}

export type FollowUpBlock =
  /** Freshdesk unreachable — retry next run rather than close blind. */
  | { reason: "status_unknown"; retry: true }
  | { reason: "status"; status: string; retry: false }
  | { reason: "open_escalation"; retry: false }
  /** monday unreachable — same: don't close on "couldn't check". */
  | { reason: "dev_board_unknown"; retry: true }
  /** Engineering still has an item for this ticket in flight. */
  | { reason: "open_dev_item"; items: OpenDevItemRef[]; retry: false };

/**
 * Null = safe to send the closing follow-up.
 *
 * `openDevItems` is the ticket's dev items that are still in flight
 * (lib/tools/monday.ts devItemInFlight), or null when the board could not be
 * read. Checked LAST so the cheaper Freshdesk answers short-circuit it, and so
 * a held ticket's reason names the first thing a person would look at.
 */
export function followUpCloseBlocker(
  status: string | null,
  hasOpenEscalation: boolean,
  openDevItems: OpenDevItemRef[] | null = [],
): FollowUpBlock | null {
  if (status === null) return { reason: "status_unknown", retry: true };
  if (!CLOSEABLE_STATUSES.has(status)) return { reason: "status", status, retry: false };
  if (hasOpenEscalation) return { reason: "open_escalation", retry: false };
  if (openDevItems === null) return { reason: "dev_board_unknown", retry: true };
  if (openDevItems.length) {
    return {
      reason: "open_dev_item",
      items: openDevItems.map(({ id, title, status }) => ({ id, title, status })),
      retry: false,
    };
  }
  return null;
}

/** One line a person can read: "held (open dev item: …)". */
export function describeFollowUpBlock(block: FollowUpBlock): string {
  switch (block.reason) {
    case "status":
      return `status: ${block.status}`;
    case "open_dev_item":
      return `open dev item: ${block.items.map((i) => `"${i.title}" (${i.status})`).join(", ")}`;
    default:
      return block.reason;
  }
}
