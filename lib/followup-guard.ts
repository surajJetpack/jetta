/**
 * Should the follow-up cron close this ticket? Pure, so the rule is testable
 * without Freshdesk or Redis (scripts/followup-guard-test.ts).
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
 */

const CLOSEABLE_STATUSES = new Set(["open", "pending", "waiting on customer"]);

export type FollowUpBlock =
  /** Freshdesk unreachable — retry next run rather than close blind. */
  | { reason: "status_unknown"; retry: true }
  | { reason: "status"; status: string; retry: false }
  | { reason: "open_escalation"; retry: false };

/** Null = safe to send the closing follow-up. */
export function followUpCloseBlocker(
  status: string | null,
  hasOpenEscalation: boolean,
): FollowUpBlock | null {
  if (status === null) return { reason: "status_unknown", retry: true };
  if (!CLOSEABLE_STATUSES.has(status)) return { reason: "status", status, retry: false };
  if (hasOpenEscalation) return { reason: "open_escalation", retry: false };
  return null;
}
