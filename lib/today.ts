/**
 * The morning brief (/today) — everything the support team needs on the first
 * read of the day: what happened overnight, which issues are spiking, and what
 * is actually waiting on a human.
 *
 * Deliberately narrower than /api/admin/stats: no tokens, no model names, no
 * cost. Those are ops questions and they live on Insights.
 *
 * Scope caveat worth keeping in mind when reading these numbers: this counts
 * tickets JETTA touched, not all Freshdesk traffic. The UI says so.
 *
 * Lives in lib/ rather than in the route because the AI insight
 * (lib/today-insight.ts) narrates this exact payload — one definition of the
 * brief means the narrative can never describe different numbers than the
 * ones on screen.
 */
import { getOutcomes, listReplyDrafts, listMonetApprovals, getDailyRollup } from "./kv";
import { listArticles, countByState, type ArticleState } from "./kb-store";
import { topicTrends, ticketRecords, type TopicTrend, type TicketRecord } from "./topics";
import { yesterdayKey } from "./daily-overview";
import { config } from "./config";

const HOUR_S = 3600;
const WINDOW_HOURS = 24;
/** Escalations stay on the board over a weekend-shaped gap, not just overnight. */
const ESCALATION_LOOKBACK_H = 72;
const REOPEN_LOOKBACK_H = 7 * 24;

/**
 * Where to send a reader who clicks the id.
 *
 * JettaChat conversations are keyed by UUID, not a Freshdesk ticket number, so
 * they get a console link — pasting a UUID into /a/tickets/ produces a dead
 * link, which is how this was caught.
 */
function refFor(id: string, channel: string): { label: string; url: string | null; external: boolean } {
  if (channel === "jettachat") {
    return { label: `chat ${id.slice(0, 8)}`, url: `/chats/${id}`, external: false };
  }
  if (channel === "freshchat") {
    // No per-conversation console page exists, and a Freshchat id is not a
    // ticket number — so label it and link nowhere rather than link wrongly.
    return { label: `chat ${id.slice(0, 8)}`, url: null, external: false };
  }
  return {
    label: `#${id}`,
    url: `https://${config.freshdesk.domain ?? "jetpackwork.freshdesk.com"}/a/tickets/${id}`,
    external: true,
  };
}

const KB_STOPWORDS = new Set(["the", "and", "for", "with", "not", "from", "your", "you", "our"]);

/**
 * Loose stem match: "storage"/"store" and "document"/"documents" are the same
 * word for this purpose. Four characters is enough shared prefix to mean it,
 * and short terms have to match outright.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.slice(0, 4) === b.slice(0, 4) && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5)));
}

/**
 * Does the published KB already cover this topic? Cheap term-overlap check
 * against titles and keywords — the point is only to tell "we have nothing on
 * this" apart from "documented, the agent just isn't finding it", which changes
 * what the reader should do about the spike.
 */
function kbCoverage(topic: string, articles: { title: string; keywords: string[] }[]) {
  const terms = topic.split(" ").filter((t) => t.length > 2 && !KB_STOPWORDS.has(t));
  if (!terms.length) return null;
  // Two matching words minimum on a multi-word topic. One is far too loose: it
  // credited "product purchase" to an article titled "Product".
  const needed = Math.min(2, terms.length);
  let best: { title: string; hits: number } | null = null;
  for (const a of articles) {
    const words = `${a.title} ${a.keywords.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/);
    const hits = terms.filter((t) => words.some((w) => sameWord(t, w))).length;
    if (hits >= needed && (!best || hits > best.hits)) best = { title: a.title, hits };
  }
  return best?.title ?? null;
}

/** Group the week's unresolved tickets by theme, worst-covered first. */
function documentNext(
  tickets: TicketRecord[],
  sinceS: number,
  published: { title: string; keywords: string[] }[],
  ref: typeof refFor,
) {
  const groups = new Map<string, TicketRecord[]>();
  for (const t of tickets) {
    const failedAt = Math.max(t.escalatedAt ?? 0, t.reopenedAt ?? 0);
    if (!failedAt || failedAt < sinceS) continue;
    const key = t.topic ?? "unlabelled";
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.entries()]
    .map(([topic, ts]) => ({
      topic,
      count: ts.length,
      reopened: ts.filter((t) => t.reopened).length,
      kbArticle: topic === "unlabelled" ? null : kbCoverage(topic, published),
      apps: [...new Set(ts.map((t) => t.app).filter((a) => a !== "unknown"))],
      tickets: ts
        .sort((a, b) => b.at - a.at)
        .slice(0, 5)
        .map((t) => ({ ticketId: t.ticketId, subject: t.subject, ...ref(t.ticketId, t.channel) })),
    }))
    // Uncovered themes first, then the ones that recur most: an article on a
    // theme that hit five tickets is worth more than one on a singleton.
    .sort((a, b) => Number(!!a.kbArticle) - Number(!!b.kbArticle) || b.count - a.count)
    .slice(0, 8);
}

export type TodayBrief = Awaited<ReturnType<typeof buildTodayBrief>>;

/** Assemble the whole brief. Read-only; safe to call from any admin route. */
export async function buildTodayBrief() {
  const [outcomes, drafts, monet, kbCounts, published, yesterday] = await Promise.all([
    getOutcomes(1000),
    listReplyDrafts(),
    listMonetApprovals().catch(() => []),
    countByState().catch(
      () => ({ draft: 0, in_review: 0, published: 0, archived: 0 }) as Record<ArticleState, number>,
    ),
    listArticles({ state: "published", limit: 500 }).catch(() => []),
    getDailyRollup(yesterdayKey()).catch(() => null),
  ]);

  const nowS = Math.floor(Date.now() / 1000);
  const windowStart = nowS - WINDOW_HOURS * HOUR_S;

  // ── Overnight summary ────────────────────────────────────────────
  // Counted over tickets, not outcome events, and dated by when each ticket
  // FIRST appeared — see the note on ticketRecords(). Working a backlog of old
  // drafts writes today-stamped outcomes for month-old tickets, so an
  // event-level count reports them as this morning's arrivals.
  const tickets = ticketRecords(outcomes);
  const arrivedTickets = tickets.filter((t) => t.at >= windowStart);
  const answered = arrivedTickets.filter((t) => t.replied).length;
  // Escalations and reopens are events rather than arrivals: an old ticket
  // escalating this morning is this morning's news, so those count by when
  // they happened, not by when the ticket first came in.
  const escalatedIds = new Set(
    tickets.filter((t) => t.escalatedAt != null && t.escalatedAt >= windowStart).map((t) => t.ticketId),
  );
  const reopenedIds = new Set(
    tickets.filter((t) => t.reopenedAt != null && t.reopenedAt >= windowStart).map((t) => t.ticketId),
  );

  // Volume per specific app for the window. The coarse product field buckets
  // nine marketplace apps as "jetpackapps", which can't answer "which app is
  // having a bad morning" — the only version of this question worth asking.
  const appCounts = new Map<string, number>();
  for (const t of arrivedTickets) appCounts.set(t.app, (appCounts.get(t.app) ?? 0) + 1);
  const byApp = [...appCounts.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);

  const pendingDrafts = drafts
    .filter((d) => d.state === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);

  // The whole open queue, not a 24h slice — a draft that has been sitting for
  // three days is more of this morning's problem, not less. Union rather than
  // sum: a ticket can be both escalated and awaiting draft review.
  const waiting = new Set<string>([
    ...tickets.filter((t) => t.escalatedAt != null && t.escalatedAt >= nowS - ESCALATION_LOOKBACK_H * HOUR_S).map((t) => t.ticketId),
    ...pendingDrafts.map((d) => d.ticketId),
  ]);

  // ── Emerging issues ──────────────────────────────────────────────
  const trends = topicTrends(outcomes, { nowMs: Date.now(), windowHours: WINDOW_HOURS });
  const withCoverage = (t: TopicTrend) => ({
    ...t,
    kbArticle: kbCoverage(t.topic, published),
    tickets: t.tickets.map((tk) => ({ ...tk, ...refFor(tk.ticketId, tk.channel) })),
  });

  // ── The queue ────────────────────────────────────────────────────
  const queueRow = (t: (typeof tickets)[number], at: number) => ({
    ticketId: t.ticketId,
    subject: t.subject,
    topic: t.topic,
    product: t.product,
    at,
    ...refFor(t.ticketId, t.channel),
  });

  const escalations = tickets
    .filter((t) => t.escalatedAt != null && t.escalatedAt >= nowS - ESCALATION_LOOKBACK_H * HOUR_S)
    .sort((a, b) => b.escalatedAt! - a.escalatedAt!)
    .map((t) => queueRow(t, t.escalatedAt!));

  const reopened = tickets
    .filter((t) => t.reopenedAt != null && t.reopenedAt >= nowS - REOPEN_LOOKBACK_H * HOUR_S)
    .sort((a, b) => b.reopenedAt! - a.reopenedAt!)
    .map((t) => queueRow(t, t.reopenedAt!));

  return {
    generatedAt: Date.now(),
    windowHours: WINDOW_HOURS,
    summary: {
      arrived: arrivedTickets.length,
      answered,
      escalated: escalatedIds.size,
      reopened: reopenedIds.size,
      /** Current open queue — not a 24h figure; the UI heads the queue card with it. */
      waiting: waiting.size,
    },
    byApp,
    /** Yesterday's narrative from the daily rollup — written by the 06:10 cron. */
    narrative: yesterday?.insight ?? null,
    narrativeDate: yesterday?.date ?? null,
    trends: {
      partialHistory: trends.partialHistory,
      historyDaysCovered: trends.historyDaysCovered,
      baselineDays: trends.baselineDays,
      unlabelled: trends.unlabelled,
      emerging: trends.emerging.map(withCoverage),
      top: trends.top.map(withCoverage),
    },
    queue: {
      drafts: {
        count: pendingDrafts.length,
        oldestAgeHours: pendingDrafts.length
          ? Number(((nowS - pendingDrafts[0].createdAt) / HOUR_S).toFixed(1))
          : null,
        items: pendingDrafts.slice(0, 8).map((d) => ({
          id: d.id,
          ticketId: d.ticketId,
          subject: d.subject ?? "(no subject)",
          topic: d.topic ?? null,
          product: d.product,
          createdAt: d.createdAt,
          ageHours: Number(((nowS - d.createdAt) / HOUR_S).toFixed(1)),
          ...refFor(d.ticketId, d.channel),
        })),
      },
      escalations: { count: escalations.length, items: escalations.slice(0, 8) },
      reopened: { count: reopened.length, items: reopened.slice(0, 8) },
      // /kb/review works the "draft" queue; in_review is the same human step
      // one stage on, so the morning count covers both.
      kbReview: (kbCounts.draft ?? 0) + (kbCounts.in_review ?? 0),
      billingApprovals: monet.length,
    },
    // The documentation backlog, grouped by THEME rather than listed by ticket.
    //
    // Per-ticket it was a verbatim copy of the escalations list above — gaps
    // are escalations, so the page repeated itself for a full screen. What a
    // writer actually needs is which theme keeps coming back and whether the
    // KB already answers it; one article closes the whole group.
    documentNext: documentNext(tickets, nowS - REOPEN_LOOKBACK_H * HOUR_S, published, refFor),
  };
}
