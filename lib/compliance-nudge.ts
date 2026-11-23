/**
 * Slack messages to the compliance contact about the Security Questionnaires
 * board.
 *
 * Mark Shaw (external compliance) is assigned every request on that board and
 * gets monday's own notification, which he often does not answer. He is not in
 * our Slack workspace, so this sends him a direct message in HIS workspace, as
 * the person whose user token SLACK_COMPLIANCE_USER_TOKEN is:
 *
 *  - a request newly assigned to him and waiting on him: at the next hourly run;
 *  - a request still waiting on him, where he has not written on the item
 *    since: a reminder every REMIND_WORKDAYS working days, MAX_MESSAGES in all.
 *
 * "Waiting on him" is read off the board, whoever filed the item (Jetta or a
 * person): he is in the Person column, the Status is Pending or Stuck (or not
 * set yet on a recent item), and the last update on the item is not his.
 * Client Reviewing and Done are not his to act on.
 *
 * One message per run, listing everything due, so a busy day is one ping.
 * Nothing on a day off. JETTA_COMPLIANCE_NUDGE: off / shadow / on.
 */
import { getMondayUsers } from "./activity-store";
import { config } from "./config";
import { workdaysBetween } from "./dev-followup";
import { logOpsEvent } from "./events";
import { kvGet, kvSet, kvSetNx } from "./kv";
import { listComplianceWaiting, type ComplianceWaiting } from "./tools/monday";
import { complianceDmReady, sendComplianceDm } from "./tools/slack";

/** Working days of silence before a reminder. */
export const REMIND_WORKDAYS = 2;
/** The first message plus five reminders, then it is a person's turn to call him. */
export const MAX_MESSAGES = 6;
/** A request filed this recently is announced as new; older ones as still waiting. */
export const NEW_DAYS = 3;
/** An item whose Status was never set counts as waiting only this long. */
export const BLANK_STATUS_DAYS = 30;
/** Lines in one message; the rest are a count and a link to the board. */
export const MAX_LINES = 10;

const WAITING_STATUS = /^(pending|stuck)$/i;
const DAY_MS = 24 * 3600 * 1000;
const STATE_TTL = 365 * 24 * 3600;

export interface NudgeState {
  /** Messages that have mentioned this item. */
  n: number;
  /** When the last one was sent. */
  at: string;
}

export type ComplianceDecision =
  | { action: "none"; reason: string }
  | { action: "new"; n: 1 }
  | { action: "remind"; n: number };

/** Pure: what, if anything, to say about one item now. */
export function decideComplianceNudge(
  item: Pick<ComplianceWaiting, "status" | "createdAt" | "ownerIds" | "updates">,
  state: NudgeState | null,
  now: Date,
  rules: { ownerId: string; weekend: number[] },
): ComplianceDecision {
  if (!rules.ownerId || !item.ownerIds.includes(rules.ownerId)) return { action: "none", reason: "not assigned to him" };
  const ageDays = (now.getTime() - Date.parse(item.createdAt)) / DAY_MS;
  if (item.status) {
    if (!WAITING_STATUS.test(item.status.trim())) return { action: "none", reason: `status ${item.status}` };
  } else if (!(ageDays <= BLANK_STATUS_DAYS)) {
    return { action: "none", reason: "old item with no status" };
  }
  const last = item.updates[0];
  if (last && last.creatorId === rules.ownerId) return { action: "none", reason: "he wrote last" };
  if (rules.weekend.includes(now.getUTCDay())) return { action: "none", reason: "day off" };

  if (!state) return ageDays <= NEW_DAYS ? { action: "new", n: 1 } : { action: "remind", n: 1 };
  if (state.n >= MAX_MESSAGES) return { action: "none", reason: `told ${state.n} times` };
  // The clock restarts when anyone writes on the item: a reply to him yesterday is not two days of silence.
  const quietSince = last && Date.parse(last.at) > Date.parse(state.at) ? last.at : state.at;
  if (workdaysBetween(quietSince, now, rules.weekend) < REMIND_WORKDAYS) {
    return { action: "none", reason: `quiet less than ${REMIND_WORKDAYS} working days` };
  }
  return { action: "remind", n: state.n + 1 };
}

type Line = Pick<ComplianceWaiting, "title" | "url" | "status" | "createdAt" | "ticketId">;

// Slack's mrkdwn link text cannot hold these.
const clean = (s: string) => s.replace(/[<>|]/g, " ").replace(/\s+/g, " ").trim();
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function line(i: Line, withAge: boolean): string {
  const ticket = i.ticketId ? ` (ticket #${i.ticketId})` : "";
  const age = withAge ? `: ${i.status ?? "no status"}, opened ${day(i.createdAt)}` : "";
  return `• <${i.url}|${clean(i.title)}>${ticket}${age}`;
}

/** Pure: the one message for a run. Written in the first person: it is sent from a person's account. */
export function complianceNudgeText(firstName: string, fresh: Line[], waiting: Line[], boardUrl: string): string {
  const parts: string[] = [];
  let room = MAX_LINES;
  const take = (items: Line[], withAge: boolean) => {
    const shown = items.slice(0, room);
    room -= shown.length;
    return shown.map((i) => line(i, withAge)).join("\n");
  };
  const hi = `Hi ${firstName || "there"},`;
  if (fresh.length) {
    parts.push(`${hi} ${fresh.length === 1 ? "a new compliance request is" : `${fresh.length} new compliance requests are`} on the monday board for you:\n${take(fresh, false)}`);
  }
  if (waiting.length && room > 0) {
    const lead = fresh.length ? "Still waiting on you:" : `${hi} following up on ${waiting.length === 1 ? "this compliance request" : "these compliance requests"}, still waiting on you on the monday board:`;
    parts.push(`${lead}\n${take(waiting, true)}`);
  }
  const hidden = fresh.length + waiting.length - (MAX_LINES - room);
  if (hidden > 0) parts.push(`…and ${hidden} more on <${boardUrl}|the board>.`);
  parts.push("Could you reply on the item, or here? Thanks.\n_Sent automatically from the Security Questionnaires board._");
  return parts.join("\n\n");
}

export interface ComplianceNudgeRow {
  itemId: string;
  title: string;
  decision: ComplianceDecision;
  done?: string;
}

export interface ComplianceNudgeRun {
  rows: ComplianceNudgeRow[];
  /** What was, or in shadow would be, sent. */
  text?: string;
}

const stateKey = (itemId: string) => `compliance-nudge:${itemId}`;

async function readState(itemId: string): Promise<NudgeState | null> {
  const raw = await kvGet(stateKey(itemId)).catch(() => null);
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as NudgeState;
  } catch {
    return null;
  }
}

/**
 * One run. "shadow" decides and logs what it would send (once a day per
 * distinct message); `dry` (the cron's ?dry=1) does the same without logging
 * or saving anything.
 */
export async function runComplianceNudge(now = new Date(), opts: { dry?: boolean } = {}): Promise<ComplianceNudgeRun> {
  const mode = opts.dry ? "shadow" : config.complianceNudge;
  if (mode === "off") return { rows: [] };
  const ownerId = config.monday.compliance.ownerId;
  const rules = { ownerId, weekend: config.devFollowUpRules.weekend };

  const items = await listComplianceWaiting();
  const rows: ComplianceNudgeRow[] = [];
  const fresh: ComplianceWaiting[] = [];
  const waiting: ComplianceWaiting[] = [];
  for (const item of items) {
    const decision = decideComplianceNudge(item, await readState(item.id), now, rules);
    rows.push({ itemId: item.id, title: item.title, decision });
    if (decision.action === "new") fresh.push(item);
    if (decision.action === "remind") waiting.push(item);
  }
  if (!fresh.length && !waiting.length) return { rows };
  // Oldest first among the reminders: the one waiting longest leads.
  waiting.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const users = await getMondayUsers().catch(() => new Map<string, string>());
  const firstName = (users.get(ownerId) ?? "").trim().split(/\s+/)[0] ?? "";
  const boardUrl = `${config.monday.accountUrl}/boards/${config.monday.compliance.boardId}`;
  const text = complianceNudgeText(firstName, fresh, waiting, boardUrl);
  // Only the items the message names are recorded; the rest come up next run.
  const named = new Set([...fresh, ...waiting].slice(0, MAX_LINES).map((i) => i.id));
  const acted = rows.filter((r) => r.decision.action !== "none" && named.has(r.itemId));
  const mark = (done: string) => acted.forEach((r) => (r.done = done));

  if (mode === "shadow") {
    mark("shadow");
    if (!opts.dry) {
      const key = `compliance-nudge:shadow:${now.toISOString().slice(0, 10)}:${acted.map((r) => r.itemId).join(",")}`;
      if (await kvSetNx(key, "1", 2 * 24 * 3600).catch(() => true)) {
        await logOpsEvent({ level: "info", event: "compliance.nudge_shadow", source: "cron", data: { text, items: acted.map((r) => r.itemId) } });
      }
    }
    return { rows, text };
  }

  if (!complianceDmReady()) {
    mark("not connected: SLACK_COMPLIANCE_USER_TOKEN / SLACK_COMPLIANCE_TO");
    return { rows, text };
  }
  try {
    await sendComplianceDm(text);
    for (const r of acted) {
      const n = r.decision.action === "none" ? 0 : r.decision.n;
      await kvSet(stateKey(r.itemId), JSON.stringify({ n, at: now.toISOString() } satisfies NudgeState), STATE_TTL);
      r.done = r.decision.action === "new" ? "told" : `reminded (${n})`;
    }
    await logOpsEvent({ level: "info", event: "compliance.nudge_sent", source: "cron", data: { new: fresh.length, reminders: waiting.length, items: acted.map((r) => r.itemId), text } });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    mark(`failed: ${error.slice(0, 200)}`);
    await logOpsEvent({ level: "error", event: "compliance.nudge_failed", source: "cron", data: { error: error.slice(0, 600) } }).catch(() => {});
  }
  return { rows, text };
}
