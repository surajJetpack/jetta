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
import { getOutcomes, listMonetApprovals, getDailyRollup } from "./kv";
import { freshdeskTicketUrl } from "./tools/freshdesk";
import { listLearnings } from "./evals";
import { listArticles, countByState, type ArticleState } from "./kb-store";
import { topicTrends, ticketRecords, type TopicTrend, type TicketRecord } from "./topics";
import { yesterdayKey } from "./daily-overview";
import { listConversations, getConversation } from "./chat-store";
import { getTicketDetails, isTerminalStatus } from "./tools/freshdesk";
import {
  activeReleaseWatches,
  listReleaseMentions,
  RELEASE_MENTION_KINDS,
  type ReleaseMentionKind,
} from "./release-watch";

const HOUR_S = 3600;
const WINDOW_HOURS = 24;
/** Escalations stay on the board over a weekend-shaped gap, not just overnight. */
const ESCALATION_LOOKBACK_H = 72;
const REOPEN_LOOKBACK_H = 7 * 24;

/**
 * Why something is on the worklist. A ticket can carry more than one — a
 * reopened ticket that was then escalated is a different (worse) thing than
 * either alone, and collapsing it to one label throws that away.
 */
export type WorklistSignal = "chat_waiting" | "reopened" | "escalated";

/**
 * Two ways a ticket needs a person, and they are opposite problems.
 *
 * `active`  — the customer has said something recently. Someone should answer.
 * `stalled` — it was escalated or reopened and nothing has happened since.
 *             Nobody has picked it up.
 *
 * Ranking by the escalation timestamp alone conflates them: a conversation
 * escalated 36h ago whose customer replied a minute ago is the single most
 * urgent thing on the page, and sorting by "escalated 36h ago" buries it below
 * genuinely abandoned tickets.
 */
export type WorklistState = "active" | "stalled";

/** Below this, the last message is recent enough that someone is mid-conversation. */
const ACTIVE_WITHIN_H = 6;

/**
 * Live Freshdesk status per ticket, cached briefly.
 *
 * The worklist is assembled from Jetta's own run history, which records what
 * happened at the time and nothing after it. A human resolving a ticket gives
 * her no reason to run again, so without this the record still says "reopened"
 * and the ticket sits on the worklist until the lookback expires — 13945 was
 * closed in Freshdesk and top of the list.
 *
 * One GET per candidate, so it is cached: /today and the insight route each
 * build the brief, and a refresh must not mean a second round of calls.
 */
const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; status: string | null }>();

async function liveStatus(ticketId: string): Promise<string | null> {
  const hit = statusCache.get(ticketId);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
  // Fail open: an unreachable Freshdesk should leave the worklist stale, not
  // empty. Showing one resolved ticket is a smaller failure than hiding five
  // live ones because an API call timed out.
  const status = await getTicketDetails(ticketId)
    .then((t) => t.status)
    .catch(() => null);
  statusCache.set(ticketId, { at: Date.now(), status });
  return status;
}

export interface WorklistItem {
  /** What the ranking model refers to this by. Ticket id, or `chat:<uuid>`. */
  id: string;
  signals: WorklistSignal[];
  /** Display label — "#13891" or the visitor's name. */
  label: string;
  url: string | null;
  external: boolean;
  subject: string;
  topic: string | null;
  app: string;
  /** Unix seconds of the event that put it here — not when the ticket arrived. */
  at: number;
  /** Hours since the event, rounded. */
  ageHours: number;
  state: WorklistState;
  /** Hours since anyone last said anything. The number that decides urgency. */
  quietHours: number;
  /** How many times Jetta has run on it — a proxy for how long the thread is. */
  runs: number;
  /**
   * The ticket's status in Freshdesk right now, not when Jetta last saw it.
   * Null for chat conversations and when the lookup failed.
   */
  status: string | null;
}

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
    url: freshdeskTicketUrl(id),
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
  const [outcomes, candidateLearnings, monet, kbCounts, published, yesterday, conversations, releaseMentions] =
    await Promise.all([
      getOutcomes(1000),
      // Reply drafts are deliberately absent. The console review queue is not the
      // workflow: agents read Jetta's suggestion as a Freshdesk private note and
      // send in their own words, and the learning comes from mining what they
      // actually wrote (/evals → "Learn from human replies"). Counting drafts here
      // put work on the board that nobody was ever going to do — 83 of 95 turned
      // out to be unreviewable. What DOES need a human is a candidate learning:
      // nothing changes Jetta's behaviour until someone approves one.
      listLearnings("candidate").catch(() => []),
      listMonetApprovals().catch(() => []),
      countByState().catch(
        () => ({ draft: 0, in_review: 0, published: 0, archived: 0 }) as Record<ArticleState, number>,
      ),
      listArticles({ state: "published", limit: 500 }).catch(() => []),
      getDailyRollup(yesterdayKey()).catch(() => null),
      // Someone sitting in a live chat is the most time-critical thing here, and
      // the only worklist input that isn't a ticket. A store blip must not take
      // the whole brief down with it.
      listConversations(100).catch(() => []),
      // Customer voice on newly shipped features — the PM section. A store
      // blip degrades it to "no mentions", which the zero-state copy covers.
      listReleaseMentions().catch(() => []),
    ]);

  const waitingChats = conversations.filter((c) => c.status === "waiting_human");

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

  // The whole open queue, not a 24h slice — an escalation sitting for three
  // days is more of this morning's problem, not less.
  const waiting = new Set<string>(
    tickets
      .filter((t) => t.escalatedAt != null && t.escalatedAt >= nowS - ESCALATION_LOOKBACK_H * HOUR_S)
      .map((t) => t.ticketId),
  );

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
    app: t.app,
    at,
    lastAt: t.lastAt,
    runs: t.runs,
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

  // ── The worklist ─────────────────────────────────────────────────
  /*
   * One ranked list of things a person has to pick up, rather than three
   * separate piles the reader has to merge in their head.
   *
   * A ticket appearing for two reasons is merged into one row carrying both
   * signals — the same ticket listed twice is the fastest way to make a
   * worklist untrustworthy.
   *
   * The order built here is a deterministic fallback, not the final answer:
   * chats first because a visitor is a minutes problem and everything else is
   * a days problem, then reopens newest-first (a fresh failure is the live
   * one), then escalations oldest-first (the neglected one is the problem).
   * The model reorders this, but if it fails or drops something the page is
   * still usable and still complete.
   */
  const byId = new Map<string, WorklistItem>();
  const age = (at: number) => Math.max(0, Math.round((nowS - at) / HOUR_S));

  const add = (item: WorklistItem) => {
    const existing = byId.get(item.id);
    if (!existing) return void byId.set(item.id, item);
    for (const s of item.signals) if (!existing.signals.includes(s)) existing.signals.push(s);
    if (item.at > existing.at) {
      existing.at = item.at;
      existing.ageHours = item.ageHours;
    }
  };

  const row = (r: ReturnType<typeof queueRow>, signal: WorklistSignal): WorklistItem => {
    const quietHours = age(r.lastAt);
    return {
      id: r.ticketId,
      signals: [signal],
      label: r.label,
      url: r.url,
      external: r.external,
      subject: r.subject,
      topic: r.topic,
      app: r.app,
      at: r.at,
      ageHours: age(r.at),
      state: quietHours < ACTIVE_WITHIN_H ? "active" : "stalled",
      quietHours,
      runs: r.runs,
      status: null,
    };
  };

  for (const r of reopened) add(row(r, "reopened"));
  for (const e of escalations) add(row(e, "escalated"));

  const chatRows: WorklistItem[] = waitingChats.map((c) => {
    const at = Math.floor((c.humanRequestedAt ?? Date.parse(c.lastActivityAt)) / 1000);
    return {
      id: `chat:${c.id}`,
      signals: ["chat_waiting"],
      label: c.visitor.name || c.visitor.email || "Visitor",
      url: `/chats/${c.id}`,
      external: false,
      subject: "Waiting for a person in live chat",
      topic: null,
      app: c.visitor.app ?? "unknown",
      at,
      ageHours: age(at),
      // A waiting visitor is by definition mid-conversation.
      state: "active",
      quietHours: age(at),
      runs: 1,
      // Chat status lives in the chat store and is already accurate — these
      // rows exist because the conversation says waiting_human.
      status: null,
    };
  });

  /*
   * Order: a waiting visitor first, then anything with a live customer on the
   * other end, then the abandoned pile.
   *
   * Within "active", most recent first — that is the person typing now. Within
   * "stalled", quietest first — the one nobody has touched longest is the one
   * being forgotten. Sorting the whole list by one clock gets one of those two
   * groups backwards whichever clock you pick.
   */
  /*
   * Drop anything that is finished, according to the system that owns it.
   *
   * This is the one place the brief looks outside its own history, and it has
   * to: the history records what happened, and nothing that happens afterwards
   * — a human closing a ticket, someone deleting a conversation — leaves any
   * trace in it. Both halves of this were live bugs. A closed ticket sat top of
   * the list as "reopened"; a deleted conversation kept a row pointing at a
   * page that no longer exists.
   *
   * Tickets are checked against Freshdesk, conversations against the chat
   * store. Rows already sourced from a waiting conversation skip the lookup —
   * they exist because that conversation said waiting_human a moment ago.
   */
  const candidates = [...chatRows, ...byId.values()];
  const withStatus = await Promise.all(
    candidates.map(async (item) => {
      if (item.id.startsWith("chat:")) return item;
      if (/^\d+$/.test(item.id)) return { ...item, status: await liveStatus(item.id) };
      // A conversation id. Gone means deleted or expired past retention, and
      // the row would link to a dead page; ticketed means the Freshdesk ticket
      // is the live thread now and this row is a duplicate of it.
      const conv = await getConversation(item.id).catch(() => undefined);
      if (conv === undefined) return item; // lookup failed — fail open
      if (!conv) return { ...item, status: "gone" };
      return { ...item, status: conv.status };
    }),
  );
  const DONE = new Set(["gone", "resolved", "ticketed"]);
  const live = withStatus.filter(
    (i) => !(i.status && (isTerminalStatus(i.status) || DONE.has(i.status))),
  );

  const group = (i: WorklistItem) =>
    i.signals.includes("chat_waiting") ? 0 : i.state === "active" ? 1 : 2;
  const worklist = live.sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
    return group(a) === 2 ? b.quietHours - a.quietHours : a.quietHours - b.quietHours;
  });

  // ── Release watch — customer voice for the product manager ───────
  // Rolling since each watch's start date, NOT day-scoped: a release section
  // that resets every midnight shows zeros most mornings and trains the
  // reader to skip it. Mentions are tagged at triage time (lib/release-watch.ts).
  const releases = activeReleaseWatches().map((w) => {
    const ms = releaseMentions.filter((m) => m.watchId === w.id);
    const byKind = Object.fromEntries(
      RELEASE_MENTION_KINDS.map((k): [ReleaseMentionKind, number] => [
        k,
        ms.filter((m) => m.kind === k).length,
      ]),
    ) as Record<ReleaseMentionKind, number>;
    return {
      id: w.id,
      name: w.name,
      since: w.since,
      releaseDate: w.releaseDate ?? null,
      total: ms.length,
      byKind,
      lastMentionAt: ms[0]?.at ?? null,
      mentions: ms.slice(0, 8).map((m) => ({
        ticketId: m.ticketId,
        subject: m.subject,
        kind: m.kind,
        quote: m.quote,
        app: m.app ?? null,
        at: m.at,
        ...refFor(m.ticketId, m.channel),
      })),
    };
  });

  return {
    generatedAt: Date.now(),
    windowHours: WINDOW_HOURS,
    releases,
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
    worklist,
    trends: {
      partialHistory: trends.partialHistory,
      historyDaysCovered: trends.historyDaysCovered,
      baselineDays: trends.baselineDays,
      unlabelled: trends.unlabelled,
      emerging: trends.emerging.map(withCoverage),
      top: trends.top.map(withCoverage),
    },
    queue: {
      learnings: {
        count: candidateLearnings.length,
        items: candidateLearnings.slice(0, 5).map((l) => ({
          id: l.id,
          text: l.text,
          category: l.category,
          product: l.product,
          createdAt: l.createdAt,
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
