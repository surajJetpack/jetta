/**
 * Team performance — how the support queue is doing, and how much of it Jetta
 * carries. Powers the admin-only /performance page.
 *
 * Every other console number comes from Jetta's own records (run logs,
 * outcomes, drafts). Those can't answer the question this page exists for:
 * "what did the CUSTOMER get?" In draft mode a human sends every Freshdesk
 * reply, so the truth lives in Freshdesk — who replied, when, and whether the
 * reply was Jetta's suggestion. This module turns a ticket + its thread into a
 * small record, and records into weekly numbers.
 *
 * Pure: no storage, no network. lib/performance-sync.ts feeds it.
 *
 * Methodology matches the 2026-09-23 performance review (Freshdesk pull,
 * pre/post Jetta), so the page and that report agree:
 *  - Only tickets with at least one agent reply count as "answered" — the rest
 *    are overwhelmingly marketing and vendor mail the team rightly ignores.
 *  - A suggestion is paired with the next public agent reply before the next
 *    suggestion, and scored with the same Dice similarity the draft
 *    reconciler uses (lib/reply-similarity.ts), so "sent as-is" means the same
 *    thing here as on /evals.
 */
import { JUNK } from "./intake";
import { replySimilarity, SIMILARITY_GOOD, SIMILARITY_PARTIAL } from "./reply-similarity";

/** Jetta's first Freshdesk draft went out on 2026-07-09; the first full day is the 10th. */
export const JETTA_LIVE_DATE = "2026-07-10";
/** How far back the sync reads. Three months of pre-Jetta baseline. */
export const BASELINE_START = "2026-04-01T00:00:00Z";

// ── Freshdesk shapes (only the fields read here) ────────────────────

export interface PerfListTicket {
  id: number;
  subject: string;
  source: number;
  /** 2 open, 3 pending, 4 resolved, 5 closed (custom statuses above that). */
  status?: number;
  created_at: string;
  updated_at: string;
  spam?: boolean;
  stats?: { resolved_at?: string | null; reopened_at?: string | null } | null;
}

export interface PerfConversation {
  private: boolean;
  incoming: boolean;
  user_id?: number;
  created_at: string;
  body_text?: string;
}

// ── The per-ticket record ───────────────────────────────────────────

export interface PerfSuggestion {
  /** ISO time Jetta posted the suggestion note. */
  at: string;
  /** Similarity to the agent reply that followed; null = no agent reply followed. */
  sim: number | null;
  /** Agent who sent that reply. */
  replyBy: string | null;
  /** Hours from the suggestion to that reply — how long the draft waited. */
  waitH: number | null;
}

/** How Jetta passed a ticket to people. One ticket can carry several. */
export type HandoffKind = "dev_item" | "slack" | "chat";

export interface PerfHandoff {
  kinds: HandoffKind[];
  /** ISO time of her first handoff note. */
  at: string;
  /** monday dev-item ids named in her notes — the thread engineering answers on. */
  itemIds: string[];
}

export interface PerfTicket {
  /** Record shape version — see PERF_SCHEMA. */
  v?: number;
  id: number;
  subject?: string;
  status?: number | null;
  createdAt: string;
  updatedAt: string;
  /** Freshdesk source code: 1 email, 2 portal, 3 phone/API, 7 chat. */
  source: number;
  agentReplies: number;
  customerMsgs: number;
  firstReplyH: number | null;
  firstReplyBy: string | null;
  firstReplyWords: number | null;
  firstReplyHasLink: boolean;
  resolvedH: number | null;
  reopened: boolean;
  suggestions: PerfSuggestion[];
  /** Ticket opened by Jetta from a live chat she couldn't finish. */
  fromChat: boolean;
  /** Jetta filed a dev-board item or a Slack escalation on it. */
  devWork: boolean;
  /** Set when Jetta handed the ticket to people (dev item, Slack, or a chat she couldn't finish). */
  handoff?: PerfHandoff | null;
}

/**
 * Bumped when PerfTicket gains a field that old records can't have. The sync
 * re-reads every ticket once when it sees a store written under an older
 * version — v2 added `handoff`, which only a fresh thread read can fill.
 */
export const PERF_SCHEMA = 2;

/** Auto-replies, OOO and bounces never reach the queue as work. */
export function isJunkSubject(subject: string): boolean {
  return JUNK.test(subject) || /^OOO\b/i.test(subject);
}

const SUGGESTION_MARK = /^Jetta — suggested reply/;
const FROM_CHAT_MARK = /Opened by Jetta from a live chat/;
const DEV_WORK_MARK = /Created dev board item|Escalated to dev team/;
/**
 * Her note wording has drifted over the months ("Created dev board item",
 * "Dev board item created", "Matched to existing open Dev board item", "Added
 * +1 to existing Dev board item"), so these match the family of ACTIONS — not
 * the phrase "dev board item", which her notes also use to say she found
 * nothing ("No matching Dev board item found", "Related dev board item
 * exists"). Matching the noun counted those as handoffs: 27 false positives in
 * the first audit sample.
 */
const DEV_ITEM_MARK =
  /(created|filed|opened) (a |the )?dev (board )?item|dev board item created|matched to existing (open )?dev board item|strong match found on (the )?dev board|\+1(['’]?d)?( to)? (the )?existing dev board item|added \+1|found and \+1/i;
const SLACK_MARK = /escalated\b[^.\n]{0,80}\b(dev team|engineering|via slack)/i;
const ITEM_ID = /\/pulses\/(\d{8,})|\bitem (\d{8,})\b/gi;

/** Did Jetta hand this ticket to people, and how? Read off her private notes. */
export function detectHandoff(jettaNotes: PerfConversation[]): PerfHandoff | null {
  const kinds = new Set<HandoffKind>();
  const itemIds = new Set<string>();
  let at: string | null = null;
  for (const n of jettaNotes) {
    const text = n.body_text ?? "";
    if (SUGGESTION_MARK.test(text.trim())) continue;
    const hit: HandoffKind[] = [];
    if (FROM_CHAT_MARK.test(text)) hit.push("chat");
    if (DEV_ITEM_MARK.test(text)) hit.push("dev_item");
    if (SLACK_MARK.test(text)) hit.push("slack");
    if (!hit.length) continue;
    for (const k of hit) kinds.add(k);
    for (const m of text.matchAll(ITEM_ID)) itemIds.add(m[1] ?? m[2]);
    if (!at || n.created_at < at) at = n.created_at;
  }
  return at ? { kinds: [...kinds], at, itemIds: [...itemIds] } : null;
}

const hoursBetween = (from: string, to: string) =>
  (new Date(to).getTime() - new Date(from).getTime()) / 3.6e6;

/**
 * The suggestion note wraps the reply in a header and a "To use it" footer
 * (lib/drafts.ts). Scoring the wrapper against the agent's reply would pull
 * every score down, so strip both.
 */
export function suggestionBody(note: string): string {
  return note
    .replace(/^\s*Jetta — suggested reply \(pending\)\s*/, "")
    .replace(/\s*To use it:[\s\S]*$/, "")
    .trim();
}

/**
 * One ticket + its full thread → a record. `agents` maps Freshdesk agent ids to
 * names (Jetta's own "App Support" id included — before Jetta existed that
 * account was shared by humans, and its public replies are real replies);
 * `jettaId` identifies her private notes.
 */
export function summarizeTicket(
  ticket: PerfListTicket,
  conversations: PerfConversation[],
  agents: Map<number, string>,
  jettaId: number | null,
): PerfTicket {
  const thread = [...conversations].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const agentPublic = thread.filter(
    (c) => !c.private && !c.incoming && c.user_id != null && agents.has(c.user_id),
  );
  const customer = thread.filter((c) => !c.private && c.incoming);
  const jettaNotes = thread.filter((c) => c.private && jettaId != null && c.user_id === jettaId);
  const suggestionNotes = jettaNotes.filter((c) => SUGGESTION_MARK.test((c.body_text ?? "").trim()));
  const fromChat = jettaNotes.some((c) => FROM_CHAT_MARK.test(c.body_text ?? ""));

  const suggestions: PerfSuggestion[] = suggestionNotes.map((note, i) => {
    const nextAt = suggestionNotes[i + 1]?.created_at ?? "9999";
    const reply = agentPublic.find((m) => m.created_at > note.created_at && m.created_at < nextAt);
    return {
      at: note.created_at,
      sim: reply ? Number(replySimilarity(suggestionBody(note.body_text ?? ""), reply.body_text ?? "").toFixed(3)) : null,
      replyBy: reply?.user_id != null ? (agents.get(reply.user_id) ?? null) : null,
      waitH: reply ? Number(hoursBetween(note.created_at, reply.created_at).toFixed(2)) : null,
    };
  });

  const first = agentPublic[0];
  const firstText = first?.body_text ?? "";
  const resolvedAt = ticket.stats?.resolved_at;
  return {
    v: PERF_SCHEMA,
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status ?? null,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    source: ticket.source,
    agentReplies: agentPublic.length,
    // The opening message is the ticket description, not a conversation —
    // except on tickets Jetta opened from chat, whose description is her summary.
    customerMsgs: customer.length + (fromChat ? 0 : 1),
    firstReplyH: first ? Number(hoursBetween(ticket.created_at, first.created_at).toFixed(2)) : null,
    firstReplyBy: first?.user_id != null ? (agents.get(first.user_id) ?? null) : null,
    firstReplyWords: first ? firstText.split(/\s+/).filter(Boolean).length : null,
    firstReplyHasLink: /https?:\/\//.test(firstText),
    resolvedH: resolvedAt ? Number(hoursBetween(ticket.created_at, resolvedAt).toFixed(2)) : null,
    reopened: !!ticket.stats?.reopened_at,
    suggestions,
    fromChat,
    devWork: jettaNotes.some((c) => DEV_WORK_MARK.test(c.body_text ?? "")),
    handoff: detectHandoff(jettaNotes),
  };
}

const DAY_MS = 86_400_000;

// ── Handoff outcomes: was it a bug, or something Jetta should have known? ──

/**
 * What a handed-off ticket turned out to be, judged from what happened AFTER
 * the handoff — engineering's comments on the dev item, and the agents' later
 * replies. The split that matters: a real_bug needed a developer; a
 * knowledge_gap needed only a fact Jetta didn't have, which a KB article fixes.
 */
export type HandoffCategory =
  | "real_bug"
  | "knowledge_gap"
  | "feature_request"
  | "account_action"
  | "customer_environment"
  | "unresolved";

export interface HandoffOutcome {
  ticketId: number;
  category: HandoffCategory;
  confidence: "high" | "medium" | "low";
  /** The deciding fact, in one sentence. */
  evidence: string;
  /** knowledge_gap: the generic fact Jetta needed. */
  missingKnowledge: string | null;
  /** knowledge_gap: a title for the article that would have let her answer. */
  kbArticleTitle: string | null;
  /** Did the KB already hold that fact? (Checked against the closest published articles.) */
  kbCoverage: "covered" | "partly_covered" | "not_covered" | null;
  kbArticle: string | null;
  /** Unix ms. */
  judgedAt: number;
  /** The ticket's updated_at the verdict was based on — newer activity triggers a re-judge. */
  basisUpdatedAt: string;
  model: string;
}

/**
 * Fill in handoffs her notes don't record. Some tickets carry a dev item Jetta
 * filed (the board knows) with no matching note on the ticket (a failed note
 * post, or an older wording); without this they'd read as "Jetta handled it".
 */
export function withBoardHandoffs(
  tickets: PerfTicket[],
  board: Record<string, { itemIds: string[]; jettaFiledAt: string }>,
): PerfTicket[] {
  return tickets.map((t) => {
    const b = board[String(t.id)];
    if (!b) return t;
    if (t.handoff) {
      const itemIds = [...new Set([...t.handoff.itemIds, ...b.itemIds])];
      const kinds: HandoffKind[] = t.handoff.kinds.includes("dev_item") ? t.handoff.kinds : [...t.handoff.kinds, "dev_item"];
      return { ...t, handoff: { ...t.handoff, kinds, itemIds } };
    }
    return { ...t, handoff: { kinds: ["dev_item"], at: b.jettaFiledAt, itemIds: b.itemIds } };
  });
}

/**
 * A handoff is judged once it has an outcome to judge: the ticket is resolved
 * or closed, or has gone quiet for a week. Judging an open one would mostly
 * say "unresolved", then need redoing.
 */
export function isSettled(t: Pick<PerfTicket, "status" | "updatedAt">, now: number): boolean {
  if (t.status === 4 || t.status === 5) return true;
  return now - new Date(t.updatedAt).getTime() > 7 * 86_400_000;
}

export type HandoffBucket = "real_bug" | "knowledge_gap" | "other" | "awaiting";

export function bucketOf(o: HandoffOutcome | undefined): HandoffBucket {
  if (!o || o.category === "unresolved") return "awaiting";
  if (o.category === "real_bug" || o.category === "knowledge_gap") return o.category;
  return "other";
}

export interface HandoffStats {
  total: number;
  real_bug: number;
  knowledge_gap: number;
  other: number;
  awaiting: number;
}

const emptyHandoffStats = (): HandoffStats => ({ total: 0, real_bug: 0, knowledge_gap: 0, other: 0, awaiting: 0 });

export interface HandoffSummary {
  /** Since Jetta went live. */
  all: HandoffStats;
  /** Last 28 days, by handoff date. */
  recent: HandoffStats;
  weeks: ({ week: string } & HandoffStats)[];
  /** How each route turned out — dev items vs Slack-only vs chat hand-offs. */
  byKind: ({ kind: HandoffKind } & HandoffStats)[];
  /** Knowledge gaps, newest first: the KB work list. */
  gaps: {
    ticketId: number;
    subject: string;
    at: string;
    missingKnowledge: string;
    kbArticleTitle: string | null;
    kbCoverage: HandoffOutcome["kbCoverage"];
    kbArticle: string | null;
    confidence: HandoffOutcome["confidence"];
  }[];
  bugs: { ticketId: number; subject: string; at: string; evidence: string }[];
  /** Everything else that was judged — feature requests, account work, platform issues. */
  others: { ticketId: number; subject: string; at: string; category: HandoffCategory; evidence: string }[];
}

export function handoffSummary(
  tickets: PerfTicket[],
  outcomes: Map<number, HandoffOutcome>,
  now: number,
): HandoffSummary {
  const handed = tickets
    .filter((t): t is PerfTicket & { handoff: PerfHandoff } => !!t.handoff)
    .sort((a, b) => b.handoff.at.localeCompare(a.handoff.at));
  const recentFrom = new Date(now - 28 * DAY_MS).toISOString();
  const all = emptyHandoffStats();
  const recent = emptyHandoffStats();
  const weeks = new Map<string, HandoffStats>();
  const kinds = new Map<HandoffKind, HandoffStats>();
  const add = (s: HandoffStats, b: HandoffBucket) => {
    s.total++;
    s[b]++;
  };
  for (const t of handed) {
    const b = bucketOf(outcomes.get(t.id));
    add(all, b);
    if (t.handoff.at >= recentFrom) add(recent, b);
    const w = weekStart(t.handoff.at);
    if (!weeks.has(w)) weeks.set(w, emptyHandoffStats());
    add(weeks.get(w)!, b);
    for (const k of t.handoff.kinds) {
      if (!kinds.has(k)) kinds.set(k, emptyHandoffStats());
      add(kinds.get(k)!, b);
    }
  }
  const judged = handed.map((t) => ({ t, o: outcomes.get(t.id) })).filter((x) => x.o);
  const subject = (t: PerfTicket) => t.subject ?? `Ticket #${t.id}`;
  return {
    all,
    recent,
    weeks: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, s]) => ({ week, ...s })),
    byKind: (["dev_item", "slack", "chat"] as HandoffKind[])
      .filter((k) => kinds.has(k))
      .map((kind) => ({ kind, ...kinds.get(kind)! })),
    gaps: judged
      .filter(({ o }) => o!.category === "knowledge_gap" && o!.missingKnowledge)
      .slice(0, 40)
      .map(({ t, o }) => ({
        ticketId: t.id,
        subject: subject(t),
        at: t.handoff.at,
        missingKnowledge: o!.missingKnowledge!,
        kbArticleTitle: o!.kbArticleTitle,
        kbCoverage: o!.kbCoverage,
        kbArticle: o!.kbArticle,
        confidence: o!.confidence,
      })),
    bugs: judged
      .filter(({ o }) => o!.category === "real_bug")
      .slice(0, 40)
      .map(({ t, o }) => ({ ticketId: t.id, subject: subject(t), at: t.handoff.at, evidence: o!.evidence })),
    others: judged
      .filter(({ o }) => bucketOf(o) === "other")
      .slice(0, 40)
      .map(({ t, o }) => ({ ticketId: t.id, subject: subject(t), at: t.handoff.at, category: o!.category, evidence: o!.evidence })),
  };
}

// ── Aggregation ─────────────────────────────────────────────────────

export type SuggestionUse = "as_is" | "edited" | "not_used";

/** Same thresholds as the draft reconciler, so the page and /evals agree. */
export function suggestionUse(sim: number): SuggestionUse {
  if (sim >= SIMILARITY_GOOD) return "as_is";
  if (sim >= SIMILARITY_PARTIAL) return "edited";
  return "not_used";
}

export function median(values: (number | null)[]): number | null {
  const s = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Number(m.toFixed(2));
}

const ratio = (num: number, den: number) => (den ? Number((num / den).toFixed(3)) : null);

/** Monday (UTC) of the week an ISO time falls in, as "YYYY-MM-DD". */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export interface PeriodStats {
  /** Tickets with at least one agent reply. */
  answered: number;
  /** Share of answered tickets that carried a Jetta suggestion. */
  coverage: number | null;
  suggestions: number;
  /** Suggestions an agent replied after — the ones that can be judged. */
  judged: number;
  asIs: number;
  edited: number;
  notUsed: number;
  /** (asIs + edited) / judged. */
  usedRate: number | null;
  /** Median hours a suggestion waited for an agent to send a reply. */
  draftWaitH: number | null;
  firstReplyH: number | null;
  resolvedH: number | null;
  firstReplyWords: number | null;
  linkRate: number | null;
  reopenRate: number | null;
  customerMsgsPerTicket: number | null;
  /** Tickets where Jetta filed a dev item or escalated. */
  devWork: number;
  /** Tickets Jetta opened from live chat. */
  fromChat: number;
}

export function periodStats(tickets: PerfTicket[]): PeriodStats {
  const answered = tickets.filter((t) => t.agentReplies > 0);
  const judged = tickets.flatMap((t) => t.suggestions).filter((s) => s.sim != null);
  const use = judged.map((s) => suggestionUse(s.sim as number));
  const asIs = use.filter((u) => u === "as_is").length;
  const edited = use.filter((u) => u === "edited").length;
  return {
    answered: answered.length,
    coverage: ratio(answered.filter((t) => t.suggestions.length > 0).length, answered.length),
    suggestions: tickets.reduce((n, t) => n + t.suggestions.length, 0),
    judged: judged.length,
    asIs,
    edited,
    notUsed: judged.length - asIs - edited,
    usedRate: ratio(asIs + edited, judged.length),
    draftWaitH: median(judged.map((s) => s.waitH)),
    firstReplyH: median(answered.map((t) => t.firstReplyH)),
    resolvedH: median(answered.map((t) => t.resolvedH)),
    firstReplyWords: median(answered.map((t) => t.firstReplyWords)),
    linkRate: ratio(answered.filter((t) => t.firstReplyHasLink).length, answered.length),
    reopenRate: ratio(answered.filter((t) => t.reopened).length, answered.length),
    customerMsgsPerTicket: answered.length
      ? Number((answered.reduce((n, t) => n + t.customerMsgs, 0) / answered.length).toFixed(2))
      : null,
    devWork: tickets.filter((t) => t.devWork).length,
    fromChat: tickets.filter((t) => t.fromChat).length,
  };
}

export interface AgentStats {
  agent: string;
  /** Tickets this agent sent the first reply on. */
  firstReplies: number;
  firstReplyH: number | null;
  /** Replies this agent sent right after a Jetta suggestion. */
  afterSuggestion: number;
  /** Share of those built on her text (as-is or edited). */
  usedRate: number | null;
}

export function agentStats(tickets: PerfTicket[]): AgentStats[] {
  const by = new Map<string, { first: (number | null)[]; after: number; used: number }>();
  const bucket = (name: string) => {
    let b = by.get(name);
    if (!b) by.set(name, (b = { first: [], after: 0, used: 0 }));
    return b;
  };
  for (const t of tickets) {
    if (t.firstReplyBy) bucket(t.firstReplyBy).first.push(t.firstReplyH);
    for (const s of t.suggestions) {
      if (s.sim == null || !s.replyBy) continue;
      const b = bucket(s.replyBy);
      b.after++;
      if (suggestionUse(s.sim) !== "not_used") b.used++;
    }
  }
  return [...by.entries()]
    .map(([agent, b]) => ({
      agent,
      firstReplies: b.first.length,
      firstReplyH: median(b.first),
      afterSuggestion: b.after,
      usedRate: ratio(b.used, b.after),
    }))
    .sort((a, b) => b.firstReplies + b.afterSuggestion - (a.firstReplies + a.afterSuggestion));
}

// ── Live chat ───────────────────────────────────────────────────────

export interface ChatWeek {
  week: string;
  /** Conversations with a real question — greetings and tests excluded. */
  real: number;
  /** Finished by Jetta: no ticket, no human. */
  alone: number;
  /** Became a ticket, or a person joined. */
  handedOff: number;
}

/** Just the fields of a ChatConversation read here. */
export interface PerfChat {
  createdAt: string;
  status: string;
  ticketId?: string;
  messages: { author: string; via?: string; system?: boolean; text: string }[];
}

/**
 * A chat counts when the visitor asked something: a greeting ("hi", "ok") or a
 * [TEST] health check is not a conversation anybody handled.
 */
export function isRealChat(c: PerfChat): boolean {
  const said = c.messages.filter((m) => m.author === "visitor").map((m) => m.text.trim());
  if (!said.length || said.some((t) => /^\[TEST\]/i.test(t))) return false;
  return said.join(" ").split(/\s+/).filter(Boolean).length >= 4;
}

export function chatWeeks(chats: PerfChat[]): ChatWeek[] {
  const by = new Map<string, ChatWeek>();
  for (const c of chats) {
    if (!isRealChat(c)) continue;
    const week = weekStart(c.createdAt);
    let w = by.get(week);
    if (!w) by.set(week, (w = { week, real: 0, alone: 0, handedOff: 0 }));
    w.real++;
    const human = c.messages.some((m) => m.author === "agent" && m.via === "human" && !m.system);
    const handed = !!c.ticketId || human || c.status === "waiting_human" || c.status === "human";
    if (handed) w.handedOff++;
    else w.alone++;
  }
  return [...by.values()].sort((a, b) => a.week.localeCompare(b.week));
}

// ── The page's whole payload ────────────────────────────────────────

export interface PerformanceSummary {
  computedAt: number;
  /** Tickets in the store (answered or not). */
  tickets: number;
  /** Oldest ticket creation date covered. */
  since: string;
  weeks: ({ week: string } & PeriodStats)[];
  /** Last 28 days vs the 28 before — the headline row. */
  recent: PeriodStats;
  previous: PeriodStats;
  /** Everything before Jetta started drafting. */
  baseline: PeriodStats;
  /** Per agent, last 28 days. Admin page only. */
  agents: AgentStats[];
  chat: { computedAt: number; weeks: ChatWeek[] } | null;
  /** Absent on summaries written before handoff outcomes existed. */
  handoffs?: HandoffSummary;
  /** Freshdesk ticket link prefix, e.g. "https://x.freshdesk.com/a/tickets/". */
  ticketUrlBase?: string;
}

export function buildSummary(
  tickets: PerfTicket[],
  now: number,
  chat: PerformanceSummary["chat"],
  outcomes: Map<number, HandoffOutcome> = new Map(),
): PerformanceSummary {
  const byWeek = new Map<string, PerfTicket[]>();
  for (const t of tickets) {
    const w = weekStart(t.createdAt);
    const list = byWeek.get(w);
    if (list) list.push(t);
    else byWeek.set(w, [t]);
  }
  const recentFrom = new Date(now - 28 * DAY_MS).toISOString();
  const previousFrom = new Date(now - 56 * DAY_MS).toISOString();
  const recent = tickets.filter((t) => t.createdAt >= recentFrom);
  return {
    computedAt: now,
    tickets: tickets.length,
    since: tickets.reduce((m, t) => (t.createdAt < m ? t.createdAt : m), new Date(now).toISOString()).slice(0, 10),
    weeks: [...byWeek.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, list]) => ({ week, ...periodStats(list) })),
    recent: periodStats(recent),
    previous: periodStats(tickets.filter((t) => t.createdAt >= previousFrom && t.createdAt < recentFrom)),
    baseline: periodStats(tickets.filter((t) => t.createdAt < JETTA_LIVE_DATE)),
    agents: agentStats(recent),
    chat,
    handoffs: handoffSummary(tickets.filter((t) => t.createdAt >= JETTA_LIVE_DATE), outcomes, now),
  };
}
