/**
 * The daily team report — yesterday as one short Slack message: the team's
 * numbers, a to-do list, and one line per person (Jetta included).
 *
 * It is /activity's scorecard for a single support day, plus the few ticket
 * numbers the scorecard does not carry (first replies, customers owed a reply)
 * and Jetta's own block, read from the stores the hourly syncs already keep:
 *
 *   people   the activity store (lib/activity-store.ts): Freshdesk replies and
 *            notes, chats, Slack, both monday dev boards, console decisions
 *   tickets  the performance store (lib/performance-sync.ts): who sent the
 *            first reply and how fast, who owes whom, Jetta's drafts and handoffs
 *
 * So the report costs no Freshdesk, Slack or monday read of its own, and a
 * number here is the same number the console pages show for that day.
 *
 * People are listed alphabetically, not ranked: the counts say where someone
 * worked, and a day of three hard tickets is not a worse day than thirty easy
 * replies. Someone with nothing recorded is left out rather than listed at
 * zero (leave, a day of calls, work in a place Jetta cannot see).
 *
 * Pure: no storage, no network. app/api/cron/team-report feeds and posts it.
 */
import { buildScorecard, resolvePerson, type Activity, type ActionKind } from "./activity";
import { isClient, type DevRow } from "./dev-board";
import { isJunkSubject, median, suggestionUse, type HandoffKind, type PerfTicket } from "./performance";
import { owesReply, TARGETS } from "./support-health";

const HOUR_MS = 3_600_000;

/** Past this a waiting customer is a to-do for the morning (the same-shift bar on /health). */
export const ACTION_AFTER_H = TARGETS.fastReplyH;
/** Past this the ticket is not "reply today" any more: someone has to decide to answer or close it. */
export const STALE_AFTER_H = 14 * 24;
/** A dev-board handback older than this is no longer news; it is counted, not listed. */
export const DEV_FRESH_H = 14 * 24;
/** A fix that shipped longer ago than this is not chased here. */
export const FIXED_WITHIN_H = 7 * 24;
/** The person key Jetta's Freshdesk login resolves to once it has an alias (AGENT_ALIASES "Jetta=App Support"). */
const JETTA_KEY = "jetta";

/**
 * Something engineering did on a client item that the customer has not heard
 * about yet. "Not heard" is read off the ticket: no public reply from us since.
 *   relay   engineering answered or handed the item back to support
 *   ask     the item is set to Waiting Customer / Need more info
 *   fixed   the item was resolved (deployed, done) and the ticket is still open
 *   board   engineering handed back an item with no ticket Jetta knows of
 */
export interface DevAction {
  kind: "relay" | "ask" | "fixed" | "board";
  itemId: string;
  name: string;
  url: string;
  app: string;
  status: string | null;
  sinceH: number;
  ticketId: number | null;
  /** Support people who have written on the item. */
  support: string[];
  draftReady: boolean;
}

/** A customer who has waited long enough that someone should act today. */
export interface ReplyAction {
  id: number;
  subject: string;
  sinceH: number;
  /** Who on the team answered this ticket last, when the record knows. Not an assignee. */
  lastBy: string | null;
  /** Jetta's newest draft on the ticket has not been followed by a reply yet. */
  draftReady: boolean;
}

export interface PersonReport {
  key: string;
  name: string;
  /** "support" for the people named as the support team (DEV_BOARD_SUPPORT), "other" for everyone else. */
  group: "support" | "other";
  /** Work actions of any kind that day. */
  total: number;
  fd: {
    replies: number;
    notes: number;
    tickets: number;
    /** The tickets replied to or noted on, for the links. */
    ticketIds: number[];
    firstReplies: number;
    firstReplyH: number | null;
  };
  chat: { taken: number; actions: number; pickupMin: number | null };
  slack: { messages: number; responseMin: number | null };
  /**
   * Items filed and comments written. Status changes and moves between groups
   * are not counted: they are clicks, several to an item, and the ones that
   * matter to a customer are already in the action items.
   */
  monday: { created: number; comments: number; items: number };
  /**
   * Console decisions: KB, learnings, billing, settings, drafts sent or discarded
   * there. What a person did with Jetta's drafts in Freshdesk (as-is, edited,
   * replaced) is left out of the per-person report on purpose: it is in Jetta's
   * block as a team total only.
   */
  console: number;
}

export interface TeamReport {
  /** Support day, "2026-11-19". */
  day: string;
  tz: string;
  people: PersonReport[];
  team: {
    newTickets: number;
    answered: number;
    firstReplyH: number | null;
    /** Open tickets where the customer wrote last, at report time. */
    owed: number;
    oldestOwed: { id: number; subject: string; sinceH: number }[];
    /**
     * First replies that day from a Freshdesk login with no person's activity
     * behind it. In practice the shared "App Support" login: Jetta's automatic
     * first responses and drafts approved in the console both go out as it.
     */
    sharedFirstReplies: { login: string; count: number; firstReplyH: number | null }[];
  };
  /**
   * What needs doing today, worked out from the same stores (no model): empty
   * arrays when nothing does, and then the post has no action section at all.
   */
  actions: {
    /** Waiting longer than ACTION_AFTER_H and less than STALE_AFTER_H, longest first. */
    reply: ReplyAction[];
    /** Waiting STALE_AFTER_H or more: answer or close. */
    stale: ReplyAction[];
    /** Developer updates the customer has not been told about, newest first. */
    dev: DevAction[];
    /** Items engineering handed back more than DEV_FRESH_H ago and nobody picked up. */
    devOlder: number;
  };
  jetta: {
    drafts: number;
    /** Replies people sent that day right after one of her drafts. */
    followed: { asIs: number; edited: number; rewritten: number };
    handoffs: Record<HandoffKind, number>;
    /**
     * First replies she sent herself that day (automatic first responses, and
     * drafts approved in the console, which go out under her login). Counted
     * only when her login resolves to "Jetta"; otherwise they stay on the team
     * line under the login's own name.
     */
    firstReplies: number;
    firstReplyH: number | null;
    /** Client items she filed on the dev boards that day. Null when the Dev board rows were not read. */
    devItemsFiled: number | null;
    /**
     * Comments she wrote on dev items that day (updates relayed from a ticket,
     * follow-ups to developers, replies), and on how many items. The post that
     * files an item is counted as the filing, not as a comment.
     */
    devComments: number;
    devCommentItems: number;
    /**
     * Replies she sent to customers herself that day, from her own send
     * events: automatic first responses and follow-ups to quiet customers.
     * A draft a colleague sent is that colleague's reply, not hers.
     */
    replies: { first: number; followups: number; ticketIds: number[] };
  };
}

export interface TeamReportInput {
  day: string;
  tz: string;
  /** Any window that covers `day`; filtered here. */
  acts: Activity[];
  tickets: PerfTicket[];
  aliases: Map<string, string>;
  slackNames?: Record<string, string>;
  /** Report time, for "owed a reply now". */
  now: number;
  /**
   * Support health's own backlog (lib/support-health.ts), when it has been
   * computed. Preferred over the ticket records for "waiting on a reply now":
   * it is built with each ticket's current Freshdesk status, where a record
   * keeps the status from the last time its thread was read, so a ticket
   * closed since then would still look owed.
   */
  backlog?: { owesReply: number; waiting: { ticketId: number; subject: string; waitingH: number }[] } | null;
  /** The dev boards' rows (lib/dev-board-sync.ts), for developer updates to relay. */
  devRows?: DevRow[] | null;
  /** monday item id → Freshdesk ticket id (lib/dev-item-links.ts). */
  itemTickets?: Map<string, string> | null;
  /** Names of the support team (the DEV_BOARD_SUPPORT roster); everyone else is listed in a second group. */
  support?: string[] | null;
  /** Jetta's own comments on dev items (her posts in the Dev board store). Any window; filtered here. */
  jettaComments?: { at: number; itemId: string }[] | null;
  /** Replies Jetta sent herself (first_response.sent / ticket_followup.sent events). Any window; filtered here. */
  jettaSent?: { at: number; ticketId: number; kind: "first" | "followup" }[] | null;
}

/** One formatter per zone: the ticket store is a few thousand records and Intl construction is the slow part. */
function dayKeyer(tz: string): (at: number) => string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (at) => (Number.isFinite(at) ? f.format(new Date(at)) : "");
}

const count = (acts: Activity[], ...kinds: ActionKind[]) => acts.filter((a) => kinds.includes(a.action)).length;
const distinct = (xs: (string | undefined)[]) => new Set(xs.filter(Boolean)).size;

export function buildTeamReport(input: TeamReportInput): TeamReport {
  const { day, tz, aliases, slackNames, now } = input;
  const dayOf = dayKeyer(tz);
  const acts = input.acts.filter((a) => dayOf(a.at) === day);
  const person = (who: string) => resolvePerson(who, aliases, slackNames);

  // Real tickets only: auto-replies and bounces are never work (same rule as /performance).
  const tickets = input.tickets.filter((t) => !isJunkSubject(t.subject ?? ""));

  // First replies sent that day, by whoever sent them.
  const firstBy = new Map<string, number[]>();
  const firstLogin = new Map<string, string>();
  for (const t of tickets) {
    if (!t.firstReplyBy || t.firstReplyH == null) continue;
    if (dayOf(Date.parse(t.createdAt) + t.firstReplyH * HOUR_MS) !== day) continue;
    const k = person(t.firstReplyBy).key;
    firstBy.set(k, [...(firstBy.get(k) ?? []), t.firstReplyH]);
    firstLogin.set(k, t.firstReplyBy);
  }

  const supportKeys = new Set((input.support ?? []).map((name) => person(name).key));
  const mine = new Map<string, Activity[]>();
  for (const a of acts) {
    const k = person(a.who).key;
    mine.set(k, [...(mine.get(k) ?? []), a]);
  }

  const people: PersonReport[] = buildScorecard(acts, { aliases, slackNames, tz })
    .people.filter((p) => p.total > 0)
    .map((p) => {
      const a = mine.get(p.key) ?? [];
      const first = firstBy.get(p.key) ?? [];
      const draftOutcomes = count(a, "fd.draft_used", "fd.draft_edited", "fd.draft_not_used");
      const mondayActs = a.filter((x) => x.place === "monday");
      return {
        key: p.key,
        name: p.name,
        group: supportKeys.has(p.key) ? ("support" as const) : ("other" as const),
        total: p.total,
        fd: {
          replies: p.counts.fdReplies,
          notes: p.counts.fdNotes,
          tickets: distinct(a.filter((x) => x.action === "fd.reply" || x.action === "fd.note").map((x) => x.ticketId)),
          ticketIds: [
            ...new Set(
              a
                .filter((x) => x.action === "fd.reply" || x.action === "fd.note")
                .map((x) => Number(x.ticketId))
                .filter((id) => Number.isFinite(id) && id > 0),
            ),
          ].sort((x, y) => x - y),
          firstReplies: first.length,
          firstReplyH: median(first),
        },
        chat: { taken: p.counts.chats, actions: p.counts.chatActions, pickupMin: p.chatPickupMin },
        slack: { messages: p.counts.slack, responseMin: p.slackResponseMin },
        monday: {
          created: count(a, "monday.created"),
          comments: count(a, "monday.comment"),
          items: distinct(mondayActs.filter((x) => x.action === "monday.created" || x.action === "monday.comment").map((x) => x.ref)),
        },
        console: p.counts.console - draftOutcomes,
      };
    })
    // Someone whose whole day was status changes or moves has nothing to show.
    .filter((p) => p.fd.replies + p.fd.notes + p.fd.firstReplies + p.chat.taken + p.chat.actions + p.slack.messages + p.monday.created + p.monday.comments + p.console > 0)
    .sort((x, y) => x.name.localeCompare(y.name));

  const listed = new Set(people.map((p) => p.key));
  const sharedFirstReplies = [...firstBy.entries()]
    // Jetta's own first replies are in her block, once her login has an alias.
    .filter(([k]) => !listed.has(k) && k !== JETTA_KEY)
    .map(([k, hs]) => ({ login: firstLogin.get(k) ?? k, count: hs.length, firstReplyH: median(hs) }))
    .sort((a, b) => a.login.localeCompare(b.login));

  // The team line.
  // Closed with no reply from anyone is mail nobody needed to answer (booking
  // confirmations, meeting notes, vendor notices). Counting it as "new" made
  // 2026-11-19 read "10 new tickets, 4 answered" when all four real ones were.
  const created = tickets.filter(
    (t) => dayOf(Date.parse(t.createdAt)) === day && !((t.status === 4 || t.status === 5) && t.agentReplies === 0),
  );
  const answered = created.filter((t) => t.agentReplies > 0);
  const fromRecords = tickets
    .filter((t) => t.status !== 4 && t.status !== 5 && owesReply({ ...t, status: t.status ?? null }))
    .map((t) => {
      const since = t.lastPublicFrom === "customer" && t.lastPublicAt ? t.lastPublicAt : t.createdAt;
      return { id: t.id, subject: t.subject ?? "", sinceH: Math.max(0, (now - Date.parse(since)) / HOUR_MS) };
    })
    .filter((t) => Number.isFinite(t.sinceH))
    .sort((a, b) => b.sinceH - a.sinceH);
  const owed = input.backlog
    ? [...input.backlog.waiting]
        .sort((a, b) => b.waitingH - a.waitingH)
        .map((w) => ({ id: w.ticketId, subject: w.subject, sinceH: w.waitingH }))
    : fromRecords;
  const owedCount = input.backlog ? input.backlog.owesReply : fromRecords.length;

  // Action items: every customer who has waited past the same-shift bar.
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const toAction = (o: { id: number; subject: string; sinceH: number }): ReplyAction => {
    const t = byId.get(o.id);
    const lastSuggestion = t?.suggestions[t.suggestions.length - 1];
    const lastReplier = [...(t?.suggestions ?? [])].reverse().find((s) => s.replyBy)?.replyBy ?? t?.firstReplyBy ?? null;
    return {
      ...o,
      lastBy: lastReplier ? person(lastReplier).name : null,
      draftReady: !!lastSuggestion && lastSuggestion.sim == null,
    };
  };
  const overdue = owed.filter((o) => o.sinceH > ACTION_AFTER_H);

  // Developer updates nobody has passed on. The ticket an item belongs to is
  // the remembered link, else a ticket whose handoff notes name the item.
  const ticketOfItem = new Map<string, number>();
  for (const t of tickets) for (const id of t.handoff?.itemIds ?? []) ticketOfItem.set(String(id), t.id);
  for (const [item, ticket] of input.itemTickets ?? []) if (Number(ticket)) ticketOfItem.set(String(item), Number(ticket));
  /** Has anyone on our side written to the customer since `at`? */
  const toldSince = (t: PerfTicket, at: number) =>
    t.lastPublicFrom === "agent" && !!t.lastPublicAt && Date.parse(t.lastPublicAt) > at;
  const dev: DevAction[] = [];
  let devOlder = 0;
  for (const r of (input.devRows ?? []).filter(isClient)) {
    const ticketId = ticketOfItem.get(r.id) ?? null;
    const t = ticketId != null ? byId.get(ticketId) : undefined;
    const ticketOpen = !!t && t.status !== 4 && t.status !== 5;
    let kind: DevAction["kind"] | null = null;
    let since: number | null = null;
    if (r.move === "support" && r.waitingSince != null) {
      since = r.waitingSince;
      // With a ticket: the relay is done once we have written to the customer.
      if (!t) kind = "board";
      else if (ticketOpen && !toldSince(t, since)) kind = "relay";
    } else if (r.move === "customer" && r.waitingSince != null && t && ticketOpen && !toldSince(t, r.waitingSince)) {
      kind = "ask";
      since = r.waitingSince;
    } else if (r.resolvedAt != null && t && ticketOpen && !toldSince(t, r.resolvedAt) && now - r.resolvedAt <= FIXED_WITHIN_H * HOUR_MS) {
      kind = "fixed";
      since = r.resolvedAt;
    }
    if (!kind || since == null) continue;
    const sinceH = Math.max(0, (now - since) / HOUR_MS);
    if (sinceH > DEV_FRESH_H) {
      devOlder++;
      continue;
    }
    const lastSuggestion = t?.suggestions[t.suggestions.length - 1];
    dev.push({
      kind,
      itemId: r.id,
      name: r.name,
      url: r.url,
      app: r.app,
      status: r.status,
      sinceH,
      ticketId,
      support: [...new Set(r.support.map((w) => person(w).name))],
      draftReady: !!lastSuggestion && lastSuggestion.sim == null && Date.parse(lastSuggestion.at) > since,
    });
  }
  dev.sort((a, b) => a.sinceH - b.sinceH);

  const actions: TeamReport["actions"] = {
    reply: overdue.filter((o) => o.sinceH < STALE_AFTER_H).map(toAction),
    stale: overdue.filter((o) => o.sinceH >= STALE_AFTER_H).map(toAction),
    dev,
    devOlder,
  };

  // Jetta's own day, from her notes on the tickets.
  const jetta: TeamReport["jetta"] = {
    drafts: 0,
    followed: { asIs: 0, edited: 0, rewritten: 0 },
    handoffs: { dev_item: 0, slack: 0, chat: 0 },
    firstReplies: firstBy.get(JETTA_KEY)?.length ?? 0,
    firstReplyH: median(firstBy.get(JETTA_KEY) ?? []),
    devItemsFiled: input.devRows ? input.devRows.filter((r) => r.origin === "jetta" && dayOf(r.createdAt) === day).length : null,
    replies: { first: 0, followups: 0, ticketIds: [] },
    devComments: 0,
    devCommentItems: 0,
  };
  const commented = (input.jettaComments ?? []).filter((c) => dayOf(c.at) === day);
  jetta.devComments = commented.length;
  jetta.devCommentItems = new Set(commented.map((c) => c.itemId)).size;
  const sent = (input.jettaSent ?? []).filter((e) => dayOf(e.at) === day);
  jetta.replies = {
    first: sent.filter((e) => e.kind === "first").length,
    followups: sent.filter((e) => e.kind === "followup").length,
    ticketIds: [...new Set(sent.map((e) => e.ticketId).filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b),
  };
  for (const t of tickets) {
    for (const s of t.suggestions) {
      const at = Date.parse(s.at);
      if (dayOf(at) === day) jetta.drafts++;
      if (s.sim == null || s.waitH == null || dayOf(at + s.waitH * HOUR_MS) !== day) continue;
      const use = suggestionUse(s.sim);
      jetta.followed[use === "as_is" ? "asIs" : use === "edited" ? "edited" : "rewritten"]++;
    }
    if (t.handoff && dayOf(Date.parse(t.handoff.at)) === day) for (const k of t.handoff.kinds) jetta.handoffs[k]++;
  }

  return {
    day,
    tz,
    people,
    team: {
      newTickets: created.length,
      answered: answered.length,
      firstReplyH: median(answered.map((t) => t.firstReplyH)),
      owed: owedCount,
      oldestOwed: owed.slice(0, 3),
      sharedFirstReplies,
    },
    actions,
    jetta,
  };
}

/** Nothing a person did and nothing that came in: a weekend or a holiday. Not worth a post. */
export function isEmptyReport(r: TeamReport): boolean {
  const j = r.jetta;
  return r.people.length === 0 && r.team.newTickets === 0 && j.drafts === 0 && j.replies.first + j.replies.followups === 0 && j.devComments === 0;
}

// ── Slack text ──────────────────────────────────────────────────────
//
// Short on purpose: one line per kind of action and one line per person, and
// every ticket or dev item is a link to the thing itself. The detail (subjects,
// who said what) is one click away in Freshdesk, monday or the console.

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** 0.4 → "24 min", 5.25 → "5.3h", 80 → "3.3d", 5587 → "233d". */
export function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  const d = h / 24;
  return d < 10 ? `${Math.round(d * 10) / 10}d` : `${Math.round(d)}d`;
}
const fmtMin = (m: number) => fmtHours(m / 60);

function dayInWords(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** Slack reads <, > and & as markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Marks a ticket that already has Jetta's draft on it. */
const DRAFT = ":memo:";
/** Links written out per line before the rest become "+N". */
const MAX_PER_LINE = 8;
const MAX_PERSON_TICKETS = 6;

/** The two groups of the Team table, in the order they are shown. */
const GROUPS: ["support" | "other", string][] = [
  ["support", "Support"],
  ["other", "Developers and others"],
];

export interface ReportLinks {
  /** Freshdesk ticket link prefix, e.g. "https://x.freshdesk.com/a/tickets/". */
  ticketUrlBase?: string;
  consoleUrl?: string;
}

/** `shown` items joined, then "+N" for the rest. */
function capped(items: string[], max: number): string {
  const rest = items.length - max;
  return `${items.slice(0, max).join(" · ")}${rest > 0 ? ` · +${rest}` : ""}`;
}

function personLine(p: PersonReport, ref: (id: number) => string): string {
  const parts: string[] = [];
  if (p.fd.replies || p.fd.notes || p.fd.firstReplies) {
    const work = [p.fd.replies > 0 && n(p.fd.replies, "reply", "replies"), p.fd.notes > 0 && n(p.fd.notes, "note")].filter(Boolean).join(", ");
    const tickets = p.fd.ticketIds.length ? ` (${capped(p.fd.ticketIds.map(ref), MAX_PERSON_TICKETS).replace(/ · /g, " ")})` : "";
    const first = p.fd.firstReplies > 0 ? `${n(p.fd.firstReplies, "first reply", "first replies")}${p.fd.firstReplyH != null ? ` in ${fmtHours(p.fd.firstReplyH)}` : ""}` : "";
    parts.push([work && `${work}${tickets}`, first].filter(Boolean).join(", "));
  }
  if (p.chat.taken || p.chat.actions) {
    parts.push(
      [
        p.chat.taken > 0 && `${n(p.chat.taken, "chat")} taken${p.chat.pickupMin != null ? ` in ${fmtMin(p.chat.pickupMin)}` : ""}`,
        p.chat.actions > 0 && n(p.chat.actions, "chat action"),
      ]
        .filter(Boolean)
        .join(", "),
    );
  }
  const m = p.monday;
  if (m.created || m.comments) {
    parts.push(
      `dev board: ${[
        m.created > 0 && `${m.created} filed`,
        m.comments > 0 && n(m.comments, "comment"),
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  if (p.slack.messages) parts.push(`Slack: ${p.slack.messages}${p.slack.responseMin != null ? ` (answers in ${fmtMin(p.slack.responseMin)})` : ""}`);
  if (p.console > 0) parts.push(`console: ${p.console}`);
  return parts.join(" · ");
}

/** Jetta's line: the same shape as a person's, from her own records. */
function jettaLine(j: TeamReport["jetta"], ref: (id: number) => string): string {
  const parts: string[] = [];
  const followed = j.followed.asIs + j.followed.edited + j.followed.rewritten;
  const sent = j.replies.first + j.replies.followups;
  if (sent > 0) {
    // Her own sends, linked. The median comes from the ticket records when her login has an alias.
    const kinds = [
      j.replies.first > 0 && `${n(j.replies.first, "first response")}${j.firstReplyH != null ? ` in ${fmtHours(j.firstReplyH)}` : ""}`,
      j.replies.followups > 0 && n(j.replies.followups, "follow-up"),
    ].filter(Boolean);
    const tickets = j.replies.ticketIds.length ? ` (${capped(j.replies.ticketIds.map(ref), MAX_PERSON_TICKETS).replace(/ · /g, " ")})` : "";
    parts.push(`${n(sent, "reply", "replies")} sent${tickets}: ${kinds.join(", ")}`);
  } else if (j.firstReplies > 0) {
    parts.push(`${n(j.firstReplies, "first reply", "first replies")}${j.firstReplyH != null ? ` in ${fmtHours(j.firstReplyH)}` : ""}`);
  }
  if (j.drafts > 0 || followed > 0) {
    parts.push(
      `${n(j.drafts, "draft")}${followed ? ` (of ${followed} sent after one: ${j.followed.asIs} as-is, ${j.followed.edited} edited, ${j.followed.rewritten} replaced)` : ""}`,
    );
  }
  // The board is the better count of items she filed; her ticket notes are the fallback.
  const filed = j.devItemsFiled ?? j.handoffs.dev_item;
  if (filed > 0 || j.devComments > 0) {
    parts.push(`dev board: ${[filed > 0 && `${filed} filed`, j.devComments > 0 && n(j.devComments, "comment")].filter(Boolean).join(", ")}`);
  }
  if (j.handoffs.slack > 0) parts.push(n(j.handoffs.slack, "Slack escalation"));
  if (j.handoffs.chat > 0) parts.push(`${n(j.handoffs.chat, "chat")} → ticket`);
  return parts.join(" · ");
}

export function formatTeamReport(r: TeamReport, links: ReportLinks = {}): string {
  const ref = (id: number) => (links.ticketUrlBase ? `<${links.ticketUrlBase}${id}|#${id}>` : `#${id}`);
  const page = (path: string, label: string) => (links.consoleUrl ? `<${links.consoleUrl}/${path}|${label}>` : label);

  const t = r.team;
  const head = [
    t.newTickets > 0
      ? `${t.newTickets} new, ${t.answered} answered${t.firstReplyH != null ? ` (first reply ${fmtHours(t.firstReplyH)})` : ""}`
      : "no new tickets",
    page("health", `${t.owed} waiting on us`),
    ...t.sharedFirstReplies.map((f) => `${n(f.count, "first reply", "first replies")} from the ${esc(f.login)} login`),
  ];
  const lines: string[] = [`:bar_chart: *Support, ${dayInWords(r.day)}* · ${head.join(" · ")}`];

  // To do: one line per kind, every entry a link. Only when there is something to do.
  const { reply, stale, dev, devOlder } = r.actions;
  const todo: string[] = [];
  const replyRef = (a: ReplyAction) => `${ref(a.id)} ${fmtHours(a.sinceH)}${a.draftReady ? ` ${DRAFT}` : ""}`;
  if (reply.length) todo.push(`• *Reply:* ${capped(reply.map(replyRef), MAX_PER_LINE)}`);
  if (stale.length) todo.push(`• *Reply or close* (${Math.round(STALE_AFTER_H / 24)}d+): ${capped(stale.map(replyRef), MAX_PER_LINE)}`);
  const devRef = (a: DevAction) => {
    const item = a.url ? `<${a.url}|dev item>` : "dev item";
    return `${a.ticketId != null ? `${ref(a.ticketId)} (${item})` : item}${a.draftReady ? ` ${DRAFT}` : ""}`;
  };
  const DEV_LABEL: [DevAction["kind"], string][] = [
    ["relay", "Relay dev update"],
    ["ask", "Dev needs customer info"],
    ["fixed", "Fixed, tell customer"],
    ["board", "Handed back on dev board"],
  ];
  for (const [kind, label] of DEV_LABEL) {
    const of = dev.filter((a) => a.kind === kind);
    if (of.length) todo.push(`• *${label}:* ${capped(of.map(devRef), MAX_PER_LINE)}`);
  }
  if (devOlder > 0) todo.push(`• ${page("dev-board", `${n(devOlder, "dev item")} handed back ${Math.round(DEV_FRESH_H / 24)}d+ ago`)}`);
  if (todo.length) {
    lines.push("", "*To do*", ...todo);
    if ([...reply, ...stale, ...dev].some((a) => a.draftReady)) lines.push(`_${DRAFT} Jetta's draft is on the ticket_`);
  }

  // The team, Jetta included, one line each in alphabetical order.
  const team = [
    ...r.people.map((p) => ({ name: p.name, group: p.group, line: personLine(p, ref) })),
    { name: "Jetta", group: "support" as const, line: jettaLine(r.jetta, ref) },
  ]
    .filter((b) => b.line)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const [group, title] of GROUPS) {
    const of = team.filter((b) => b.group === group);
    if (of.length) lines.push("", `*${title}*`, ...of.map((b) => `• *${esc(b.name)}:* ${b.line}`));
  }

  if (links.consoleUrl) lines.push("", [page("activity", "Team activity"), page("dev-board", "Dev board"), page("health", "Support health")].join(" · "));
  return lines.join("\n");
}

// ── Slack tables ────────────────────────────────────────────────────
//
// The same report as Block Kit `table` blocks: a To do table and a Team table.
// Each table is its own message, because a message carries one table. Slack
// caps a message's table cells at 10,000 characters in total, link URLs
// included, so a table that would pass TABLE_CHAR_BUDGET is not built and the
// caller posts the plain text above instead.

type Inline =
  | { type: "text"; text: string; style?: { bold?: boolean } }
  | { type: "link"; url: string; text: string }
  | { type: "emoji"; name: string };
interface Cell {
  type: "rich_text";
  elements: [{ type: "rich_text_section"; elements: Inline[] }];
}
export interface TableBlock {
  type: "table";
  column_settings: ({ is_wrapped?: boolean; align?: "left" | "center" | "right" } | null)[];
  rows: Cell[][];
}
export interface ReportMessage {
  /** Notification and fallback text for clients that cannot draw blocks. */
  text: string;
  blocks: unknown[];
}

export const TABLE_CHAR_BUDGET = 9_000;

const txt = (text: string, bold = false): Inline => (bold ? { type: "text", text, style: { bold: true } } : { type: "text", text });
/** A cell is never empty: Slack rejects a section with no elements. */
const cell = (...parts: (Inline | string | false | null | undefined)[]): Cell => {
  const elements = parts.filter(Boolean).map((p) => (typeof p === "string" ? txt(p) : (p as Inline)));
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: elements.length ? elements : [txt("–")] }] };
};
/** `items`, each a run of inline elements, separated by `sep` and capped with "+N". */
function joined(items: Inline[][], max: number, sep = "  "): Inline[] {
  const out: Inline[] = [];
  items.slice(0, max).forEach((it, i) => {
    if (i) out.push(txt(sep));
    out.push(...it);
  });
  if (items.length > max) out.push(txt(`${sep}+${items.length - max}`));
  return out;
}
const tableChars = (t: TableBlock) =>
  t.rows.flat().reduce((sum, c) => sum + c.elements[0].elements.reduce((k, e) => k + ("text" in e ? e.text.length : 0) + ("url" in e ? e.url.length : 0) + ("name" in e ? e.name.length : 0), 0), 0);

/**
 * The report as Slack messages with tables: [summary + To do table, Team
 * table]. Null when a table would be over Slack's size limit, so the caller
 * can post the plain text instead.
 */
export function teamReportMessages(r: TeamReport, links: ReportLinks = {}): ReportMessage[] | null {
  const ticket = (id: number): Inline => (links.ticketUrlBase ? { type: "link", url: `${links.ticketUrlBase}${id}`, text: `#${id}` } : txt(`#${id}`));
  const memo: Inline = { type: "emoji", name: "memo" };
  const text = formatTeamReport(r, links);
  const summary = text.split("\n")[0];
  const messages: ReportMessage[] = [];

  // To do: what | tickets.
  const { reply, stale, dev, devOlder } = r.actions;
  const todo: Cell[][] = [];
  const waiting = (a: ReplyAction): Inline[] => [ticket(a.id), txt(` ${fmtHours(a.sinceH)}`), ...(a.draftReady ? [txt(" "), memo] : [])];
  if (reply.length) todo.push([cell(txt("Reply", true)), cell(...joined(reply.map(waiting), MAX_PER_LINE))]);
  if (stale.length) todo.push([cell(txt(`Reply or close (${Math.round(STALE_AFTER_H / 24)}d+)`, true)), cell(...joined(stale.map(waiting), MAX_PER_LINE))]);
  const devItem = (a: DevAction): Inline[] => {
    const item: Inline = a.url ? { type: "link", url: a.url, text: "dev item" } : txt("dev item");
    return [...(a.ticketId != null ? [ticket(a.ticketId), txt(" (")] : []), item, ...(a.ticketId != null ? [txt(")")] : []), ...(a.draftReady ? [txt(" "), memo] : [])];
  };
  const DEV_LABEL: [DevAction["kind"], string][] = [
    ["relay", "Relay dev update"],
    ["ask", "Dev needs customer info"],
    ["fixed", "Fixed, tell customer"],
    ["board", "Handed back on dev board"],
  ];
  for (const [kind, label] of DEV_LABEL) {
    const of = dev.filter((a) => a.kind === kind);
    if (of.length) todo.push([cell(txt(label, true)), cell(...joined(of.map(devItem), MAX_PER_LINE))]);
  }
  if (devOlder > 0) {
    const label = `${n(devOlder, "dev item")} handed back ${Math.round(DEV_FRESH_H / 24)}d+ ago`;
    todo.push([cell(txt("Older on dev board", true)), cell(links.consoleUrl ? { type: "link", url: `${links.consoleUrl}/dev-board`, text: label } : label)]);
  }
  const anyDraft = [...reply, ...stale, ...dev].some((a) => a.draftReady);
  const first: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: summary } }];
  if (todo.length) {
    const table: TableBlock = {
      type: "table",
      column_settings: [{ is_wrapped: true }, { is_wrapped: true }],
      rows: [[cell(txt("To do", true)), cell(txt("Tickets", true))], ...todo],
    };
    if (tableChars(table) > TABLE_CHAR_BUDGET) return null;
    first.push(table);
    if (anyDraft) first.push({ type: "context", elements: [{ type: "mrkdwn", text: `${DRAFT} Jetta's draft is on the ticket` }] });
  }
  messages.push({ text: summary, blocks: first });

  // Team: two groups (support, then everyone else), one row per person in
  // alphabetical order, four columns: Name | Freshdesk | monday dev boards | Other.
  // Every count is a link to the list behind it: Team activity, opened on that
  // person, that kind of action and that day.
  const list = (key: string, what: { action?: ActionKind; column?: string }, label: string): Inline => {
    if (!links.consoleUrl) return txt(label);
    const q = new URLSearchParams({ person: key, ...(what.action ? { action: what.action } : {}), ...(what.column ? { column: what.column } : {}), day: r.day, tz: r.tz });
    return { type: "link", url: `${links.consoleUrl}/activity?${q}`, text: label };
  };
  const page = (path: string, label: string): Inline => (links.consoleUrl ? { type: "link", url: `${links.consoleUrl}/${path}`, text: label } : txt(label));
  /** Parts joined by " · ", skipping the empty ones. */
  const dotted = (parts: (Inline | string | false)[][]): (Inline | string)[] => {
    const out: (Inline | string)[] = [];
    for (const part of parts.map((x) => x.filter(Boolean) as (Inline | string)[]).filter((x) => x.length)) {
      if (out.length) out.push(" · ");
      out.push(...part);
    }
    return out;
  };
  const rows: { name: string; group: "support" | "other"; cells: Cell[] }[] = r.people.map((p) => {
    const m = p.monday;
    const first =
      p.fd.firstReplies > 0
        ? `${n(p.fd.firstReplies, "first reply", "first replies")}${p.fd.firstReplyH != null ? ` (${p.fd.firstReplies > 1 ? "median " : ""}${fmtHours(p.fd.firstReplyH)})` : ""}`
        : "";
    return {
      name: p.name,
      group: p.group,
      cells: [
        cell(txt(p.name, true)),
        cell(
          ...dotted([
            [p.fd.replies > 0 && list(p.key, { action: "fd.reply" }, n(p.fd.replies, "reply", "replies"))],
            [p.fd.notes > 0 && list(p.key, { action: "fd.note" }, n(p.fd.notes, "note"))],
            [first],
          ]),
        ),
        cell(
          ...dotted([
            [m.created > 0 && list(p.key, { action: "monday.created" }, `${n(m.created, "item")} filed`)],
            [m.comments > 0 && list(p.key, { action: "monday.comment" }, n(m.comments, "comment"))],
          ]),
        ),
        cell(
          ...dotted([
            [p.chat.taken > 0 && list(p.key, { action: "chat.joined" }, `${n(p.chat.taken, "chat")} taken`), p.chat.taken > 0 && p.chat.pickupMin != null && ` (in ${fmtMin(p.chat.pickupMin)})`],
            [p.chat.actions > 0 && list(p.key, { column: "chatActions" }, n(p.chat.actions, "chat action"))],
            [p.slack.messages > 0 && list(p.key, { column: "slack" }, n(p.slack.messages, "Slack message"))],
            [p.console > 0 && n(p.console, "console decision")],
          ]),
        ),
      ],
    };
  });
  const j = r.jetta;
  const sent = j.replies.first + j.replies.followups;
  const filed = j.devItemsFiled ?? j.handoffs.dev_item;
  // Jetta is not in the activity store, so her counts link to the tickets
  // themselves and to the console pages that list her work.
  const jettaFd = dotted([
    [
      sent > 0 && `${n(sent, "reply", "replies")} sent`,
      ...(sent > 0 && j.replies.ticketIds.length ? [txt(" ("), ...joined(j.replies.ticketIds.map((id) => [ticket(id)]), MAX_PERSON_TICKETS, " "), txt(")")] : []),
    ],
    [j.drafts > 0 && page("drafts", `${n(j.drafts, "draft")} written`)],
  ]);
  const jettaOther = dotted([[j.handoffs.slack > 0 && n(j.handoffs.slack, "Slack escalation")], [j.handoffs.chat > 0 && `${n(j.handoffs.chat, "chat")} turned into a ticket`]]);
  const jettaBoard = dotted([
    [filed > 0 && page("dev-board", `${n(filed, "item")} filed`)],
    [j.devComments > 0 && page("dev-board", n(j.devComments, "comment"))],
  ]);
  if (sent > 0 || j.drafts > 0 || jettaBoard.length || jettaOther.length) {
    rows.push({
      name: "Jetta",
      // She does support work, so she is listed with the support team.
      group: "support",
      cells: [cell(txt("Jetta", true)), cell(...jettaFd), cell(...jettaBoard), cell(...jettaOther)],
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length) {
    const body: Cell[][] = [];
    for (const [group, title] of GROUPS) {
      const of = rows.filter((x) => x.group === group);
      if (!of.length) continue;
      // A group heading is a row of its own: the title, then blank cells.
      body.push([cell(txt(title.toUpperCase(), true)), cell(" "), cell(" "), cell(" ")]);
      body.push(...of.map((x) => x.cells));
    }
    const table: TableBlock = {
      type: "table",
      column_settings: [null, { is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }],
      rows: [["Name", "Freshdesk", "monday dev boards", "Other"].map((h) => cell(txt(h, true))), ...body],
    };
    if (tableChars(table) > TABLE_CHAR_BUDGET) return null;
    const footer = links.consoleUrl
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: ["activity|Team activity", "dev-board|Dev board", "health|Support health"].map((x) => `<${links.consoleUrl}/${x}>`).join(" · ") }] }]
      : [];
    messages.push({ text: `Team, ${dayInWords(r.day)}`, blocks: [table, ...footer] });
  }
  return messages;
}
