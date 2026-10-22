/**
 * Following up with developers on quiet dev items — the daily cron
 * (app/api/cron/dev-followup).
 *
 * The customer-side follow-ups (lib/ticket-followup.ts) chase a quiet
 * CUSTOMER. This chases a quiet ITEM: a customer is waiting on a ticket, the
 * ticket's dev item is still in flight, and nobody has written on it or moved
 * its Dev Status for `quietWorkdays`. Jetta asks the Developer for an update;
 * if two asks go unanswered, the item is raised once in the escalation
 * channel, where a person decides what happens next. Then she stops — a
 * third, fourth, fifth ping on the same silence is noise, not follow-up.
 *
 * Any sign of life resets it: a comment, a reply, a status change.
 */
import { config } from "./config";
import { logOpsEvent } from "./events";
import { kvGet, kvSet, rememberJettaPost } from "./kv";
import * as monday from "./tools/monday";
import * as freshdesk from "./tools/freshdesk";
import * as slack from "./tools/slack";
import type { DevItemSnapshot } from "./tools/monday";

/** Asks before the item goes to the escalation channel. */
const MAX_ASKS = 2;
/** Posts per cron run, so a backlog can't become a burst on the board. */
const MAX_ACTIONS_PER_RUN = 15;

/**
 * Whole working days between two instants, skipping `weekend` (0 = Sunday).
 * Counts calendar days in UTC — at day granularity, close enough for "has it
 * been three working days". Pure.
 */
export function workdaysBetween(fromIso: string, to: Date, weekend: number[]): number {
  const start = new Date(fromIso);
  if (Number.isNaN(start.getTime())) return 0;
  let days = 0;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (d.getTime() < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!weekend.includes(d.getUTCDay())) days++;
  }
  return days;
}

/** Item states where a nudge is wrong: the ball is not with the developer. */
const PARKED_STATUS = /^(hold|on hold|waiting for spec|waiting for ba|scheduled meeting|scheduled call)$/i;

export type FollowUpDecision =
  | { action: "none"; reason: string }
  | { action: "ask"; n: number; quietDays: number }
  | { action: "escalate"; quietDays: number };

/**
 * What, if anything, to do about one item today. Pure.
 *
 * Quiet since = the latest of: a person's comment, a Dev Status change, the
 * item's creation. Jetta's own asks don't count as activity, and only the asks
 * made AFTER the last activity count towards the two.
 */
export function decideFollowUp(
  item: Pick<
    DevItemSnapshot,
    "group" | "devStatus" | "lastPersonActivityAt" | "devStatusChangedAt" | "createdAt" | "askTimes" | "type"
  >,
  ticketStatus: string | null,
  now: Date,
  rules: { quietWorkdays: number; weekend: number[] },
): FollowUpDecision {
  if (ticketStatus === null) return { action: "none", reason: "ticket status unknown" };
  if (freshdesk.isTerminalStatus(ticketStatus)) return { action: "none", reason: `ticket ${ticketStatus}` };
  // Freshdesk's "waiting on customer" is NOT checked: it is set whenever our
  // last reply went out, including "the team is on it" — which is exactly the
  // customer waiting on US. Whether the ball is with the customer is the
  // ITEM's call: developers set "Waiting Customer" / "Need more info" (below).
  if (!monday.devItemInFlight({ group: item.group, status: item.devStatus }))
    return { action: "none", reason: "item finished" };
  if (monday.isNeedsInfoDevStatus(item.devStatus))
    return { action: "none", reason: "item is waiting on the customer" };
  if (PARKED_STATUS.test((item.devStatus ?? "").trim())) return { action: "none", reason: `parked (${item.devStatus})` };
  if (/feature/i.test(item.type ?? "")) return { action: "none", reason: "feature request" };

  const activity = [item.lastPersonActivityAt, item.devStatusChangedAt, item.createdAt]
    .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!activity) return { action: "none", reason: "no timestamps" };

  const asks = item.askTimes.filter((t) => Date.parse(t) > Date.parse(activity));
  const since = asks.length ? asks[asks.length - 1] : activity;
  const quiet = workdaysBetween(since, now, rules.weekend);
  const quietTotal = workdaysBetween(activity, now, rules.weekend);
  if (quiet < rules.quietWorkdays) return { action: "none", reason: `quiet ${quiet}d` };
  if (asks.length < MAX_ASKS) return { action: "ask", n: asks.length + 1, quietDays: quietTotal };
  return { action: "escalate", quietDays: quietTotal };
}

/** The nudge. NUDGE_PHRASE marks it so the next run counts it. */
export function nudgeText(ticketId: string, quietDays: number, n: number): string {
  const ask = n === 1 ? "Any progress, or anything you need from them?" : "Could you post where this stands, even if it's just blocked?";
  return `No update here for ${quietDays} working days, and the customer on ticket #${ticketId} ${monday.NUDGE_PHRASE}. ${ask}`;
}

export interface FollowUpRow {
  itemId: string;
  ticketId: string;
  decision: FollowUpDecision;
  done?: string;
}

export async function runDevFollowUp(now = new Date()): Promise<FollowUpRow[]> {
  const mode = config.devFollowUp;
  if (mode === "off") return [];
  const rules = config.devFollowUpRules;
  const rows: FollowUpRow[] = [];
  let actions = 0;

  for (const { id, ticketIds } of await monday.liveLinkedItemIds()) {
    const ticketId = ticketIds[0];
    const item = await monday.getDevItemSnapshot(id).catch(() => null);
    if (!item) continue;
    const status = await freshdesk.getTicketStatus(ticketId);
    const decision = decideFollowUp(item, status, now, rules);
    const row: FollowUpRow = { itemId: id, ticketId, decision };
    rows.push(row);
    if (decision.action === "none" || actions >= MAX_ACTIONS_PER_RUN) continue;
    actions++;

    if (decision.action === "ask") {
      const text = nudgeText(ticketId, decision.quietDays, decision.n);
      if (mode === "shadow") {
        row.done = "shadow";
        await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId, data: { itemId: id, ask: decision.n, text, to: item.developers.map((d) => d.name) } });
        continue;
      }
      const posted = await monday.postJettaComment(id, text, { mentionUserIds: item.developers.map((d) => d.id) });
      if (posted) await rememberJettaPost(posted.id);
      row.done = posted ? `asked (${decision.n})` : "writes off";
      await logOpsEvent({ level: "info", event: "devbridge.followup", source: "cron", ticketId, data: { itemId: id, ask: decision.n } });
      continue;
    }

    // Escalate once per silence: keyed on the last ask, so a fresh round
    // after a developer replies can escalate again, and this one can't twice.
    const key = `devbridge:followup-escalated:${id}:${item.askTimes.at(-1) ?? ""}`;
    if (await kvGet(key)) {
      row.done = "already escalated";
      continue;
    }
    if (mode === "shadow") {
      row.done = "shadow";
      await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId, data: { itemId: id, escalate: true, quietDays: decision.quietDays } });
      continue;
    }
    await slack.sendEscalation({
      ticketId,
      ticketRef: `#${ticketId}`,
      freshdeskTicketUrl: freshdesk.freshdeskTicketUrl(ticketId),
      userAccountUrl: "",
      mondayItemUrl: item.url,
      devBoardId: item.boardId,
      headline: `Dev item quiet for ${decision.quietDays} working days — customer still waiting`,
      summary: `"${item.name}" (Dev Status: ${item.devStatus ?? "unknown"}) has had no comment or status change for ${decision.quietDays} working days. Jetta asked ${item.developers.length ? item.developers.map((d) => d.name).join(", ") : "the board (no Developer assigned)"} for an update twice on the item, with no answer.`,
      alreadyTried: `Asked on the item ${MAX_ASKS} times.`,
      question: "Who can pick this up, or what should we tell the customer?",
    });
    await kvSet(key, "1", 60 * 24 * 3600);
    row.done = "escalated";
    await logOpsEvent({ level: "info", event: "devbridge.followup_escalated", source: "cron", ticketId, data: { itemId: id, quietDays: decision.quietDays } });
  }
  return rows;
}
