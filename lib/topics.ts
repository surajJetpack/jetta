/**
 * Topic trends — the maths behind the "emerging issues" section of the morning
 * brief (/today).
 *
 * Every ticket carries a short `topic` label written by the light-tier triage
 * call (lib/context.ts). This module does the counting: it buckets labelled
 * outcomes by day, works out what "normal" looks like for each topic, and
 * ranks topics by how far today departs from that baseline.
 *
 * Deliberately pure — no storage, no LLM. The model only ever writes the
 * label; what counts as a spike is arithmetic, so the ranking is stable,
 * explainable to whoever reads the brief, and free to recompute.
 */
import type { OutcomeEvent } from "./kv";

/**
 * Words that describe no particular problem. A label built ENTIRELY out of
 * these is a garbage can, not a topic — and a garbage can is worse than no
 * label, because it looks like a finding.
 *
 * Observed live: labelling 190 historical tickets from subject lines alone
 * produced "general help" for 40% of them ("GetSign Help Needed", "Technical
 * Issue", "Re: Conversation with michael") — subjects that genuinely say
 * nothing. Those count as unlabelled, which the brief reports honestly,
 * instead of topping the trend list with a non-issue.
 *
 * The all-generic test is what makes this hold up as the model rephrases:
 * "help needed", "general help" and "technical issue" all fail it, while
 * "billing question", "purchase inquiry" and "trial extension request" pass
 * on their one meaningful word.
 */
const GENERIC = new Set([
  "general", "generic", "basic", "various", "several", "multiple", "misc", "miscellaneous",
  "other", "unknown", "unclear", "random",
  "help", "helping", "needed", "need", "assistance", "assist", "support", "supporting",
  "inquiry", "enquiry", "query", "question", "issue", "issues", "problem", "problems",
  "request", "requests", "customer", "client", "user", "app", "application", "product",
  "technical", "info", "information", "update", "please", "urgent", "asap", "followup",
]);

const MAX_TOPIC_WORDS = 5;
const MAX_TOPIC_CHARS = 48;

/**
 * Canonical form of a raw model-written label, or null if it carries no
 * signal. Canonical = lowercase, single-spaced, no surrounding punctuation —
 * so "Signing link expired." and "signing  link expired" are one topic rather
 * than two. Display capitalisation is applied at render time.
 */
export function normalizeTopic(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s/&+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ").slice(0, MAX_TOPIC_WORDS);
  if (words.every((w) => GENERIC.has(w))) return null;
  const topic = words.join(" ").slice(0, MAX_TOPIC_CHARS).trim();
  return topic.length >= 3 ? topic : null;
}

/** Sentence-case a canonical topic for display ("signing link" → "Signing link"). */
export function displayTopic(topic: string): string {
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

export interface TopicTicket {
  ticketId: string;
  subject: string;
  at: number; // unix seconds
  product: string;
  /** The specific app ("vlookup", "getsign"…), not the coarse portfolio name. */
  app: string;
  /** Where it came from — decides whether the id is a Freshdesk ticket or a chat. */
  channel: string;
  escalated: boolean;
}

/**
 * One ticket, collapsed from every outcome recorded against it.
 *
 * The collapse is what makes the counts trustworthy. A single ticket produces
 * several outcomes — held draft at webhook time, another when a human approves
 * the reply, more if the customer comes back — and the approval can land days
 * after the ticket arrived. Counting raw events would therefore report a
 * fortnight-old ticket as arriving today the moment someone works the backlog,
 * which is exactly what the live feed does (measured: 71 "arrivals" in 24h
 * against 19 real ones). So a ticket is counted once, at `at` = when it was
 * FIRST seen.
 */
export interface TicketRecord {
  ticketId: string;
  /**
   * The ticket's MOST RECENT non-empty topic. `getOutcomes` returns newest
   * first, so the first run processed is the latest one and `??=` keeps it.
   *
   * This matters on long threads: ticket 13900 arrived as "vlookup autolink
   * admin access" and is now "vlookup status reverting duplicates" twelve days
   * later. Labelling it with the original would describe an issue that is
   * already closed. Roughly 4% of multi-run tickets drift like this.
   */
  topic: string | null;
  subject: string;
  product: string;
  /** The specific app ("vlookup", "getsign"…), not the coarse portfolio name. */
  app: string;
  /**
   * Origin channel. Chat conversations carry a UUID rather than a Freshdesk
   * ticket number, so anything building a link has to branch on this — a
   * conversation id pasted into a /a/tickets/ URL is a dead link.
   */
  channel: string;
  /** Unix seconds the ticket first appeared in the feed — its arrival. */
  at: number;
  /** Unix seconds of the most recent activity on it. */
  lastAt: number;
  /**
   * How many times Jetta ran on this ticket. A proxy for how much back-and-forth
   * it has taken: one run is a fresh ask, nine is a thread that has been going
   * for days and may no longer be about what its subject says.
   */
  runs: number;
  /** A customer-visible reply went out at some point. */
  replied: boolean;
  /** It was escalated at some point, and when. */
  escalated: boolean;
  escalatedAt: number | null;
  /** The customer came back after a resolution, and when. */
  reopened: boolean;
  reopenedAt: number | null;
}

/** Collapse an outcome feed into one record per ticket. */
export function ticketRecords(outcomes: OutcomeEvent[]): TicketRecord[] {
  const byId = new Map<string, TicketRecord>();
  for (const o of outcomes) {
    const topic = normalizeTopic(o.topic);
    const existing = byId.get(o.ticketId);
    if (!existing) {
      byId.set(o.ticketId, {
        ticketId: o.ticketId,
        topic,
        subject: o.subject ?? "(no subject)",
        product: o.product,
        app: o.app || "unknown",
        channel: o.channel,
        at: o.at,
        lastAt: o.at,
        runs: 1,
        replied: o.replied,
        escalated: o.escalated,
        escalatedAt: o.escalated ? o.at : null,
        reopened: o.kind === "reopened",
        reopenedAt: o.kind === "reopened" ? o.at : null,
      });
      continue;
    }
    existing.at = Math.min(existing.at, o.at);
    existing.runs += 1;
    existing.lastAt = Math.max(existing.lastAt, o.at);
    existing.replied ||= o.replied;
    existing.topic ??= topic;
    if (existing.app === "unknown" && o.app) existing.app = o.app;
    if (o.subject && existing.subject === "(no subject)") existing.subject = o.subject;
    if (o.escalated) {
      existing.escalated = true;
      existing.escalatedAt = Math.max(existing.escalatedAt ?? 0, o.at);
    }
    if (o.kind === "reopened") {
      existing.reopened = true;
      existing.reopenedAt = Math.max(existing.reopenedAt ?? 0, o.at);
    }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

export interface TopicTrend {
  topic: string;
  /** Distinct tickets in the recent window. */
  recent: number;
  /**
   * Typical tickets per day for this topic before the window — the MEAN daily
   * rate, not the median.
   *
   * The median is the obvious choice and it is wrong at this volume. Real
   * traffic is ~13 tickets/day across ~40 topics, so nearly every topic scores
   * 0 on most days and its median is 0 — which floored every multiplier to the
   * same value and reported "product purchase" (14% of all tickets, several a
   * week) as a 6× spike. A mean keeps the fractional rate that sparse counts
   * actually have.
   */
  baselinePerDay: number | null;
  /** recent ÷ baseline (floored so a zero baseline can't divide by zero). */
  multiplier: number | null;
  /** Nothing on this topic at all during the baseline window. */
  isNew: boolean;
  /** Clears both the volume and the multiplier bar — worth someone's morning. */
  emerging: boolean;
  /**
   * Which apps the window's tickets belong to, most common first. A spike that
   * is all one app is a different conversation from one spread across the
   * portfolio, and "jetpackapps" alone can't tell them apart.
   */
  apps: { app: string; count: number }[];
  /** Newest-first sample of the tickets behind the count. */
  tickets: TopicTicket[];
}

export interface TopicTrendsOptions {
  nowMs?: number;
  /** Size of the "recent" window. A morning read wants the overnight picture. */
  windowHours?: number;
  /** How far back to look for what normal is. */
  baselineDays?: number;
  /** Below this many tickets, a cluster is noise however big the multiple. */
  minCount?: number;
  /** How far above baseline counts as emerging. */
  minMultiplier?: number;
  /** Sample tickets kept per topic. */
  sampleSize?: number;
}

export interface TopicTrends {
  windowHours: number;
  baselineDays: number;
  /** Days of labelled history the feed actually covers (capped at baselineDays). */
  historyDaysCovered: number;
  /**
   * True when there isn't enough history to know what normal looks like — the
   * UI says so rather than presenting every topic as a spike.
   */
  partialHistory: boolean;
  /** Tickets in the window carrying no usable topic label. */
  unlabelled: number;
  /** Spiking topics, most surprising first. */
  emerging: TopicTrend[];
  /** Highest-volume topics over the baseline window, for steady-state context. */
  top: TopicTrend[];
}

const DAY_S = 86400;

/**
 * Slowest rate we'll assume a topic could plausibly run at, in tickets/day.
 *
 * Only there to stop a zero (or near-zero) baseline producing an infinite or
 * absurd multiple. Its exact value decides where the ranking stops
 * discriminating: every topic below the floor divides by the same number and
 * so reports the same multiple. At 0.5 that flattened MOST topics, because
 * real traffic spreads ~13 tickets/day across ~40 topics — about 0.33/day
 * each. Sitting just under the typical topic rate keeps the sub-daily topics,
 * where the interesting spikes live, telling each other apart.
 */
const MIN_BASELINE_RATE = 0.25;

/** App breakdown of a set of tickets, most common first. */
function countApps(tickets: TopicTicket[]): { app: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const t of tickets) freq.set(t.app, (freq.get(t.app) ?? 0) + 1);
  return [...freq.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);
}

/** Tickets that arrived in [fromS, toS). */
function countIn(tickets: TicketRecord[], fromS: number, toS: number): number {
  let n = 0;
  for (const t of tickets) if (t.at >= fromS && t.at < toS) n++;
  return n;
}

/** Tickets that arrived in [fromS, toS), newest first, as sample rows. */
function ticketsIn(tickets: TicketRecord[], fromS: number, toS: number): TopicTicket[] {
  return tickets
    .filter((t) => t.at >= fromS && t.at < toS)
    .sort((a, b) => b.at - a.at)
    .map((t) => ({
      ticketId: t.ticketId,
      subject: t.subject,
      at: t.at,
      product: t.product,
      app: t.app,
      channel: t.channel,
      escalated: t.escalated,
    }));
}

/**
 * Rank labelled outcomes into emerging + top topics.
 *
 * A topic is "emerging" when it clears a floor of `minCount` distinct tickets
 * in the window AND runs at `minMultiplier`× its usual daily rate. The floor
 * matters more than it looks: without it, one ticket against a baseline of
 * zero reads as an infinite spike, and the brief cries wolf every morning.
 */
export function topicTrends(outcomes: OutcomeEvent[], opts: TopicTrendsOptions = {}): TopicTrends {
  const {
    nowMs = Date.now(),
    windowHours = 24,
    baselineDays = 14,
    minCount = 3,
    minMultiplier = 3,
    sampleSize = 5,
  } = opts;

  const nowS = Math.floor(nowMs / 1000);
  const windowStart = nowS - windowHours * 3600;
  const baselineStart = windowStart - baselineDays * DAY_S;

  // Group by canonical topic, counting how much of the window is unlabelled so
  // the brief can be honest about its own coverage.
  const byTopic = new Map<string, TicketRecord[]>();
  let unlabelled = 0;
  let oldestLabelledAt = Infinity;
  for (const t of ticketRecords(outcomes)) {
    if (t.at < baselineStart) continue;
    if (!t.topic) {
      if (t.at >= windowStart) unlabelled++;
      continue;
    }
    oldestLabelledAt = Math.min(oldestLabelledAt, t.at);
    const list = byTopic.get(t.topic);
    if (list) list.push(t);
    else byTopic.set(t.topic, [t]);
  }

  // How much history do we actually have? Measured over LABELLED tickets: a
  // feed full of unlabelled history is a cold start no matter how far back it
  // reaches, and calling that "14 days of baseline" would present an empty
  // emerging list as "nothing is wrong".
  const historyDaysCovered = Number.isFinite(oldestLabelledAt)
    ? Math.min(baselineDays, Math.max(0, (windowStart - oldestLabelledAt) / DAY_S))
    : 0;
  const partialHistory = historyDaysCovered < 3;

  const trends: TopicTrend[] = [];
  for (const [topic, topicTickets] of byTopic) {
    const tickets = ticketsIn(topicTickets, windowStart, nowS + 1);
    const recent = tickets.length;
    // Divide by the exact span, not by calendar-day buckets: the window starts
    // at whatever time of day the page was opened, so bucketing spreads 14 days
    // across 15 partial buckets and quietly understates every rate.
    const baselineTotal = countIn(topicTickets, baselineStart, windowStart);
    const rate = baselineTotal / baselineDays;
    const baselinePerDay = partialHistory ? null : Number(rate.toFixed(2));
    const multiplier =
      baselinePerDay == null
        ? null
        : Number((recent / Math.max(rate, MIN_BASELINE_RATE)).toFixed(1));

    trends.push({
      topic,
      recent,
      baselinePerDay,
      multiplier,
      isNew: baselineTotal === 0,
      // Both bars, always: the count alone would flag a rare topic's second
      // ticket, and the multiple alone would flag a single ticket against a
      // zero baseline.
      emerging: recent >= minCount && (multiplier == null || multiplier >= minMultiplier),
      apps: countApps(tickets),
      tickets: tickets.slice(0, sampleSize),
    });
  }

  // Rank by how far above normal, then by raw volume. Unknown baselines sort
  // on volume alone so a cold start degrades to "the busiest things today".
  const surprise = (t: TopicTrend) => t.multiplier ?? 0;
  const emerging = trends
    .filter((t) => t.emerging)
    .sort((a, b) => surprise(b) - surprise(a) || b.recent - a.recent);

  const top = [...trends]
    .map((t) => ({ t, volume: ticketsIn(byTopic.get(t.topic)!, baselineStart, nowS + 1).length }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 6)
    .map(({ t }) => t);

  return {
    windowHours,
    baselineDays,
    historyDaysCovered: Number(historyDaysCovered.toFixed(1)),
    partialHistory,
    unlabelled,
    emerging,
    top,
  };
}

/** Distinct-ticket count per topic for a single day — persisted in the rollup. */
export function topicCounts(outcomes: OutcomeEvent[]): { topic: string; count: number }[] {
  const byTopic = new Map<string, Set<string>>();
  for (const o of outcomes) {
    const topic = normalizeTopic(o.topic);
    if (!topic) continue;
    let set = byTopic.get(topic);
    if (!set) byTopic.set(topic, (set = new Set()));
    set.add(o.ticketId);
  }
  return [...byTopic.entries()]
    .map(([topic, tickets]) => ({ topic, count: tickets.size }))
    .sort((a, b) => b.count - a.count);
}
