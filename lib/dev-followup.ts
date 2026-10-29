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
 * Any sign of life from a DEVELOPER resets it: their comment, a reply, a
 * status change. Someone else on the item (support asking "any update?")
 * does not — that is a chase like Jetta's, and counts towards the two.
 *
 * A question Jetta asked a developer on the item (reply_on_dev_item, kept in
 * KV) is chased the same way until any person answers it, whatever the item's
 * status: "Done" and "Waiting Customer" are exactly where one was left hanging.
 *
 * Items with no ticket link (filed by hand, the customer named in the title)
 * get the same rhythm when a Reporter filed them: someone in support is
 * waiting even without a ticket Jetta can read. There the Reporter is asked
 * when the ball is on the support side: Waiting Customer, or no Developer.
 */
import { config } from "./config";
import { logOpsEvent } from "./events";
import { clearDevQuestion, kvGet, kvSet, listDevQuestions, recordDevQuestion, rememberJettaPost, type DevQuestion } from "./kv";
import { getOpsEvents } from "./events";
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
/** Set once the questions asked before they were recorded have been backfilled. */
const QUESTIONS_BACKFILLED = "jetta:devbridge:questions:backfilled:v1";

/**
 * Questions Jetta asked before reply_on_dev_item started recording them
 * (#169), read back from the event log's devbridge.run actions. Once only,
 * and never over a question recorded since: those are newer. The cron then
 * treats them like any other — an answer since clears them.
 */
async function backfillDevQuestions(known: Map<string, DevQuestion>): Promise<void> {
  if (await kvGet(QUESTIONS_BACKFILLED)) return;
  type Action = { tool: string; input: { message?: string; mention_developer?: boolean } };
  const runs = await getOpsEvents({ event: "devbridge.run", limit: 1000 });
  // Oldest first, so an item's latest question is the one that stays.
  for (const e of [...runs].sort((a, b) => a.at - b.at)) {
    const data = e.data as { itemId?: string; actions?: Action[] } | undefined;
    const asked = data?.actions?.some((a) => a.tool === "reply_on_dev_item" && a.input.message?.includes("?"));
    if (!asked || !data?.itemId || !e.ticketId || known.has(data.itemId)) continue;
    // Who was @mentioned isn't in the log: empty sends the chase to the item's Developer.
    const q: DevQuestion = { itemId: data.itemId, ticketId: e.ticketId, at: new Date(e.at).toISOString(), to: [], threadUpdateId: "" };
    await recordDevQuestion(q);
  }
  await kvSet(QUESTIONS_BACKFILLED, "1", 365 * 24 * 3600);
}

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
  Partial<Pick<DevItemSnapshot, "lastJettaPostAt" | "lastDevActivityAt" | "otherPersonPostTimes">>;

type None = { action: "none"; reason: string };

/**
 * `since` on an escalation is when the silence began, so it is raised once
 * per silence. `question` marks a chase of Jetta's own unanswered question.
 */
export type FollowUpDecision =
  | None
  | { action: "ask"; n: number; quietDays: number; question?: true }
  | { action: "escalate"; quietDays: number; since: string; question?: true };

/** Who an unlinked item's ask is for, and why. */
export type AskAbout = "developer" | "customer" | "owner";

export type UnlinkedDecision =
  | None
  | { action: "ask"; n: number; quietDays: number; about: AskAbout }
  | { action: "escalate"; quietDays: number; since: string; about: AskAbout };

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
 *
 * `fromDeveloper`: the ball is with the Developer, so only THEIR comments are
 * activity, and anyone else's is an ask — and like an ask, it restarts the
 * clock without restarting the count.
 */
function silence(item: ItemFacts, now: Date, rules: { weekend: number[] }, fromDeveloper = false) {
  const others = fromDeveloper ? (item.otherPersonPostTimes ?? []) : [];
  const person = others.length ? (item.lastDevActivityAt ?? null) : item.lastPersonActivityAt;
  const activity = [person, item.devStatusChangedAt, item.createdAt]
    .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!activity) return null;
  const asks = [...item.askTimes, ...others]
    .filter((t) => Date.parse(t) > Date.parse(activity))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const since = [activity, asks.at(-1), item.lastJettaPostAt]
    .filter((t): t is string => !!t && Date.parse(t) >= Date.parse(activity))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return {
    activity,
    asks: asks.length,
    quiet: workdaysBetween(since, now, rules.weekend),
    quietTotal: workdaysBetween(activity, now, rules.weekend),
  };
}

/** Has anyone (not Jetta) written on the item since she asked? */
function questionAnswered(item: ItemFacts, q: Pick<DevQuestion, "at">): boolean {
  return !!item.lastPersonActivityAt && Date.parse(item.lastPersonActivityAt) > Date.parse(q.at);
}

/**
 * Chasing a question of hers nobody has answered. Its own clock: from the
 * question, then from each chase of it; two chases, then the escalation
 * channel. Pure.
 */
function decideQuestion(
  item: ItemFacts,
  q: Pick<DevQuestion, "at">,
  now: Date,
  rules: { quietWorkdays: number; weekend: number[] },
): FollowUpDecision {
  const asks = item.askTimes.filter((t) => Date.parse(t) > Date.parse(q.at));
  const quiet = workdaysBetween(asks.at(-1) ?? q.at, now, rules.weekend);
  const quietDays = workdaysBetween(q.at, now, rules.weekend);
  if (quiet < rules.quietWorkdays) return { action: "none", reason: `question open, quiet ${quiet}d` };
  if (asks.length < MAX_ASKS) return { action: "ask", n: asks.length + 1, quietDays, question: true };
  return { action: "escalate", quietDays, since: q.at, question: true };
}

/**
 * What, if anything, to do about one ticket-linked item today. Pure.
 * `question`: an open question Jetta asked on the item, if any.
 */
export function decideFollowUp(
  item: ItemFacts,
  ticketStatus: string | null,
  now: Date,
  rules: { quietWorkdays: number; weekend: number[] },
  question?: Pick<DevQuestion, "at"> | null,
): FollowUpDecision {
  if (ticketStatus === null) return { action: "none", reason: "ticket status unknown" };
  if (freshdesk.isTerminalStatus(ticketStatus)) return { action: "none", reason: `ticket ${ticketStatus}` };
  // Before the status checks: an unanswered question is the ball with them,
  // whatever the item says.
  if (question && !questionAnswered(item, question)) return decideQuestion(item, question, now, rules);
  // Freshdesk's "waiting on customer" is NOT checked: it is set whenever our
  // last reply went out, including "the team is on it" — which is exactly the
  // customer waiting on US. Whether the ball is with the customer is the
  // ITEM's call: developers set "Waiting Customer" / "Need more info" (below).
  const skip = notChaseable(item);
  if (skip) return skip;
  if (monday.isNeedsInfoDevStatus(item.devStatus))
    return { action: "none", reason: "item is waiting on the customer" };

  const s = silence(item, now, rules, true);
  if (!s) return { action: "none", reason: "no timestamps" };
  if (s.quiet < rules.quietWorkdays) return { action: "none", reason: `quiet ${s.quiet}d` };
  if (s.asks < MAX_ASKS) return { action: "ask", n: s.asks + 1, quietDays: s.quietTotal };
  return { action: "escalate", quietDays: s.quietTotal, since: s.activity };
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

  const about: AskAbout = monday.isNeedsInfoDevStatus(item.devStatus)
    ? "customer"
    : item.developers.length
      ? "developer"
      : "owner";
  const s = silence(item, now, rules, about === "developer");
  if (!s) return { action: "none", reason: "no timestamps" };
  if (s.quietTotal > ABANDONED_WORKDAYS) return { action: "none", reason: `abandoned (${s.quietTotal}d)` };
  if (s.quiet < rules.quietWorkdays) return { action: "none", reason: `quiet ${s.quiet}d` };
  if (s.asks < MAX_ASKS) return { action: "ask", n: s.asks + 1, quietDays: s.quietTotal, about };
  return { action: "escalate", quietDays: s.quietTotal, since: s.activity, about };
}

/** The nudge. NUDGE_PHRASE marks it so the next run counts it. */
export function nudgeText(ticketId: string, quietDays: number, n: number): string {
  const ask = n === 1 ? "Any progress, or anything you need from them?" : "Could you post where this stands, even if it's just blocked?";
  return `No update here for ${quietDays} working days, and the customer on ticket #${ticketId} ${monday.NUDGE_PHRASE}. ${ask}`;
}

/** Chasing her own unanswered question, in its thread. Carries NUDGE_PHRASE. */
export function questionNudgeText(ticketId: string, n: number): string {
  const ask = n === 1 ? "Could you answer it when you get a moment?" : "Could you answer it here, even briefly? Support can't get back to them without it.";
  return `Following up on my question above: the customer on ticket #${ticketId} ${monday.NUDGE_PHRASE} on this. ${ask}`;
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
  /** Jetta's open question on the item, if she asked one. */
  question?: DevQuestion;
}

/**
 * Today's decision for every candidate, without acting. Linked items always;
 * unlinked ones unless `unlinked` is false (their switch is off), which also
 * saves fetching ~200 snapshots for nothing. Items with an open question of
 * Jetta's join even from a finished group: that question is still waiting.
 */
export async function planDevFollowUp(now: Date, opts: { unlinked: boolean }): Promise<PlanRow[]> {
  const rules = config.devFollowUpRules;
  await backfillDevQuestions(new Map((await listDevQuestions()).map((q) => [q.itemId, q]))).catch((err) =>
    console.warn("dev question backfill failed:", err),
  );
  const questions = new Map((await listDevQuestions()).map((q) => [q.itemId, q]));
  const candidates = (await monday.liveItemIds()).filter(
    (c) => c.ticketIds.length || (opts.unlinked && !INTERNAL_GROUP.test(c.group)),
  );
  const listed = new Set(candidates.map((c) => c.id));
  for (const q of questions.values()) {
    if (!listed.has(q.itemId)) candidates.push({ id: q.itemId, group: "", ticketIds: [q.ticketId] });
  }
  const rows: (PlanRow | null)[] = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const { id, ticketIds } = candidates[i];
      const item = await monday.getDevItemSnapshot(id).catch(() => null);
      if (!item) continue;
      const question = questions.get(id);
      if (ticketIds.length) {
        const ticketStatus = await freshdesk.getTicketStatus(ticketIds[0]);
        rows[i] = {
          item,
          ticketId: ticketIds[0],
          ticketStatus,
          decision: decideFollowUp(item, ticketStatus, now, rules, question),
          question,
        };
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

  for (const { item, ticketId, ticketStatus, decision, question } of await planDevFollowUp(now, { unlinked: unlinkedMode !== "off" })) {
    const id = item.id;
    const mode = ticketId ? config.devFollowUp : unlinkedMode;
    const row: FollowUpRow = { itemId: id, ticketId, decision };
    rows.push(row);
    const chasingQuestion = "question" in decision && !!decision.question;
    // decideFollowUp only skips past an open question when someone answered
    // it or the ticket closed; either way it is done with. (Unknown ticket
    // status is a failed read, not an answer.)
    const questionOpen = decision.action === "none" ? decision.reason.startsWith("question open") : chasingQuestion;
    if (question && !questionOpen && ticketStatus !== null) await clearDevQuestion(id);
    if (decision.action === "none" || actions >= MAX_ACTIONS_PER_RUN) continue;
    actions++;
    const about = "about" in decision ? decision.about : "developer";
    const named = (ids: string[]) =>
      ids.map((uid) => [...item.developers, ...item.reporters].find((p) => p.id === uid) ?? { id: uid, name: "developer" });
    const to =
      chasingQuestion && question?.to.length
        ? named(question.to)
        : about === "developer" && item.developers.length
          ? item.developers
          : item.reporters;
    const ticketEvent = ticketId ?? undefined;

    if (decision.action === "ask") {
      const text = chasingQuestion && ticketId
        ? questionNudgeText(ticketId, decision.n)
        : ticketId
          ? nudgeText(ticketId, decision.quietDays, decision.n)
          : unlinkedNudgeText(item, about, decision.quietDays, decision.n);
      if (mode === "shadow") {
        row.done = "shadow";
        await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId: ticketEvent, data: { itemId: id, ask: decision.n, about, question: chasingQuestion, text, to: to.map((d) => d.name) } });
        continue;
      }
      const posted = await monday.postJettaComment(id, text, {
        mentionUserIds: to.map((d) => d.id),
        parentUpdateId: chasingQuestion ? question?.threadUpdateId : undefined,
      });
      if (posted) await rememberJettaPost(posted.id);
      row.done = posted ? `asked (${decision.n})` : "writes off";
      await logOpsEvent({ level: "info", event: "devbridge.followup", source: "cron", ticketId: ticketEvent, data: { itemId: id, ask: decision.n, about, question: chasingQuestion } });
      continue;
    }

    // Escalate once per silence: keyed on when it began, so a fresh round
    // after a developer replies can escalate again, and this one can't twice.
    const key = `devbridge:followup-escalated:${id}:${decision.since}`;
    if (await kvGet(key)) {
      row.done = "already escalated";
      continue;
    }
    if (mode === "shadow") {
      row.done = "shadow";
      await logOpsEvent({ level: "info", event: "devbridge.followup_shadow", source: "cron", ticketId: ticketEvent, data: { itemId: id, escalate: true, about, question: chasingQuestion, quietDays: decision.quietDays } });
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
      summary: chasingQuestion
        ? `Jetta asked ${asked} a question on "${item.name}" (Dev Status: ${item.devStatus ?? "unknown"}) ${decision.quietDays} working days ago and chased it twice. Nobody has answered.`
        : `"${item.name}" (Dev Status: ${item.devStatus ?? "unknown"}) has had no ${about === "developer" ? "developer comment" : "comment"} or status change for ${decision.quietDays} working days. ${asked} ${to.length === 1 ? "was" : "were"} asked on the item at least twice (by Jetta or support), with no answer.${ticketId ? "" : " The item has no Freshdesk link, so the customer's ticket is not known."}`,
      alreadyTried: chasingQuestion ? `Chased the question on the item ${MAX_ASKS} times.` : `Asked on the item ${MAX_ASKS} times.`,
      question: chasingQuestion
        ? "Can someone answer Jetta's question on the item, or tell the customer directly?"
        : about === "developer" ? "Who can pick this up, or what should we tell the customer?" : about === "customer" ? "Has the customer answered, and should this item stay open?" : "Who should own this?",
    });
    await kvSet(key, "1", 60 * 24 * 3600);
    if (chasingQuestion) await clearDevQuestion(id);
    row.done = "escalated";
    await logOpsEvent({ level: "info", event: "devbridge.followup_escalated", source: "cron", ticketId: ticketEvent, data: { itemId: id, about, quietDays: decision.quietDays } });
  }
  return rows;
}
