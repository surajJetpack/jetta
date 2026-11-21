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
import { ACTION_LABEL, buildScorecard, resolvePerson, type Activity, type ActionKind } from "./activity";
import { isClient, type DevRow } from "./dev-board";
import { isJunkSubject, median, suggestionUse, type HandoffKind, type PerfTicket } from "./performance";
import { owesReply, TARGETS } from "./support-health";
import { DEV_FRESH_H, fmtHours, JETTA_WHO, listKey, STALE_AFTER_H, type ListId } from "./team-report-shared";

export * from "./team-report-shared";

const HOUR_MS = 3_600_000;

/** Past this a waiting customer is a to-do for the morning (the same-shift bar on /health). */
export const ACTION_AFTER_H = TARGETS.fastReplyH;
/** A fix that shipped longer ago than this is not chased here. */
export const FIXED_WITHIN_H = 7 * 24;
/** The person key Jetta's Freshdesk login resolves to once it has an alias (AGENT_ALIASES "Jetta=App Support"). */
const JETTA_KEY = "jetta";

/** Which list an action belongs on. Actions not here (status changes, moves, console work) have no list. */
const LIST_OF: Partial<Record<ActionKind, "replies" | "notes" | "filed" | "comments" | "chats" | "chatActions" | "slack">> = {
  "fd.reply": "replies",
  "fd.note": "notes",
  "monday.created": "filed",
  "monday.comment": "comments",
  "chat.joined": "chats",
  "chat.message": "chatActions",
  "chat.ticketed": "chatActions",
  "chat.resolved": "chatActions",
  "chat.reopened": "chatActions",
  "chat.handed_back": "chatActions",
  "slack.reply": "slack",
  "slack.message": "slack",
  "slack.command": "slack",
  "slack.asked_jetta": "slack",
};

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
  /** When the developers acted (unix ms): the same moment `sinceH` counts from, as a fixed point. */
  sinceAt: number;
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

/**
 * One thing behind a count: a reply, a comment, a ticket. The console's Daily
 * report page lists these when a count is clicked, and the Slack post's counts
 * link to that list.
 */
export interface ListItem {
  /** Unix ms, when the thing happened. Null when only the day is known. */
  at: number | null;
  title: string;
  /** Freshdesk ticket, when there is one: the page links it. */
  ticketId?: number;
  /** A link to the thing itself when it is not a ticket (a dev item, a chat, a Slack message). */
  url?: string;
  note?: string;
}


export interface TeamReport {
  /** The things behind each count, by `listKey(person key, list id)`. Newest first. */
  lists: Record<string, ListItem[]>;
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
  jettaComments?: { at: number; itemId: string; name?: string; url?: string }[] | null;
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

  const lists: Record<string, ListItem[]> = {};
  const add = (who: string, list: ListId, item: ListItem) => (lists[listKey(who, list)] ??= []).push(item);
  const ticketTitle = (id: number, subject?: string | null) => `#${id}${subject?.trim() ? ` ${subject.trim()}` : ""}`;

  // First replies sent that day, by whoever sent them.
  const firstBy = new Map<string, number[]>();
  const firstLogin = new Map<string, string>();
  for (const t of tickets) {
    if (!t.firstReplyBy || t.firstReplyH == null) continue;
    if (dayOf(Date.parse(t.createdAt) + t.firstReplyH * HOUR_MS) !== day) continue;
    const k = person(t.firstReplyBy).key;
    firstBy.set(k, [...(firstBy.get(k) ?? []), t.firstReplyH]);
    firstLogin.set(k, t.firstReplyBy);
    add(k, "first", {
      at: Date.parse(t.createdAt) + t.firstReplyH * HOUR_MS,
      title: ticketTitle(t.id, t.subject),
      ticketId: t.id,
      note: `first reply ${fmtHours(t.firstReplyH)} after the ticket came in`,
    });
  }

  const supportKeys = new Set((input.support ?? []).map((name) => person(name).key));
  const mine = new Map<string, Activity[]>();
  for (const a of acts) {
    const k = person(a.who).key;
    mine.set(k, [...(mine.get(k) ?? []), a]);
    const list = LIST_OF[a.action];
    if (!list) continue;
    const ticketId = Number(a.ticketId);
    const onTicket = a.place === "freshdesk" && Number.isFinite(ticketId) && ticketId > 0;
    add(k, list, {
      at: a.at,
      title: onTicket ? ticketTitle(ticketId, a.detail) : (a.detail?.trim() || ACTION_LABEL[a.action]),
      ...(onTicket ? { ticketId } : {}),
      ...(!onTicket && a.url ? { url: a.url } : {}),
      // On a list that mixes kinds, say which this one was.
      ...(list === "chatActions" || list === "slack" ? { note: ACTION_LABEL[a.action] } : {}),
    });
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
      sinceAt: since,
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
  for (const c of commented) add(JETTA_WHO, "comments", { at: c.at, title: c.name?.trim() || `Dev item ${c.itemId}`, url: c.url });
  for (const r of (input.devRows ?? []).filter((x) => x.origin === "jetta" && dayOf(x.createdAt) === day)) {
    add(JETTA_WHO, "filed", { at: r.createdAt, title: r.name, url: r.url, note: r.app });
  }
  jetta.devComments = commented.length;
  jetta.devCommentItems = new Set(commented.map((c) => c.itemId)).size;
  const sent = (input.jettaSent ?? []).filter((e) => dayOf(e.at) === day);
  for (const e of sent) {
    add(JETTA_WHO, "sent", {
      at: e.at,
      title: ticketTitle(e.ticketId, byId.get(e.ticketId)?.subject),
      ticketId: e.ticketId,
      note: e.kind === "first" ? "first response" : "follow-up to a quiet customer",
    });
  }
  jetta.replies = {
    first: sent.filter((e) => e.kind === "first").length,
    followups: sent.filter((e) => e.kind === "followup").length,
    ticketIds: [...new Set(sent.map((e) => e.ticketId).filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b),
  };
  for (const t of tickets) {
    for (const s of t.suggestions) {
      const at = Date.parse(s.at);
      if (dayOf(at) === day) {
        jetta.drafts++;
        const use = s.sim == null ? null : suggestionUse(s.sim);
        add(JETTA_WHO, "drafts", {
          at,
          title: ticketTitle(t.id, t.subject),
          ticketId: t.id,
          note: use == null ? "not sent yet" : `${use === "as_is" ? "sent as-is" : use === "edited" ? "sent, edited" : "replaced with their own reply"}${s.replyBy ? ` by ${person(s.replyBy).name}` : ""}`,
        });
      }
      if (s.sim == null || s.waitH == null || dayOf(at + s.waitH * HOUR_MS) !== day) continue;
      const use = suggestionUse(s.sim);
      jetta.followed[use === "as_is" ? "asIs" : use === "edited" ? "edited" : "rewritten"]++;
    }
    if (t.handoff && dayOf(Date.parse(t.handoff.at)) === day) {
      for (const k of t.handoff.kinds) {
        jetta.handoffs[k]++;
        if (k === "dev_item") continue; // items filed are listed from the board
        add(JETTA_WHO, k === "slack" ? "escalations" : "ticketed", { at: Date.parse(t.handoff.at), title: ticketTitle(t.id, t.subject), ticketId: t.id });
      }
    }
  }
  for (const items of Object.values(lists)) items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  return {
    lists,
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

const fmtMin = (m: number) => fmtHours(m / 60);

function dayInWords(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** Slack reads <, > and & as markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MAX_PERSON_TICKETS = 6;

/** The two groups of the Team table, in the order they are shown. */
const GROUPS: ["support" | "other", string][] = [
  ["support", "Support"],
  ["other", "Developers and others"],
];

/** The console page that shows one list of one person's day: what a count in the Slack post opens. */
export function reportListUrl(consoleUrl: string, day: string, who: string, list: ListId): string {
  return `${consoleUrl}/team-report?${new URLSearchParams({ day, who, list })}`;
}

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

/** How many things are on the To do list: customers waiting past the bar, and developer updates to pass on. */
export function todoCount(r: TeamReport): number {
  const a = r.actions;
  return a.reply.length + a.stale.length + a.dev.length + a.devOlder;
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
    // What needs doing is not posted: one link to the To do list on the console's Daily report page.
    ...(todoCount(r) > 0 ? [page(`team-report?day=${r.day}#to-do`, `${todoCount(r)} to do`)] : []),
    ...t.sharedFirstReplies.map((f) => `${n(f.count, "first reply", "first replies")} from the ${esc(f.login)} login`),
  ];
  const lines: string[] = [`:bar_chart: *Support, ${dayInWords(r.day)}* · ${head.join(" · ")}`];

  // No To do section in the post: what needs doing is on the console's Daily
  // report page, which the footer links to. The post is the team's day.

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

  if (links.consoleUrl) lines.push("", [page(`team-report?day=${r.day}`, "Open this report in the console"), page("dev-board", "Dev board"), page("health", "Support health")].join(" · "));
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
const tableChars = (t: TableBlock) =>
  t.rows.flat().reduce((sum, c) => sum + c.elements[0].elements.reduce((k, e) => k + ("text" in e ? e.text.length : 0) + ("url" in e ? e.url.length : 0) + ("name" in e ? e.name.length : 0), 0), 0);

/**
 * The report as Slack messages with tables: [summary + To do table, Team
 * table]. Null when a table would be over Slack's size limit, so the caller
 * can post the plain text instead.
 */
export function teamReportMessages(r: TeamReport, links: ReportLinks = {}): ReportMessage[] | null {
  const text = formatTeamReport(r, links);
  const summary = text.split("\n")[0];
  const messages: ReportMessage[] = [];

  // One message: the summary line, then the Team table. The To do list is not
  // posted; it is on the console's Daily report page.
  const first: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: summary } }];

  // Team: two groups (support, then everyone else), one row per person in
  // alphabetical order, four columns: Name | Freshdesk | monday dev boards | Other.
  // Every count is a link to the list behind it: Team activity, opened on that
  // person, that kind of action and that day.
  const list = (who: string, id: ListId, label: string): Inline =>
    links.consoleUrl ? { type: "link", url: reportListUrl(links.consoleUrl, r.day, who, id), text: label } : txt(label);
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
            [p.fd.replies > 0 && list(p.key, "replies", n(p.fd.replies, "reply", "replies"))],
            [p.fd.notes > 0 && list(p.key, "notes", n(p.fd.notes, "note"))],
            [first && list(p.key, "first", first)],
          ]),
        ),
        cell(
          ...dotted([
            [m.created > 0 && list(p.key, "filed", `${n(m.created, "item")} filed`)],
            [m.comments > 0 && list(p.key, "comments", n(m.comments, "comment"))],
          ]),
        ),
        cell(
          ...dotted([
            [p.chat.taken > 0 && list(p.key, "chats", `${n(p.chat.taken, "chat")} taken`), p.chat.taken > 0 && p.chat.pickupMin != null && ` (in ${fmtMin(p.chat.pickupMin)})`],
            [p.chat.actions > 0 && list(p.key, "chatActions", n(p.chat.actions, "chat action"))],
            [p.slack.messages > 0 && list(p.key, "slack", n(p.slack.messages, "Slack message"))],
            [p.console > 0 && n(p.console, "console decision")],
          ]),
        ),
      ],
    };
  });
  const j = r.jetta;
  const sent = j.replies.first + j.replies.followups;
  const filed = j.devItemsFiled ?? j.handoffs.dev_item;
  // Her counts open the same lists as anyone's, built from her own records.
  const jettaFd = dotted([
    [sent > 0 && list(JETTA_WHO, "sent", `${n(sent, "reply", "replies")} sent`)],
    [j.drafts > 0 && list(JETTA_WHO, "drafts", `${n(j.drafts, "draft")} written`)],
  ]);
  const jettaOther = dotted([
    [j.handoffs.slack > 0 && list(JETTA_WHO, "escalations", n(j.handoffs.slack, "Slack escalation"))],
    [j.handoffs.chat > 0 && list(JETTA_WHO, "ticketed", `${n(j.handoffs.chat, "chat")} turned into a ticket`)],
  ]);
  const jettaBoard = dotted([
    // Without the board rows the filed count comes from her ticket notes, and there is no list to open.
    [filed > 0 && (j.devItemsFiled != null ? list(JETTA_WHO, "filed", `${n(filed, "item")} filed`) : `${n(filed, "item")} filed`)],
    [j.devComments > 0 && list(JETTA_WHO, "comments", n(j.devComments, "comment"))],
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
      ? [{ type: "context", elements: [{ type: "mrkdwn", text: [`team-report?day=${r.day}|Open this report in the console`, "dev-board|Dev board", "health|Support health"].map((x) => `<${links.consoleUrl}/${x}>`).join(" · ") }] }]
      : [];
    messages.push({ text: summary, blocks: [...first, table, ...footer] });
  } else {
    messages.push({ text: summary, blocks: first });
  }
  return messages;
}
