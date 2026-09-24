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

export interface PerfTicket {
  id: number;
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
}

/** Auto-replies, OOO and bounces never reach the queue as work. */
export function isJunkSubject(subject: string): boolean {
  return JUNK.test(subject) || /^OOO\b/i.test(subject);
}

const SUGGESTION_MARK = /^Jetta — suggested reply/;
const FROM_CHAT_MARK = /Opened by Jetta from a live chat/;
const DEV_WORK_MARK = /Created dev board item|Escalated to dev team/;

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
    id: ticket.id,
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
}

const DAY_MS = 86_400_000;

export function buildSummary(
  tickets: PerfTicket[],
  now: number,
  chat: PerformanceSummary["chat"],
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
  };
}
