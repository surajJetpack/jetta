/**
 * Support health — is the support operation in good shape? Powers /health,
 * the page written for the business owner rather than for the people running
 * Jetta.
 *
 * /performance asks "how much of this is Jetta's?"; this asks the question a
 * manager asks of any support desk, whoever answers the tickets: how much is
 * coming in, how fast customers hear back, whether answers stick, who is
 * still waiting right now, and which app is generating the pain. Jetta shows
 * up once, as one line in "who carried the load" — not as the subject.
 *
 * Built from the same Freshdesk records as /performance (lib/performance.ts),
 * joined at sync time with each ticket's CURRENT status and app (the Freshdesk
 * list, which is cheap and fresh) and Jetta's topic label. Pure: no storage,
 * no network — lib/performance-sync.ts assembles the inputs.
 *
 * Deliberately absent: anything per agent. This page is read by the person
 * the team reports to; a per-person table there is a ranking, whatever the
 * caption says. The coaching table stays on the admin page.
 *
 * Hours are calendar hours, not business hours: a Friday-evening ticket
 * answered Monday morning counts every hour of the weekend. That is how long
 * the customer waited, and it keeps the number honest across timezones.
 */
import { median, weekStart, type HandoffOutcome, type PerfTicket } from "./performance";

/** One ticket as this page sees it. `status` is the live Freshdesk status. */
export type HealthTicket = PerfTicket & {
  /** App key ("getsign", "vlookup"…) or "unknown" — never the portfolio label. */
  app: string;
  topic: string | null;
  status: number | null;
};

/**
 * What "healthy" means, in one place. Calendar hours. These are opinions, not
 * contracts — change them here and every tone on the page follows.
 */
export const TARGETS = {
  /** A first reply within a working day. */
  firstReplyH: 24,
  /** The tighter bar, shown alongside: same-shift. */
  fastReplyH: 4,
  /** Share of tickets that should get a first reply within `firstReplyH`. */
  firstReplyShare: { good: 0.9, warn: 0.75 },
  /** Median first reply, hours. */
  medianFirstReplyH: { good: 4, warn: 12 },
  /** Share of answered tickets the customer reopened. */
  reopenRate: { good: 0.1, warn: 0.2 },
  /** Customers owed a reply for longer than `firstReplyH`, right now. */
  overdueNow: { good: 0, warn: 3 },
} as const;

export type HealthTone = "good" | "warn" | "bad";

/** Lower is better (hours, rates, counts). */
export function toneBelow(v: number | null, t: { good: number; warn: number }): HealthTone | null {
  if (v == null) return null;
  return v <= t.good ? "good" : v <= t.warn ? "warn" : "bad";
}
/** Higher is better (shares). */
export function toneAbove(v: number | null, t: { good: number; warn: number }): HealthTone | null {
  if (v == null) return null;
  return v >= t.good ? "good" : v >= t.warn ? "warn" : "bad";
}

// ── Freshdesk status → where the ball is ────────────────────────────

/** Resolved and closed. Everything else is still somebody's problem. */
export const isDone = (status: number | null | undefined) => status === 4 || status === 5;

export type BacklogBucket = "owes_reply" | "engineering" | "in_progress" | "customer";

const STATUS_NAMES: Record<number, string> = {
  2: "Open",
  3: "Pending",
  6: "Waiting on customer",
  7: "Working on it",
  8: "Escalated to dev",
  9: "Reopened",
  10: "Hold – account access",
  11: "Validating",
  12: "Customer responded",
  9000: "Assigned to AI agent",
};
export const statusName = (s: number | null) => (s == null ? "Unknown" : (STATUS_NAMES[s] ?? `Status ${s}`));

/**
 * Does the customer owe us nothing, or we them? Read from the thread first —
 * the newest PUBLIC message — because the status is only as good as the last
 * agent who remembered to set it, and 31 of 38 open tickets on 2026-09-28 sat
 * on "waiting on customer", some of them after the customer had written back.
 * Records read before `lastPublicFrom` existed fall back to the status.
 */
export function owesReply(t: Pick<HealthTicket, "lastPublicFrom" | "agentReplies" | "status">): boolean {
  if (t.lastPublicFrom) return t.lastPublicFrom === "customer";
  if (t.agentReplies === 0) return true;
  return t.status === 2 || t.status === 9 || t.status === 12;
}

export function backlogBucket(t: HealthTicket): BacklogBucket {
  if (owesReply(t)) return "owes_reply";
  if (t.status === 8) return "engineering";
  if (t.status === 7 || t.status === 10 || t.status === 11) return "in_progress";
  return "customer";
}

// ── Aggregation ─────────────────────────────────────────────────────

const HOUR_MS = 3.6e6;
const DAY_MS = 86_400_000;
const ratio = (num: number, den: number) => (den ? Number((num / den).toFixed(3)) : null);

/** Nearest-rank percentile. At this volume (~25 tickets a week) interpolation adds false precision. */
export function percentile(values: (number | null)[], p: number): number | null {
  const s = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return Number(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2));
}

/**
 * A ticket that is real work: somebody answered it, or it is still open and
 * waiting for its first answer. What is left — unanswered and closed — is the
 * marketing and vendor mail the team rightly closes without a word.
 */
export const isRealTicket = (t: HealthTicket) => t.agentReplies > 0 || !isDone(t.status);

export interface HealthPeriod {
  /** Real tickets created in the window. */
  tickets: number;
  answered: number;
  firstReplyH: number | null;
  /** The slowest tenth — the customers a median hides. */
  firstReplyP90H: number | null;
  /**
   * Share answered within TARGETS.firstReplyH / fastReplyH. Tickets still
   * unanswered past the bar count as misses, so an ignored ticket can't make
   * the number look better by not having a reply time yet.
   */
  withinTarget: number | null;
  withinFast: number | null;
  resolvedH: number | null;
  reopenRate: number | null;
  /** Customer messages per answered ticket — how much back-and-forth an answer took. */
  customerMsgsPerTicket: number | null;
  /**
   * Share of real tickets sent to engineering (a dev item or escalation). "Sent",
   * not "needed": the handoff judge finds about a fifth of these were knowledge
   * gaps a KB article would have answered.
   */
  engineeringRate: number | null;
}

export function healthPeriod(tickets: HealthTicket[], now: number): HealthPeriod {
  const real = tickets.filter(isRealTicket);
  const answered = real.filter((t) => t.agentReplies > 0);
  const share = (hours: number) => {
    let hit = 0;
    let due = 0;
    for (const t of real) {
      if (t.firstReplyH != null) {
        due++;
        if (t.firstReplyH <= hours) hit++;
      } else if ((now - new Date(t.createdAt).getTime()) / HOUR_MS > hours) {
        due++;
      }
    }
    return ratio(hit, due);
  };
  return {
    tickets: real.length,
    answered: answered.length,
    firstReplyH: median(answered.map((t) => t.firstReplyH)),
    firstReplyP90H: percentile(answered.map((t) => t.firstReplyH), 0.9),
    withinTarget: share(TARGETS.firstReplyH),
    withinFast: share(TARGETS.fastReplyH),
    resolvedH: median(answered.map((t) => t.resolvedH)),
    reopenRate: ratio(answered.filter((t) => t.reopened).length, answered.length),
    customerMsgsPerTicket: answered.length
      ? Number((answered.reduce((n, t) => n + t.customerMsgs, 0) / answered.length).toFixed(2))
      : null,
    engineeringRate: ratio(
      real.filter((t) => t.devWork || t.handoff?.kinds.some((k) => k !== "chat")).length,
      real.length,
    ),
  };
}

export interface BacklogRow {
  ticketId: number;
  subject: string;
  app: string;
  status: string;
  /** Hours the customer has been waiting on us (owes_reply) or the ticket has been open. */
  waitingH: number;
}

export interface Backlog {
  open: number;
  owesReply: number;
  engineering: number;
  inProgress: number;
  customer: number;
  /** Owed a reply for longer than TARGETS.firstReplyH. */
  overdue: number;
  oldestOwedH: number | null;
  /** Customers waiting on us, longest wait first. */
  waiting: BacklogRow[];
}

export function backlog(tickets: HealthTicket[], now: number): Backlog {
  const open = tickets.filter((t) => !isDone(t.status) && t.status != null);
  const b: Backlog = { open: open.length, owesReply: 0, engineering: 0, inProgress: 0, customer: 0, overdue: 0, oldestOwedH: null, waiting: [] };
  for (const t of open) {
    const bucket = backlogBucket(t);
    if (bucket === "owes_reply") {
      b.owesReply++;
      const since = t.lastPublicFrom === "customer" && t.lastPublicAt ? t.lastPublicAt : t.createdAt;
      const waitingH = Number(((now - new Date(since).getTime()) / HOUR_MS).toFixed(1));
      if (waitingH > TARGETS.firstReplyH) b.overdue++;
      b.waiting.push({ ticketId: t.id, subject: t.subject ?? `Ticket #${t.id}`, app: t.app, status: statusName(t.status), waitingH });
    } else if (bucket === "engineering") b.engineering++;
    else if (bucket === "in_progress") b.inProgress++;
    else b.customer++;
  }
  b.waiting.sort((x, y) => y.waitingH - x.waitingH);
  b.oldestOwedH = b.waiting[0]?.waitingH ?? null;
  b.waiting = b.waiting.slice(0, 15);
  return b;
}

export interface HealthWeek {
  week: string;
  tickets: number;
  firstReplyH: number | null;
  withinTarget: number | null;
  resolvedH: number | null;
  reopenRate: number | null;
  /** The current week, still filling. */
  partial: boolean;
}

export interface AppHealth {
  app: string;
  tickets: number;
  previous: number;
  firstReplyH: number | null;
  reopenRate: number | null;
  /** Open right now, and how many of those owe the customer a reply. */
  open: number;
  owesReply: number;
  /** Handoffs in the window judged a real product bug / a missing fact. */
  bugs: number;
  gaps: number;
}

export interface TopicCount {
  topic: string;
  count: number;
  previous: number;
  /** Apps this topic was raised against, most first. */
  apps: string[];
}

export interface SupportHealth {
  computedAt: number;
  /** Last 28 days vs the 28 before, by ticket creation. */
  recent: HealthPeriod;
  previous: HealthPeriod;
  backlog: Backlog;
  weeks: HealthWeek[];
  apps: AppHealth[];
  topics: TopicCount[];
  /** Share of recent real tickets that carry a topic label (Jetta labels what she reads). */
  topicCoverage: number | null;
  /** Live chat, rolling windows. Null until the chat count has run. */
  chat: { recent: ChatWindow; previous: ChatWindow } | null;
  /** Who carried the load, last 28 days — the one place Jetta appears. */
  load: {
    /** Real tickets where Jetta suggested at least one reply. */
    ticketsDrafted: number;
    /** Chats Jetta finished with no ticket and no person. */
    chatsFinishedAlone: number;
  };
}

export interface ChatWindow {
  /** Real conversations — greetings and tests excluded. */
  real: number;
  /** Finished by Jetta alone. */
  alone: number;
}

export function buildHealth(
  tickets: HealthTicket[],
  outcomes: Map<number, HandoffOutcome>,
  chat: SupportHealth["chat"],
  now: number,
): SupportHealth {
  const recentFrom = new Date(now - 28 * DAY_MS).toISOString();
  const previousFrom = new Date(now - 56 * DAY_MS).toISOString();
  const recent = tickets.filter((t) => t.createdAt >= recentFrom);
  const previous = tickets.filter((t) => t.createdAt >= previousFrom && t.createdAt < recentFrom);
  const recentReal = recent.filter(isRealTicket);
  const previousReal = previous.filter(isRealTicket);

  const byWeek = new Map<string, HealthTicket[]>();
  for (const t of tickets) {
    const w = weekStart(t.createdAt);
    const list = byWeek.get(w);
    if (list) list.push(t);
    else byWeek.set(w, [t]);
  }
  const thisWeek = weekStart(new Date(now).toISOString());
  const weeks: HealthWeek[] = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => {
      const p = healthPeriod(list, now);
      return {
        week,
        tickets: p.tickets,
        firstReplyH: p.firstReplyH,
        withinTarget: p.withinTarget,
        resolvedH: p.resolvedH,
        reopenRate: p.reopenRate,
        partial: week === thisWeek,
      };
    });

  // Per app. Handoff verdicts are dated by the handoff, tickets by creation —
  // both inside the same 28 days.
  const open = tickets.filter((t) => !isDone(t.status) && t.status != null);
  const apps = new Map<string, AppHealth>();
  const appRow = (app: string) => {
    let a = apps.get(app);
    if (!a) apps.set(app, (a = { app, tickets: 0, previous: 0, firstReplyH: null, reopenRate: null, open: 0, owesReply: 0, bugs: 0, gaps: 0 }));
    return a;
  };
  const recentByApp = new Map<string, HealthTicket[]>();
  for (const t of recentReal) {
    appRow(t.app).tickets++;
    recentByApp.set(t.app, [...(recentByApp.get(t.app) ?? []), t]);
  }
  for (const t of previousReal) appRow(t.app).previous++;
  for (const t of open) {
    const a = appRow(t.app);
    a.open++;
    if (owesReply(t)) a.owesReply++;
  }
  for (const t of tickets) {
    if (!t.handoff || t.handoff.at < recentFrom) continue;
    const o = outcomes.get(t.id);
    if (o?.category === "real_bug") appRow(t.app).bugs++;
    if (o?.category === "knowledge_gap") appRow(t.app).gaps++;
  }
  for (const [app, list] of recentByApp) {
    const p = healthPeriod(list, now);
    const a = appRow(app);
    a.firstReplyH = p.firstReplyH;
    a.reopenRate = p.reopenRate;
  }

  // Topics: what customers are asking about.
  const topicRows = new Map<string, { count: number; previous: number; apps: Map<string, number> }>();
  for (const [list, key] of [[recentReal, "count"], [previousReal, "previous"]] as const) {
    for (const t of list) {
      if (!t.topic) continue;
      let r = topicRows.get(t.topic);
      if (!r) topicRows.set(t.topic, (r = { count: 0, previous: 0, apps: new Map() }));
      r[key]++;
      if (key === "count" && t.app !== "unknown") r.apps.set(t.app, (r.apps.get(t.app) ?? 0) + 1);
    }
  }
  const topics = [...topicRows.entries()]
    .filter(([, r]) => r.count > 0)
    .map(([topic, r]) => ({
      topic,
      count: r.count,
      previous: r.previous,
      apps: [...r.apps.entries()].sort((a, b) => b[1] - a[1]).map(([app]) => app),
    }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, 10);

  return {
    computedAt: now,
    recent: healthPeriod(recent, now),
    previous: healthPeriod(previous, now),
    backlog: backlog(tickets, now),
    weeks,
    apps: [...apps.values()]
      .filter((a) => a.tickets || a.previous || a.open)
      .sort((a, b) => b.tickets - a.tickets || b.open - a.open || a.app.localeCompare(b.app)),
    topics,
    topicCoverage: ratio(recentReal.filter((t) => t.topic).length, recentReal.length),
    chat,
    load: {
      ticketsDrafted: recentReal.filter((t) => t.suggestions.length > 0).length,
      chatsFinishedAlone: chat?.recent.alone ?? 0,
    },
  };
}
