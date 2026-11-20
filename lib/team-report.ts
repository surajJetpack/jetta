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
import { isJunkSubject, median, suggestionUse, type HandoffKind, type PerfTicket } from "./performance";
import { owesReply } from "./support-health";

const HOUR_MS = 3_600_000;

export interface PersonReport {
  key: string;
  name: string;
  /** Work actions of any kind that day. */
  total: number;
  fd: { replies: number; notes: number; tickets: number; firstReplies: number; firstReplyH: number | null };
  /** What this person did with Jetta's drafts (the reconciler's verdict on each reply). */
  drafts: { asIs: number; edited: number; rewritten: number };
  chat: { taken: number; actions: number; pickupMin: number | null };
  slack: { messages: number; responseMin: number | null };
  monday: { created: number; comments: number; status: number; moved: number; items: number };
  /** Console decisions other than draft outcomes: KB, learnings, billing, settings, drafts sent or discarded. */
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
      const drafts = {
        asIs: count(a, "fd.draft_used"),
        edited: count(a, "fd.draft_edited"),
        rewritten: count(a, "fd.draft_not_used"),
      };
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
        drafts,
        chat: { taken: p.counts.chats, actions: p.counts.chatActions, pickupMin: p.chatPickupMin },
        slack: { messages: p.counts.slack, responseMin: p.slackResponseMin },
        monday: {
          created: count(a, "monday.created"),
          comments: count(a, "monday.comment"),
          status: count(a, "monday.status"),
          moved: count(a, "monday.moved"),
          items: distinct(mondayActs.map((x) => x.ref)),
        },
        console: p.counts.console - drafts.asIs - drafts.edited - drafts.rewritten,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  const listed = new Set(people.map((p) => p.key));
  const sharedFirstReplies = [...firstBy.entries()]
    .filter(([k]) => !listed.has(k))
    .map(([k, hs]) => ({ login: firstLogin.get(k) ?? k, count: hs.length, firstReplyH: median(hs) }))
    .sort((a, b) => a.login.localeCompare(b.login));

  // The team line.
  const created = tickets.filter((t) => dayOf(Date.parse(t.createdAt)) === day);
  const answered = created.filter((t) => t.agentReplies > 0);
  const owed = tickets
    .filter((t) => t.status !== 4 && t.status !== 5 && owesReply({ ...t, status: t.status ?? null }))
    .map((t) => {
      const since = t.lastPublicFrom === "customer" && t.lastPublicAt ? t.lastPublicAt : t.createdAt;
      return { id: t.id, subject: t.subject ?? "", sinceH: Math.max(0, (now - Date.parse(since)) / HOUR_MS) };
    })
    .filter((t) => Number.isFinite(t.sinceH))
    .sort((a, b) => b.sinceH - a.sinceH);

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
      owed: owed.length,
      oldestOwed: owed.slice(0, 3),
      sharedFirstReplies,
    },
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
  if (p.drafts.asIs || p.drafts.edited || p.drafts.rewritten) {
    out.push(
      `• Jetta's drafts: ${parts([
        p.drafts.asIs > 0 && `${p.drafts.asIs} sent as-is`,
        p.drafts.edited > 0 && `${p.drafts.edited} edited`,
        p.drafts.rewritten > 0 && `${p.drafts.rewritten} replaced with their own reply`,
      ])}`,
    );
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
  if (p.console > 0) out.push(`• Console: ${n(p.console, "decision")} (KB, learnings, billing, drafts)`);
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
  for (const o of t.oldestOwed) {
    const ref = links.ticketUrlBase ? `<${links.ticketUrlBase}${o.id}|#${o.id}>` : `#${o.id}`;
    const subject = o.subject.trim() ? ` ${esc(short(o.subject.trim()))}` : "";
    lines.push(`• ${ref}${subject}: waiting ${fmtHours(o.sinceH)}`);
  }

  for (const f of t.sharedFirstReplies) {
    lines.push(
      `• ${n(f.count, "first reply", "first replies")} went out from the shared "${esc(f.login)}" login${
        f.firstReplyH != null ? ` (median ${fmtHours(f.firstReplyH)})` : ""
      }: Jetta's automatic first responses and drafts approved in the console`,
    );
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
