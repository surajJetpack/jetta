/**
 * The daily team report — yesterday, per person, as one Slack message.
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
/** Reply items written out one per line; the rest are linked on one line. */
const MAX_REPLY_LINES = 6;
const MAX_LINKS = 8;
/** A dev-board handback older than this is no longer news; it is counted, not listed. */
export const DEV_FRESH_H = 14 * 24;
/** A fix that shipped longer ago than this is not chased here. */
export const FIXED_WITHIN_H = 7 * 24;
const MAX_DEV_LINES = 6;

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
  /** Work actions of any kind that day. */
  total: number;
  fd: { replies: number; notes: number; tickets: number; firstReplies: number; firstReplyH: number | null };
  chat: { taken: number; actions: number; pickupMin: number | null };
  slack: { messages: number; responseMin: number | null };
  monday: { created: number; comments: number; status: number; moved: number; items: number };
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
        total: p.total,
        fd: {
          replies: p.counts.fdReplies,
          notes: p.counts.fdNotes,
          tickets: distinct(a.filter((x) => x.action === "fd.reply" || x.action === "fd.note").map((x) => x.ticketId)),
          firstReplies: first.length,
          firstReplyH: median(first),
        },
        chat: { taken: p.counts.chats, actions: p.counts.chatActions, pickupMin: p.chatPickupMin },
        slack: { messages: p.counts.slack, responseMin: p.slackResponseMin },
        monday: {
          created: count(a, "monday.created"),
          comments: count(a, "monday.comment"),
          status: count(a, "monday.status"),
          moved: count(a, "monday.moved"),
          items: distinct(mondayActs.map((x) => x.ref)),
        },
        console: p.counts.console - draftOutcomes,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  const listed = new Set(people.map((p) => p.key));
  const sharedFirstReplies = [...firstBy.entries()]
    .filter(([k]) => !listed.has(k))
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
  return r.people.length === 0 && r.team.newTickets === 0 && r.jetta.drafts === 0;
}

// ── Slack text ──────────────────────────────────────────────────────

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

/** Slack reads <, > and & as markup; a ticket subject is customer text. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function personLines(p: PersonReport): string[] {
  const out: string[] = [];
  const parts = (xs: (string | false)[]) => xs.filter(Boolean).join(", ");

  if (p.fd.replies || p.fd.notes || p.fd.firstReplies) {
    const work = parts([p.fd.replies > 0 && n(p.fd.replies, "reply", "replies"), p.fd.notes > 0 && n(p.fd.notes, "note")]);
    const first =
      p.fd.firstReplies > 0
        ? `${n(p.fd.firstReplies, "first reply", "first replies")}${p.fd.firstReplyH != null ? ` (median ${fmtHours(p.fd.firstReplyH)} after the ticket came in)` : ""}`
        : "";
    out.push(`• Freshdesk: ${[work && `${work} on ${n(p.fd.tickets, "ticket")}`, first].filter(Boolean).join(" · ")}`);
  }
  if (p.chat.taken || p.chat.actions) {
    out.push(
      `• Chats: ${parts([
        p.chat.taken > 0 && `${p.chat.taken} taken over${p.chat.pickupMin != null ? ` (picked up in ${fmtMin(p.chat.pickupMin)})` : ""}`,
        p.chat.actions > 0 && n(p.chat.actions, "message or action", "messages and actions"),
      ])}`,
    );
  }
  const m = p.monday;
  if (m.created || m.comments || m.status || m.moved) {
    out.push(
      `• monday dev boards: ${parts([
        m.created > 0 && `${n(m.created, "item")} created`,
        m.comments > 0 && n(m.comments, "comment"),
        m.status > 0 && n(m.status, "status change"),
        m.moved > 0 && n(m.moved, "move"),
      ])}${m.items > 0 ? ` across ${n(m.items, "item")}` : ""}`,
    );
  }
  if (p.slack.messages) {
    out.push(
      `• Slack: ${n(p.slack.messages, "message")}${p.slack.responseMin != null ? ` (answers Jetta's posts in ${fmtMin(p.slack.responseMin)})` : ""}`,
    );
  }
  if (p.console > 0) out.push(`• Console: ${n(p.console, "decision")} (KB, learnings, billing, review queue)`);
  return out;
}

export function formatTeamReport(r: TeamReport, links: { ticketUrlBase?: string; consoleUrl?: string } = {}): string {
  const lines: string[] = [`:bar_chart: *Support team, ${dayInWords(r.day)}* _(${r.tz} day)_`];

  const t = r.team;
  const team = [
    t.newTickets > 0
      ? `${n(t.newTickets, "new ticket")}, ${t.answered} answered${t.firstReplyH != null ? ` (median first reply ${fmtHours(t.firstReplyH)})` : ""}`
      : "No new tickets",
    t.owed > 0 ? `${n(t.owed, "customer")} waiting on a reply right now` : "nobody is waiting on a reply right now",
  ];
  lines.push(`*Team:* ${team.join(" · ")}`);
  const ref = (id: number) => (links.ticketUrlBase ? `<${links.ticketUrlBase}${id}|#${id}>` : `#${id}`);

  for (const f of t.sharedFirstReplies) {
    lines.push(
      `• ${n(f.count, "first reply", "first replies")} went out from the shared "${esc(f.login)}" login${
        f.firstReplyH != null ? ` (median ${fmtHours(f.firstReplyH)})` : ""
      }: Jetta's automatic first responses and drafts approved in the console`,
    );
  }

  // Action items: only when there is something to do.
  const { reply, stale, dev, devOlder } = r.actions;
  if (reply.length || stale.length || dev.length || devOlder) {
    lines.push("", "*Action items*");
    for (const a of reply.slice(0, MAX_REPLY_LINES)) {
      const subject = a.subject.trim() ? ` ${esc(short(a.subject.trim()))}` : "";
      const notes = [a.lastBy && `last answered by ${esc(a.lastBy)}`, a.draftReady && "Jetta's draft is on the ticket"].filter(Boolean);
      lines.push(`• Reply to ${ref(a.id)}${subject}: customer has waited ${fmtHours(a.sinceH)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    }
    const rest = reply.slice(MAX_REPLY_LINES);
    if (rest.length) {
      lines.push(
        `• ${n(rest.length, "more customer")} waiting over ${fmtHours(ACTION_AFTER_H)}: ${rest.slice(0, MAX_LINKS).map((a) => ref(a.id)).join(", ")}${
          rest.length > MAX_LINKS ? ` and ${rest.length - MAX_LINKS} more` : ""
        }`,
      );
    }
    if (stale.length) {
      lines.push(
        `• Reply or close: ${n(stale.length, "ticket has", "tickets have")} had the customer waiting for over ${Math.round(STALE_AFTER_H / 24)} days: ${stale
          .slice(0, MAX_LINKS)
          .map((a) => `${ref(a.id)} ${fmtHours(a.sinceH)}`)
          .join(", ")}${stale.length > MAX_LINKS ? ` and ${stale.length - MAX_LINKS} more` : ""}`,
      );
    }
    const DEV_LEAD: Record<DevAction["kind"], (a: DevAction) => string> = {
      relay: (a) => `Relay the developers' update to the customer${a.ticketId != null ? ` on ${ref(a.ticketId)}` : ""}`,
      ask: (a) => `Developers need more from the customer${a.ticketId != null ? ` on ${ref(a.ticketId)}` : ""}`,
      fixed: (a) => `Fixed, tell the customer${a.ticketId != null ? ` on ${ref(a.ticketId)}` : ""}`,
      board: () => "Developers handed this back to support",
    };
    const DEV_WHEN: Record<DevAction["kind"], string> = {
      relay: "they answered",
      ask: "asked",
      fixed: "resolved",
      board: "waiting",
    };
    for (const a of dev.slice(0, MAX_DEV_LINES)) {
      const item = a.url ? `<${a.url}|${esc(short(a.name, 50))}>` : esc(short(a.name, 50));
      const notes = [
        `${DEV_WHEN[a.kind]} ${fmtHours(a.sinceH)} ago`,
        a.status && `status ${esc(a.status)}`,
        a.support.length > 0 && `support on it: ${a.support.map(esc).join(", ")}`,
        a.draftReady && "Jetta's draft is on the ticket",
      ].filter(Boolean);
      lines.push(`• ${DEV_LEAD[a.kind](a)}: ${item} (${esc(a.app)}; ${notes.join("; ")})`);
    }
    const devRest = dev.length - MAX_DEV_LINES;
    if (devRest > 0 || devOlder > 0) {
      const more = [devRest > 0 && `${n(devRest, "more developer update")} to pass on`, devOlder > 0 && `${n(devOlder, "item")} handed back over ${Math.round(DEV_FRESH_H / 24)} days ago`]
        .filter(Boolean)
        .join(", and ");
      lines.push(`• ${more}${links.consoleUrl ? `: <${links.consoleUrl}/dev-board|open Dev board>` : ""}`);
    }
  }

  for (const p of r.people) {
    const body = personLines(p);
    if (!body.length) continue;
    lines.push("", `*${esc(p.name)}*`, ...body);
  }
  if (!r.people.length) lines.push("", "_Nothing recorded for anyone on the team that day._");

  const j = r.jetta;
  const followed = j.followed.asIs + j.followed.edited + j.followed.rewritten;
  const handoffs = [
    j.handoffs.dev_item > 0 && n(j.handoffs.dev_item, "dev item"),
    j.handoffs.slack > 0 && n(j.handoffs.slack, "Slack escalation"),
    j.handoffs.chat > 0 && n(j.handoffs.chat, "chat", "chats") + " turned into a ticket",
  ].filter(Boolean);
  if (j.drafts || followed || handoffs.length) {
    lines.push("", "*Jetta*");
    if (j.drafts || followed) {
      lines.push(
        `• ${n(j.drafts, "draft")} written${
          followed
            ? ` · of ${n(followed, "reply", "replies")} sent after a draft: ${j.followed.asIs} as-is, ${j.followed.edited} edited, ${j.followed.rewritten} replaced`
            : ""
        }`,
      );
    }
    if (handoffs.length) lines.push(`• Handed to people: ${handoffs.join(", ")}`);
  }

  lines.push(
    "",
    `_Counts are what Jetta recorded in Freshdesk, chats, Slack, the monday dev boards and the console. Calls, meetings and work elsewhere are not in here._${
      links.consoleUrl ? ` <${links.consoleUrl}/activity|Open Team activity>` : ""
    }`,
  );
  return lines.join("\n");
}
