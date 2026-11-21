/**
 * Following up with the SUPPORT side of a dev item, and bringing the product
 * manager in on feature requests. lib/dev-followup.ts chases a quiet DEVELOPER
 * once a day; this covers the other two people an item can be stuck on, and
 * runs every hour (app/api/cron/dev-followup-support), because a developer's
 * answer is ready to pass on the moment it is written.
 *
 *  1. A developer update nobody passed on. The developers answered or handed
 *     the item back, set it to Waiting Customer, or shipped the fix, and the
 *     ticket has had no public reply from us since. That is the daily report's
 *     To do list (lib/team-report.ts builds it, and this reads the same list,
 *     so the nudge and the report never disagree). Jetta asks the support
 *     person on the item at the next hourly run, with no waiting period; a
 *     working day later, once more; then one post in the escalation channel,
 *     and she stops.
 *
 *  2. A feature request a customer is waiting on. Developers cannot decide
 *     those, so the follow-up cron leaves them alone, and nobody was told they
 *     exist. The product manager is @mentioned on the item, once, while the
 *     request is new.
 *
 * Pure decisions first, then the run. Nothing is posted in shadow.
 */
import { config } from "./config";
import { parseAliases, resolvePerson } from "./activity";
import { getMondayUsers } from "./activity-store";
import { workdaysBetween } from "./dev-followup";
import { getDevBoardRows, listDevItems } from "./dev-board-sync";
import type { DevItem } from "./dev-board";
import { itemTickets } from "./dev-item-links";
import { logOpsEvent } from "./events";
import { kvGet, kvSet, rememberJettaPost } from "./kv";
import { loadPerfTickets } from "./performance-sync";
import { buildTeamReport, fmtHours, type DevAction } from "./team-report";
import * as freshdesk from "./tools/freshdesk";
import * as monday from "./tools/monday";
import * as slack from "./tools/slack";

/**
 * Working days between one ask and the next. The FIRST ask has no wait: the
 * hourly run that first sees the update asks.
 */
export const SUPPORT_WAIT_WORKDAYS = 1;
/** And at least this long, so an ask late one evening is not repeated just after midnight. */
const SUPPORT_REASK_MS = 20 * 3600_000;
/** Asks before it goes to the escalation channel. */
export const SUPPORT_MAX_ASKS = 2;
/** A feature request older than this is backlog, not news: the product manager is not pinged about it. */
export const PM_FRESH_DAYS = 14;
/** Posts per run, so a first run over a backlog is not a burst on the board. */
const MAX_ACTIONS_PER_RUN = 10;
const STATE_TTL = 60 * 24 * 3600;
const DAY_MS = 86_400_000;

/** What has been asked about one developer update so far. */
export interface NudgeState {
  n: number;
  /** ISO time of the last ask. */
  at: string;
  escalated?: boolean;
}

export type SupportDecision =
  | { action: "none"; reason: string }
  | { action: "ask"; n: number }
  | { action: "escalate" };

/**
 * What to do today about one developer update the customer has not heard. Pure.
 * `board` updates (no ticket known) are not handled here: with no ticket there
 * is no way to tell whether the customer was told, and the unlinked follow-up
 * already asks the Reporter about those.
 */
export function decideSupportNudge(
  a: Pick<DevAction, "kind" | "sinceAt" | "ticketId">,
  state: NudgeState | null,
  now: Date,
  rules: { weekend: number[] },
): SupportDecision {
  if (a.kind === "board" || a.ticketId == null) return { action: "none", reason: "no ticket" };
  // Nobody is at work to read it, and an ask posted on a day off would have
  // its reminder land the same morning the first one is seen.
  if (rules.weekend.includes(now.getUTCDay())) return { action: "none", reason: "day off" };
  // No waiting period before the first ask: the update is ready to pass on now.
  if (!state) return { action: "ask", n: 1 };
  if (state.escalated) return { action: "none", reason: "already escalated" };
  const sinceAsk = workdaysBetween(state.at, now, rules.weekend);
  if (sinceAsk < SUPPORT_WAIT_WORKDAYS || now.getTime() - Date.parse(state.at) < SUPPORT_REASK_MS) {
    return { action: "none", reason: "asked less than a working day ago" };
  }
  return state.n < SUPPORT_MAX_ASKS ? { action: "ask", n: state.n + 1 } : { action: "escalate" };
}

/** The ask, as a colleague would write it on the item. */
export function supportNudgeText(a: Pick<DevAction, "kind" | "sinceH" | "ticketId" | "status" | "draftReady">, n: number): string {
  const ago = fmtHours(a.sinceH);
  const ticket = `ticket #${a.ticketId}`;
  const what =
    a.kind === "ask"
      ? `This was set to "${a.status ?? "Waiting Customer"}" ${ago} ago, and the customer on ${ticket} has not been asked yet. Could you ask them for what the developers need?`
      : a.kind === "fixed"
        ? `This was finished ${ago} ago${a.status ? ` (${a.status})` : ""}, and ${ticket} is still open with no reply to the customer since. Could you let them know?`
        : `The developers answered here ${ago} ago, and the customer on ${ticket} has not been told yet. Could you pass it on?`;
  return `${n > 1 ? "Second reminder. " : ""}${what}${a.draftReady ? " A draft reply from me is on the ticket." : ""}`;
}

export type PmDecision = { action: "none"; reason: string } | { action: "loop" };

/** Should the product manager be brought in on this item today? Pure. */
export function decidePmLoop(
  item: Pick<DevItem, "type" | "group" | "status" | "createdAt" | "reporter">,
  ticket: { id: string; status: string | null } | null,
  already: boolean,
  now: Date,
): PmDecision {
  if (!/feature/i.test(item.type ?? "")) return { action: "none", reason: "not a feature request" };
  if (already) return { action: "none", reason: "already brought in" };
  if (/internal/i.test(item.group ?? "")) return { action: "none", reason: "internal group" };
  if (!monday.devItemInFlight({ group: item.group, status: item.status })) return { action: "none", reason: "item finished" };
  if (now.getTime() - item.createdAt > PM_FRESH_DAYS * DAY_MS) return { action: "none", reason: "older than two weeks" };
  if (ticket) {
    if (ticket.status === null) return { action: "none", reason: "ticket status unknown" };
    if (freshdesk.isTerminalStatus(ticket.status)) return { action: "none", reason: `ticket ${ticket.status}` };
    return { action: "loop" };
  }
  // No ticket: a Reporter means support filed it for a customer.
  return item.reporter ? { action: "loop" } : { action: "none", reason: "no ticket and no Reporter" };
}

export function pmLoopText(pmName: string, ticketId: string | null, reporter: string | null): string {
  const from = ticketId ? ` (ticket #${ticketId})` : reporter ? `, filed by ${reporter}` : "";
  return `Bringing ${pmName} in as product manager: this feature request came from a customer${from}. Is it something we plan to do, and what should support tell the customer in the meantime?`;
}

export interface SupportRow {
  itemId: string;
  ticketId: string | null;
  what: "support" | "pm";
  decision: SupportDecision | PmDecision;
  done?: string;
  /** What was, or in shadow would be, posted. */
  text?: string;
  to?: string[];
}

const nudgeKey = (a: Pick<DevAction, "itemId" | "sinceAt">) => `devbridge:support-nudge:${a.itemId}:${a.sinceAt}`;
const pmKey = (itemId: string) => `devbridge:pm-loop:${itemId}`;

async function readNudge(a: Pick<DevAction, "itemId" | "sinceAt">): Promise<NudgeState | null> {
  const raw = await kvGet(nudgeKey(a)).catch(() => null);
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as NudgeState;
  } catch {
    return null;
  }
}
const saveNudge = (a: Pick<DevAction, "itemId" | "sinceAt">, state: NudgeState) => kvSet(nudgeKey(a), JSON.stringify(state), STATE_TTL);

/** monday user ids whose first name is one of `firstNames`. */
function idsFor(users: Map<string, string>, firstNames: string[]): { id: string; name: string }[] {
  const want = new Set(firstNames.map((n) => n.trim().split(/\s+/)[0]?.toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const [id, name] of users) {
    const first = name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!first || !want.has(first) || seen.has(first)) continue;
    seen.add(first);
    out.push({ id, name });
  }
  return out;
}

/**
 * One run. `mode` "shadow" decides and logs what it would post; `dry` (the
 * cron's ?dry=1) does the same without logging or saving anything.
 */
export async function runSupportFollowUp(now = new Date(), opts: { dry?: boolean } = {}): Promise<SupportRow[]> {
  const mode = opts.dry ? "shadow" : config.devFollowUpSupport;
  if (mode === "off" || (!opts.dry && config.devFollowUp === "off")) return [];
  const write = mode === "on";
  const rules = config.devFollowUpRules;
  const [tickets, devRows, links, items, users] = await Promise.all([
    loadPerfTickets(),
    getDevBoardRows(),
    itemTickets().catch(() => new Map<string, string>()),
    listDevItems().catch(() => [] as DevItem[]),
    getMondayUsers().catch(() => new Map<string, string>()),
  ]);
  const aliases = parseAliases(config.agentAliases);
  const rows: SupportRow[] = [];
  let actions = 0;

  // 1. Developer updates the customer has not heard: the report's own list.
  const report = buildTeamReport({ day: "", tz: "UTC", acts: [], tickets, aliases, now: now.getTime(), devRows, itemTickets: links });
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const a of report.actions.dev) {
    const ticketId = a.ticketId != null ? String(a.ticketId) : null;
    const state = await readNudge(a);
    const decision = decideSupportNudge(a, state, now, rules);
    const row: SupportRow = { itemId: a.itemId, ticketId, what: "support", decision };
    rows.push(row);
    if (decision.action === "none" || actions >= MAX_ACTIONS_PER_RUN || !ticketId) continue;
    try {
      // The stores are up to an hour old. Before saying "the customer has not
      // been told", read the ticket: a public reply from us since ends it.
      const thread = await freshdesk.getTicketThread(ticketId, { limit: 10 });
      const told = thread.messages.some((m) => !m.private && m.direction !== "customer" && Date.parse(m.at) > a.sinceAt);
      if (told || freshdesk.isTerminalStatus(thread.status)) {
        row.done = told ? "customer told since" : `ticket ${thread.status}`;
        continue;
      }
      // Who to ask: the item's Reporter, else the support people who wrote on
      // it, else whoever answered the ticket last.
      const names = [itemById.get(a.itemId)?.reporter, ...a.support].filter((x): x is string => !!x);
      const lastAgent = [...thread.messages].reverse().find((m) => !m.private && m.direction !== "customer")?.author;
      if (!names.length && lastAgent) names.push(resolvePerson(lastAgent, aliases).name);
      const to = idsFor(users, names.map((nm) => resolvePerson(nm, aliases).name));
      row.to = to.map((p) => p.name);
      actions++;

      if (decision.action === "ask") {
        row.text = supportNudgeText(a, decision.n);
        if (!write) {
          row.done = "shadow";
          if (!opts.dry) await logOpsEvent({ level: "info", event: "devbridge.support_shadow", source: "cron", ticketId, data: { itemId: a.itemId, kind: a.kind, ask: decision.n, text: row.text, to: row.to } });
          continue;
        }
        const posted = await monday.postJettaComment(a.itemId, row.text, { mentionUserIds: to.map((p) => p.id) });
        if (posted) {
          await rememberJettaPost(posted.id);
          await saveNudge(a, { n: decision.n, at: now.toISOString() });
        }
        row.done = posted ? `asked (${decision.n})` : "writes off";
        await logOpsEvent({ level: "info", event: "devbridge.support_followup", source: "cron", ticketId, data: { itemId: a.itemId, kind: a.kind, ask: decision.n, to: row.to } });
        continue;
      }

      const asked = row.to.length ? row.to.join(", ") : "support";
      if (!write) {
        row.done = "shadow";
        if (!opts.dry) await logOpsEvent({ level: "info", event: "devbridge.support_shadow", source: "cron", ticketId, data: { itemId: a.itemId, kind: a.kind, escalate: true, to: row.to } });
        continue;
      }
      await slack.sendEscalation({
        ticketId,
        ticketRef: `#${ticketId}`,
        freshdeskTicketUrl: freshdesk.freshdeskTicketUrl(ticketId),
        userAccountUrl: "",
        mondayItemUrl: a.url,
        devBoardId: itemById.get(a.itemId)?.boardId ?? "",
        headline: `Developer update not passed on for ${fmtHours(a.sinceH)} — customer still waiting`,
        summary: `"${a.name}" (Dev Status: ${a.status ?? "unknown"}): ${a.kind === "fixed" ? "the developers finished it" : a.kind === "ask" ? "the developers need more from the customer" : "the developers answered"}, and the ticket has had no reply to the customer since. ${asked} ${row.to.length === 1 ? "was" : "were"} asked on the item ${SUPPORT_MAX_ASKS} times.`,
        alreadyTried: `Asked on the item ${SUPPORT_MAX_ASKS} times.`,
        question: "Who can reply to the customer?",
      });
      await saveNudge(a, { n: state?.n ?? SUPPORT_MAX_ASKS, at: state?.at ?? now.toISOString(), escalated: true });
      row.done = "escalated";
      await logOpsEvent({ level: "info", event: "devbridge.support_escalated", source: "cron", ticketId, data: { itemId: a.itemId, kind: a.kind } });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      row.done = `failed: ${error.slice(0, 200)}`;
      if (!opts.dry) await logOpsEvent({ level: "error", event: "devbridge.support_failed", source: "cron", ticketId, data: { itemId: a.itemId, error: error.slice(0, 600) } }).catch(() => {});
    }
  }

  // 2. New feature requests: bring the product manager in, once.
  const pm = idsFor(users, [config.devBoardPm])[0];
  for (const item of items.filter((i) => /feature/i.test(i.type ?? ""))) {
    const ticketId = links.get(item.id) ?? null;
    // Cheap checks first: only a request that passes them costs a ticket read.
    const pre = decidePmLoop(item, ticketId ? { id: ticketId, status: "open" } : null, false, now);
    if (pre.action === "none") continue;
    const already = !!(await kvGet(pmKey(item.id)).catch(() => null)) || item.posts.some((p) => pm && p.who === pm.name);
    const ticket = ticketId ? { id: ticketId, status: await freshdesk.getTicketStatus(ticketId) } : null;
    const decision = decidePmLoop(item, ticket, already, now);
    const row: SupportRow = { itemId: item.id, ticketId, what: "pm", decision };
    rows.push(row);
    if (decision.action === "none" || actions >= MAX_ACTIONS_PER_RUN) continue;
    if (!pm) {
      row.done = `no monday user named ${config.devBoardPm}`;
      continue;
    }
    try {
      actions++;
      row.text = pmLoopText(pm.name.split(/\s+/)[0], ticketId, item.reporter);
      row.to = [pm.name];
      if (!write) {
        row.done = "shadow";
        if (!opts.dry) await logOpsEvent({ level: "info", event: "devbridge.support_shadow", source: "cron", ticketId: ticketId ?? undefined, data: { itemId: item.id, pm: true, text: row.text, to: row.to } });
        continue;
      }
      const posted = await monday.postJettaComment(item.id, row.text, { mentionUserIds: [pm.id] });
      if (posted) {
        await rememberJettaPost(posted.id);
        await kvSet(pmKey(item.id), "1", 365 * 24 * 3600);
      }
      row.done = posted ? "brought in" : "writes off";
      await logOpsEvent({ level: "info", event: "devbridge.pm_loop", source: "cron", ticketId: ticketId ?? undefined, data: { itemId: item.id, to: pm.name } });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      row.done = `failed: ${error.slice(0, 200)}`;
      if (!opts.dry) await logOpsEvent({ level: "error", event: "devbridge.support_failed", source: "cron", ticketId: ticketId ?? undefined, data: { itemId: item.id, pm: true, error: error.slice(0, 600) } }).catch(() => {});
    }
  }
  return rows;
}
