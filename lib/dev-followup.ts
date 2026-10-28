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
 *
 * Items with no ticket link (filed by hand, the customer named in the title)
 * get the same rhythm when a Reporter filed them: someone in support is
 * waiting even without a ticket Jetta can read. There the Reporter is asked
 * when the ball is on the support side: Waiting Customer, or no Developer.
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
/** Groups holding the team's own work, which no customer is waiting on. */
const INTERNAL_GROUP = /internal/i;
/**
 * An unlinked item this quiet is abandoned rather than late: pinging it is
 * noise. Linked items have no such cap, since their open ticket says
 * someone is still waiting.
 */
const ABANDONED_WORKDAYS = 60;
/** Snapshots fetched at once: fast enough for ~200 items, gentle on monday's limits. */
const CONCURRENCY = 5;

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

type ItemFacts = Pick<
  DevItemSnapshot,
  "group" | "devStatus" | "lastPersonActivityAt" | "devStatusChangedAt" | "createdAt" | "askTimes" | "type"
> &
  Partial<Pick<DevItemSnapshot, "lastJettaPostAt">>;

type None = { action: "none"; reason: string };

export type FollowUpDecision =
  | None
  | { action: "ask"; n: number; quietDays: number }
  | { action: "escalate"; quietDays: number };

/** Who an unlinked item's ask is for, and why. */
export type AskAbout = "developer" | "customer" | "owner";

export type UnlinkedDecision =
  | None
  | { action: "ask"; n: number; quietDays: number; about: AskAbout }
  | { action: "escalate"; quietDays: number; about: AskAbout };

/** Why no follow-up fits this item at all, whoever it would go to; null if one may. */
function notChaseable(item: ItemFacts): None | null {
  if (!monday.devItemInFlight({ group: item.group, status: item.devStatus }))
    return { action: "none", reason: "item finished" };
  if (PARKED_STATUS.test((item.devStatus ?? "").trim())) return { action: "none", reason: `parked (${item.devStatus})` };
  if (/feature/i.test(item.type ?? "")) return { action: "none", reason: "feature request" };
  return null;
}

/**
 * How long the item has been quiet, and how many asks this silence has had.
 *
 * Quiet since = the latest of: a person's comment, a Dev Status change, the
 * item's creation. Jetta's own posts don't count as activity, and only the
 * asks made AFTER the last activity count towards the two. The clock runs
 * from her latest post, though: an ask, or anything else she said, gets
 * `quietWorkdays` to be answered before the next one.
 */
function silence(item: ItemFacts, now: Date, rules: { weekend: number[] }) {
  const activity = [item.lastPersonActivityAt, item.devStatusChangedAt, item.createdAt]
    .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!activity) return null;
  const asks = item.askTimes.filter((t) => Date.parse(t) > Date.parse(activity));
  const since = [activity, asks.at(-1), item.lastJettaPostAt]
    .filter((t): t is string => !!t && Date.parse(t) >= Date.parse(activity))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return {
    asks: asks.length,
    quiet: workdaysBetween(since, now, rules.weekend),
    quietTotal: workdaysBetween(activity, now, rules.weekend),
  };
}

/** What, if anything, to do about one ticket-linked item today. Pure. */
export function decideFollowUp(
  item: ItemFacts,
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
  const skip = notChaseable(item);
  if (skip) return skip;
  if (monday.isNeedsInfoDevStatus(item.devStatus))
    return { action: "none", reason: "item is waiting on the customer" };

  const s = silence(item, now, rules);
  if (!s) return { action: "none", reason: "no timestamps" };
  if (s.quiet < rules.quietWorkdays) return { action: "none", reason: `quiet ${s.quiet}d` };
  if (s.asks < MAX_ASKS) return { action: "ask", n: s.asks + 1, quietDays: s.quietTotal };
  return { action: "escalate", quietDays: s.quietTotal };
}

/**
 * What, if anything, to do about one item with no ticket link today. Pure.
 *
 * Only items a Reporter filed: that is the sign support is waiting on it.
 * The ask goes to the Developer, or to the Reporter when the item waits on
 * the customer (they talk to the customer) or has no Developer (they know
 * who should own it). Items quiet for ABANDONED_WORKDAYS are left alone.
 */
export function decideUnlinkedFollowUp(
  item: ItemFacts & { developers: unknown[]; reporters: unknown[] },
  now: Date,
  rules: { quietWorkdays: number; weekend: number[] },
): UnlinkedDecision {
  if (INTERNAL_GROUP.test(item.group ?? "")) return { action: "none", reason: "internal group" };
  if (!item.reporters.length) return { action: "none", reason: "no Reporter" };
  const skip = notChaseable(item);
  if (skip) return skip;

  const s = silence(item, now, rules);
  if (!s) return { action: "none", reason: "no timestamps" };
  if (s.quietTotal > ABANDONED_WORKDAYS) return { action: "none", reason: `abandoned (${s.quietTotal}d)` };
  if (s.quiet < rules.quietWorkdays) return { action: "none", reason: `quiet ${s.quiet}d` };
  const about: AskAbout = monday.isNeedsInfoDevStatus(item.devStatus)
    ? "customer"
    : item.developers.length
      ? "developer"
      : "owner";
  if (s.asks < MAX_ASKS) return { action: "ask", n: s.asks + 1, quietDays: s.quietTotal, about };
  return { action: "escalate", quietDays: s.quietTotal, about };
}

/** The nudge. NUDGE_PHRASE marks it so the next run counts it. */
export function nudgeText(ticketId: string, quietDays: number, n: number): string {
  const ask = n === 1 ? "Any progress, or anything you need from them?" : "Could you post where this stands, even if it's just blocked?";
  return `No update here for ${quietDays} working days, and the customer on ticket #${ticketId} ${monday.NUDGE_PHRASE}. ${ask}`;
}

/** The nudge on an item with no ticket. Every variant carries NUDGE_PHRASE. */
export function unlinkedNudgeText(
  item: Pick<DevItemSnapshot, "devStatus" | "reporters">,
  about: AskAbout,
  quietDays: number,
  n: number,
): string {
  if (about === "customer")
    return `This has been at "${item.devStatus}" for ${quietDays} working days and ${monday.NUDGE_PHRASE} on the customer. Have they replied? If so, please add what they said here so the developer can carry on. If not, should we chase them again or close this?`;
  if (about === "owner")
    return `No developer is assigned and nothing has happened here for ${quietDays} working days, so this ${monday.NUDGE_PHRASE} for an owner. Who should pick it up, or should it go to the backlog?`;
  const reporter = item.reporters[0]?.name ?? "support";
  const ask = n === 1 ? "Any progress, or anything you need?" : "Could you post where this stands, even if it's just blocked?";
  return `No update here for ${quietDays} working days, and ${reporter} ${monday.NUDGE_PHRASE} on it for the customer. ${ask}`;
}

export interface PlanRow {
  item: DevItemSnapshot;
  /** The ticket it was filed for; null on an unlinked item. */
  ticketId: string | null;
  ticketStatus: string | null;
  decision: FollowUpDecision | UnlinkedDecision;
}

/**
 * Today's decision for every candidate, without acting. Linked items always;
 * unlinked ones unless `unlinked` is false (their switch is off), which also
 * saves fetching ~200 snapshots for nothing.
 */
export async function planDevFollowUp(now: Date, opts: { unlinked: boolean }): Promise<PlanRow[]> {
  const rules = config.devFollowUpRules;
  const candidates = (await monday.liveItemIds()).filter(
    (c) => c.ticketIds.length || (opts.unlinked && !INTERNAL_GROUP.test(c.group)),
  );
  const rows: (PlanRow | null)[] = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const { id, ticketIds } = candidates[i];
      const item = await monday.getDevItemSnapshot(id).catch(() => null);
      if (!item) continue;
      if (ticketIds.length) {
        const ticketStatus = await freshdesk.getTicketStatus(ticketIds[0]);
        rows[i] = { item, ticketId: ticketIds[0], ticketStatus, decision: decideFollowUp(item, ticketStatus, now, rules) };
      } else {
        rows[i] = { item, ticketId: null, ticketStatus: null, decision: decideUnlinkedFollowUp(item, now, rules) };
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return rows.filter((r): r is PlanRow => r !== null);
}

export interface FollowUpRow {
  itemId: string;
  ticketId: string | null;
  decision: FollowUpDecision | UnlinkedDecision;
  done?: string;
}

export async function runDevFollowUp(now = new Date()): Promise<FollowUpRow[]> {
  if (config.devFollowUp === "off") return [];
  const unlinkedMode = config.devFollowUpUnlinked;
  const rows: FollowUpRow[] = [];
  let actions = 0;

  for (const { item, ticketId, decision } of await planDevFollowUp(now, { unlinked: unlinkedMode !== "off" })) {
    const id = item.id;
    const mode = ticketId ? config.devFollowUp : unlinkedMode;
    const row: FollowUpRow = { itemId: id, ticketId, decision };
    rows.push(row);
    if (decision.action === "none" || actions >= MAX_ACTIONS_PER_RUN) continue;
    actions++;
    const about = "about" in decision ? decision.about : "developer";
    const to = about === "developer" ? item.developers : item.reporters;
    const ticketEvent = ticketId ?? undefined;

    if (decision.action === "ask") {
      const text = ticketId
        ? nudgeText(ticketId, decision.quietDays, decision.n)
        : unlinkedNudgeText(item, about, decision.quietDays, decision.n);
      if (mode === "shadow") {
        row.done = "shadow";
        await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId: ticketEvent, data: { itemId: id, ask: decision.n, about, text, to: to.map((d) => d.name) } });
        continue;
      }
      const posted = await monday.postJettaComment(id, text, { mentionUserIds: to.map((d) => d.id) });
      if (posted) await rememberJettaPost(posted.id);
      row.done = posted ? `asked (${decision.n})` : "writes off";
      await logOpsEvent({ level: "info", event: "devbridge.followup", source: "cron", ticketId: ticketEvent, data: { itemId: id, ask: decision.n, about } });
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
      await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId: ticketEvent, data: { itemId: id, escalate: true, about, quietDays: decision.quietDays } });
      continue;
    }
    const asked = to.length ? to.map((d) => d.name).join(", ") : "the board (no Developer assigned)";
    const waitingOn =
      about === "customer"
        ? `Waiting on the customer for ${decision.quietDays} working days`
        : about === "owner"
          ? `No developer assigned for ${decision.quietDays} working days`
          : `Dev item quiet for ${decision.quietDays} working days`;
    await slack.sendEscalation({
      ticketId: ticketId ?? undefined,
      ticketRef: ticketId ? `#${ticketId}` : undefined,
      freshdeskTicketUrl: ticketId ? freshdesk.freshdeskTicketUrl(ticketId) : "",
      userAccountUrl: "",
      mondayItemUrl: item.url,
      devBoardId: item.boardId,
      headline: ticketId ? `${waitingOn} — customer still waiting` : `${waitingOn}: "${item.name}"`,
      summary: `"${item.name}" (Dev Status: ${item.devStatus ?? "unknown"}) has had no comment or status change for ${decision.quietDays} working days. Jetta asked ${asked} on the item twice, with no answer.${ticketId ? "" : " The item has no Freshdesk link, so the customer's ticket is not known."}`,
      alreadyTried: `Asked on the item ${MAX_ASKS} times.`,
      question:
        about === "developer" ? "Who can pick this up, or what should we tell the customer?" : about === "customer" ? "Has the customer answered, and should this item stay open?" : "Who should own this?",
    });
    await kvSet(key, "1", 60 * 24 * 3600);
    row.done = "escalated";
    await logOpsEvent({ level: "info", event: "devbridge.followup_escalated", source: "cron", ticketId: ticketEvent, data: { itemId: id, about, quietDays: decision.quietDays } });
  }
  return rows;
}
