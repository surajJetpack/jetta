/**
 * Agent activity — what the PEOPLE on the support team did, everywhere they
 * do it. Powers the admin-only /activity page.
 *
 * A person's day is spread over five places that each keep their own record,
 * in their own identity space:
 *
 *   Freshdesk  replies and private notes          (agent name, from the perf sync's thread reads)
 *   Chats      takeovers, messages, hand-backs    (console username, from the chat routes' events)
 *   Slack      replies in Jetta's channels        (Slack user id, from a channel read)
 *   monday     comments, status changes, moves    (monday user name, from the board's activity log)
 *   Console    draft decisions, KB, evals, billing (console username, from events and the KB audit)
 *
 * Each source is turned into one `Activity` shape and kept in its own store
 * (lib/activity-store.ts), because the ops event log rolls off after 5,000
 * events — a few days — and most of these sources never wrote to it at all.
 *
 * Identities are merged by first name, with AGENT_ALIASES for anything that
 * doesn't line up ("Solutions Team" in Freshdesk is a person in the console).
 * Merging is a READ-time decision: records keep the name the source used, so a
 * wrong alias is fixed by changing the env var, not by rewriting history.
 *
 * Pure: no storage, no network.
 */
import type { OpsEvent } from "./events";
import type { PerfConversation } from "./performance";

export type Place = "freshdesk" | "chat" | "slack" | "monday" | "console";

export const PLACES: { id: Place; label: string }[] = [
  { id: "freshdesk", label: "Freshdesk" },
  { id: "chat", label: "Chats" },
  { id: "slack", label: "Slack" },
  { id: "monday", label: "monday" },
  { id: "console", label: "Console" },
];

export type ActionKind =
  // Freshdesk
  | "fd.reply"
  | "fd.note"
  | "fd.draft_used"
  | "fd.draft_edited"
  | "fd.draft_not_used"
  // JettaChat
  | "chat.joined"
  | "chat.message"
  | "chat.ticketed"
  | "chat.resolved"
  | "chat.reopened"
  | "chat.handed_back"
  // Slack
  | "slack.reply"
  | "slack.message"
  | "slack.command"
  | "slack.asked_jetta"
  // monday
  | "monday.comment"
  | "monday.status"
  | "monday.moved"
  | "monday.created"
  // Console
  | "console.draft_sent"
  | "console.draft_discarded"
  | "console.draft_feedback"
  | "console.learning"
  | "console.billing"
  | "console.kb"
  | "console.settings"
  | "console.login";

export interface Activity {
  /** Deterministic per source, so re-reading a source never double-counts. */
  id: string;
  /** Unix ms. */
  at: number;
  place: Place;
  /**
   * The actor exactly as the source named them: a Freshdesk agent name, a
   * console username, "slack:U123" (resolved to a name at read time), a
   * monday user name.
   */
  who: string;
  action: ActionKind;
  /** Freshdesk ticket id, when the action belongs to one. */
  ticketId?: string;
  /** The thing acted on in its own place: chat id, KB article id, monday item id, Slack ts. */
  ref?: string;
  /** One short line of what happened, already in words. */
  detail?: string;
  /** How long someone had been waiting when this person acted (chat pickup, Slack response). */
  waitMs?: number;
  url?: string;
}

/** Past-tense phrase for the timeline. */
export const ACTION_LABEL: Record<ActionKind, string> = {
  "fd.reply": "replied to a customer",
  "fd.note": "left a private note",
  "fd.draft_used": "sent Jetta's draft",
  "fd.draft_edited": "sent Jetta's draft, edited",
  "fd.draft_not_used": "wrote their own reply over Jetta's draft",
  "chat.joined": "took over a chat",
  "chat.message": "messaged in a chat",
  "chat.ticketed": "turned a chat into a ticket",
  "chat.resolved": "resolved a chat",
  "chat.reopened": "reopened a chat",
  "chat.handed_back": "handed a chat back to Jetta",
  "slack.reply": "replied in a Slack thread",
  "slack.message": "posted in Slack",
  "slack.command": "ran a Jetta command in Slack",
  "slack.asked_jetta": "asked Jetta in Slack",
  "monday.comment": "commented on a dev item",
  "monday.status": "changed a dev item's status",
  "monday.moved": "moved a dev item",
  "monday.created": "created a dev item",
  "console.draft_sent": "sent a draft from the console",
  "console.draft_discarded": "discarded a draft",
  "console.draft_feedback": "gave feedback on a draft",
  "console.learning": "decided on a learning",
  "console.billing": "decided a billing approval",
  "console.kb": "changed a KB article",
  "console.settings": "changed chat settings",
  "console.login": "signed in to the console",
};

/**
 * The scorecard's columns. Each is a set of actions, so a click on a number
 * filters the timeline to exactly the activity that made it.
 */
export const COLUMNS = [
  { id: "fdReplies", label: "FD replies", place: "freshdesk", actions: ["fd.reply"] },
  { id: "fdNotes", label: "FD notes", place: "freshdesk", actions: ["fd.note"] },
  { id: "chats", label: "Chats taken", place: "chat", actions: ["chat.joined"] },
  {
    id: "chatActions",
    label: "Chat actions",
    place: "chat",
    actions: ["chat.message", "chat.ticketed", "chat.resolved", "chat.reopened", "chat.handed_back"],
  },
  { id: "slack", label: "Slack", place: "slack", actions: ["slack.reply", "slack.message", "slack.command", "slack.asked_jetta"] },
  { id: "monday", label: "monday", place: "monday", actions: ["monday.comment", "monday.status", "monday.moved", "monday.created"] },
  {
    id: "console",
    label: "Console",
    place: "console",
    actions: [
      "fd.draft_used",
      "fd.draft_edited",
      "fd.draft_not_used",
      "console.draft_sent",
      "console.draft_discarded",
      "console.draft_feedback",
      "console.learning",
      "console.billing",
      "console.kb",
      "console.settings",
    ],
  },
] as const satisfies readonly { id: string; label: string; place: Place; actions: readonly ActionKind[] }[];

export type ColumnId = (typeof COLUMNS)[number]["id"];

/**
 * Draft outcomes are Freshdesk actions, but they are Jetta-review work, so they
 * count under "Console" with the rest of the review queue — the same person
 * deciding the same kind of thing, wherever they clicked.
 */
const COLUMN_OF = new Map<ActionKind, ColumnId>(
  COLUMNS.flatMap((c) => c.actions.map((a) => [a as ActionKind, c.id] as const)),
);

/** Sign-ins don't count as work; they only move "last seen". */
const COUNTS_AS_WORK = (a: ActionKind) => a !== "console.login";

// ── Identity ────────────────────────────────────────────────────────

/**
 * AGENT_ALIASES: "Name=alias,alias;Name=alias". Every alias (and the name
 * itself) is matched case-insensitively against the source's actor string
 * after prefixes are stripped. Slack ids are aliases too, though names are
 * resolved first, so most people never need one.
 */
export function parseAliases(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (raw ?? "").split(";")) {
    const [name, rest = ""] = entry.split("=");
    const display = name?.trim();
    if (!display) continue;
    out.set(display.toLowerCase(), display);
    for (const a of rest.split(",")) {
      const alias = a.trim().toLowerCase();
      if (alias) out.set(alias, display);
    }
  }
  return out;
}

/** "Cherryl via freshdesk" → "Cherryl"; "console:suraj" → "suraj"; "slack:U1" → "U1". */
export function stripActor(who: string): string {
  return who
    .replace(/\s+via\s+\w+$/i, "")
    .replace(/^(console|slack):/i, "")
    .trim();
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The person an actor string belongs to: { key, name }. Aliases first, then
 * the first word of the name — "Cherryl Mae" in Freshdesk and "cherryl" in
 * the console are the same person, and nobody on a team this size shares a
 * first name. When someone does, an alias splits them.
 */
export function resolvePerson(
  who: string,
  aliases: Map<string, string>,
  slackNames: Record<string, string> = {},
): { key: string; name: string } {
  let raw = stripActor(who);
  if (/^slack:/i.test(who)) {
    const viaAlias = aliases.get(raw.toLowerCase());
    if (viaAlias) return { key: viaAlias.toLowerCase(), name: viaAlias };
    raw = slackNames[raw] ?? raw;
  }
  const full = aliases.get(raw.toLowerCase());
  if (full) return { key: full.toLowerCase(), name: full };
  const first = raw.split(/[\s._@-]+/)[0] ?? raw;
  const viaFirst = aliases.get(first.toLowerCase());
  if (viaFirst) return { key: viaFirst.toLowerCase(), name: viaFirst };
  // A Slack id nobody could resolve stays whole rather than becoming "U07".
  if (/^U[A-Z0-9]{6,}$/.test(raw)) return { key: raw.toLowerCase(), name: raw };
  return { key: first.toLowerCase(), name: titleCase(first) };
}

/**
 * Actors that are not a person. "dev" is an unconfigured local console,
 * "console" is the routes' fallback when no login was found.
 */
export function isMachineActor(who: string | undefined): boolean {
  if (!who) return true;
  const w = stripActor(who).toLowerCase();
  return !w || MACHINE_ACTORS.has(w) || /-(script|seed|sync|migrate|analysis)$/.test(w);
}

/** Writers that are code: the KB sync, one-off scripts, seeds. */
const MACHINE_ACTORS = new Set([
  "dev",
  "console",
  "jetta",
  "system",
  "cron",
  "kb-sync",
  "kb-migrate",
  "mem-seed",
  "freshdesk-analysis",
]);

// ── Sources → Activity ──────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The human half of the ops event stream. Called on every logOpsEvent, so it
 * must stay cheap and return null for the (large) machine majority.
 */
export function activityFromEvent(e: OpsEvent): Activity | null {
  if (isMachineActor(e.actor)) return null;
  const who = e.actor === "api" ? "API key" : e.actor!;
  const d = e.data ?? {};
  const base = { id: `ev:${e.id}`, at: e.at, who, ticketId: e.ticketId };
  const chat = (action: ActionKind, extra: Partial<Activity> = {}): Activity => ({
    ...base,
    place: "chat",
    action,
    ticketId: undefined,
    ref: e.ticketId,
    url: e.ticketId ? `/chats/${e.ticketId}` : undefined,
    ...extra,
  });

  switch (e.event) {
    case "chat.human_joined":
      return chat("chat.joined", { waitMs: num(d.waitedMs) });
    case "chat.human_replied":
      return chat("chat.message", { detail: num(d.chars) ? `${d.chars} characters` : undefined });
    case "chat.ticketed_by_human": {
      const fd = d.freshdeskTicket != null ? String(d.freshdeskTicket) : undefined;
      return chat("chat.ticketed", { ticketId: fd, detail: fd ? `ticket #${fd}` : undefined });
    }
    case "chat.resolved_by_human":
      return chat("chat.resolved");
    case "chat.reopened_by_human":
      return chat("chat.reopened");
    case "chat.handed_back":
      return chat("chat.handed_back");
    case "chat.settings_updated": {
      const changed = Array.isArray(d.changed) ? (d.changed as unknown[]).map(String).join(", ") : undefined;
      return { ...base, place: "console", action: "console.settings", detail: changed, url: "/chats/settings" };
    }
    case "draft.approved":
      return {
        ...base,
        place: "console",
        action: "console.draft_sent",
        detail: d.edited ? "edited before sending" : "sent as written",
        ref: str(d.draftId),
      };
    case "draft.discarded":
      return { ...base, place: "console", action: "console.draft_discarded", ref: str(d.draftId) };
    case "draft.feedback_saved":
      return { ...base, place: "console", action: "console.draft_feedback", ref: str(d.draftId) };
    case "draft.reconciled": {
      // The reconciler names the Freshdesk agent who replied over a pending draft.
      const usage = str(d.usage);
      const action: ActionKind =
        usage === "used_as_is" ? "fd.draft_used" : usage === "edited" ? "fd.draft_edited" : "fd.draft_not_used";
      return { ...base, place: "freshdesk", action, ref: str(d.draftId) };
    }
    case "learning.created":
    case "learning.approved":
    case "learning.rejected":
    case "learning.retired": {
      const verb = e.event.split(".")[1];
      const text = str(d.text);
      return {
        ...base,
        place: "console",
        action: "console.learning",
        detail: text ? `${verb}: ${clip(text, 90)}` : verb,
        ref: str(d.learningId),
        url: "/evals",
      };
    }
    case "monetization.approve":
    case "monetization.reject":
      return {
        ...base,
        place: "console",
        action: "console.billing",
        detail: e.event.endsWith("approve") ? "approved" : "rejected",
        ref: str(d.ref),
        url: "/billing",
      };
    case "slack.privileged_action":
      return {
        ...base,
        place: "slack",
        action: "slack.command",
        // Slack events carry the raw user id; names are resolved at read time.
        who: `slack:${e.actor}`,
        detail: str(d.action)?.replace(/_/g, " "),
      };
    case "slack.dm_answered":
      // A question to Jetta in a DM or the assistant panel — the lookup work
      // people with no Freshdesk login now do there. Only the fact is kept.
      return { ...base, place: "slack", action: "slack.asked_jetta", who: `slack:${e.actor}` };
    case "auth.login_success":
      return { ...base, place: "console", action: "console.login" };
    default:
      return null;
  }
}

/**
 * A Freshdesk thread's human messages. Read from the thread the perf sync
 * already fetched, so it costs no Freshdesk calls. Only agents count (a
 * customer's user_id is not in the agent map), and never Jetta herself.
 */
export function activitiesFromThread(
  ticketId: number,
  subject: string | undefined,
  thread: PerfConversation[],
  agents: Map<number, string>,
  jettaId: number | null,
  ticketUrl?: string,
): Activity[] {
  const out: Activity[] = [];
  for (const c of thread) {
    if (c.incoming || c.user_id == null || c.user_id === jettaId) continue;
    // Belt and braces for an environment without FRESHDESK_AGENT_ID: her
    // notes all open with her name ("Jetta — suggested reply", "Jetta: …").
    if (c.private && /^\s*Jetta\b/.test(c.body_text ?? "")) continue;
    const who = agents.get(c.user_id);
    if (!who) continue;
    const at = Date.parse(c.created_at);
    if (!Number.isFinite(at)) continue;
    out.push({
      id: `fd:${ticketId}:${c.user_id}:${at}`,
      at,
      place: "freshdesk",
      who,
      action: c.private ? "fd.note" : "fd.reply",
      ticketId: String(ticketId),
      detail: subject ? clip(subject, 90) : undefined,
      url: ticketUrl ? `${ticketUrl}${ticketId}` : undefined,
    });
  }
  return out;
}

/** KB audit entries (unix SECONDS) — the KB store's own record of who changed what. */
export interface KbAuditLike {
  at: number;
  actor: string;
  articleId: string;
  title?: string;
  action: string;
  toState?: string;
  version?: number;
}

export function activityFromKbAudit(a: KbAuditLike): Activity | null {
  if (isMachineActor(a.actor)) return null;
  const verb =
    a.action === "state_change" && a.toState
      ? a.toState === "published"
        ? "published"
        : `moved to ${a.toState}`
      : a.action.replace(/_/g, " ");
  return {
    id: `kb:${a.articleId}:${a.at}:${a.action}:${a.version ?? ""}`,
    at: a.at * 1000,
    place: "console",
    who: a.actor === "api" ? "API key" : a.actor,
    action: "console.kb",
    ref: a.articleId,
    detail: a.title ? `${verb}: ${clip(a.title, 80)}` : verb,
    url: `/kb/article?id=${encodeURIComponent(a.articleId)}`,
  };
}

/** A Slack message, parent or reply, as Slack's history API returns it. */
export interface SlackMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

/** Human, real messages only: no bots (Jetta included), no joins or edits. */
export const isHumanSlack = (m: SlackMsg) => !!m.user && !m.bot_id && (!m.subtype || m.subtype === "thread_broadcast");

const slackMs = (ts: string) => Math.round(Number(ts) * 1000);

/**
 * One thread in a Jetta channel → its human messages. A reply's waitMs is
 * measured from the parent only for the FIRST human reply to a Jetta post —
 * that is "how long did an escalation sit before somebody answered", the
 * number worth watching. Later replies are conversation, not response.
 */
export function activitiesFromSlackThread(
  channel: string,
  channelName: string,
  parent: SlackMsg,
  replies: SlackMsg[],
): Activity[] {
  const out: Activity[] = [];
  const link = (ts: string, thread?: string) =>
    `https://slack.com/archives/${channel}/p${ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${channel}` : ""}`;
  const topic = clip(slackText(parent.text ?? ""), 80);
  if (isHumanSlack(parent)) {
    out.push({
      id: `slack:${channel}:${parent.ts}`,
      at: slackMs(parent.ts),
      place: "slack",
      who: `slack:${parent.user}`,
      action: "slack.message",
      ref: parent.ts,
      detail: `#${channelName}: ${clip(slackText(parent.text ?? ""), 80)}`,
      url: link(parent.ts),
    });
  }
  let answered = false;
  for (const r of replies) {
    if (r.ts === parent.ts || !isHumanSlack(r)) continue;
    const first = !answered && !isHumanSlack(parent);
    answered = true;
    out.push({
      id: `slack:${channel}:${r.ts}`,
      at: slackMs(r.ts),
      place: "slack",
      who: `slack:${r.user}`,
      action: "slack.reply",
      ref: parent.ts,
      detail: `#${channelName}: ${topic}`,
      waitMs: first ? slackMs(r.ts) - slackMs(parent.ts) : undefined,
      url: link(r.ts, parent.ts),
      ticketId: ticketFromText(parent.text ?? ""),
    });
  }
  return out;
}

/** Slack mrkdwn → plain words: "<https://x|#123>" → "#123", "<@U1>" → "@someone". */
export function slackText(t: string): string {
  return t
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<!(channel|here)>/g, "@$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jetta's escalation posts link the Freshdesk ticket; pull the id back out. */
export function ticketFromText(t: string): string | undefined {
  return t.match(/\/a\/tickets\/(\d+)/)?.[1];
}

/** monday activity log row (data is a JSON string). created_at is 1e-7 s since epoch. */
export interface MondayLog {
  id: string;
  event: string;
  data: string;
  user_id: string;
  created_at: string;
}

export function activityFromMondayLog(
  log: MondayLog,
  boardId: string,
  boardName: string,
  users: Map<string, string>,
  accountUrl: string,
): Activity | null {
  const who = users.get(String(log.user_id));
  if (!who) return null;
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(log.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const item = d.pulse_id != null ? String(d.pulse_id) : undefined;
  const name = str(d.pulse_name);
  const base = {
    id: `mon:${log.id}`,
    at: Math.round(Number(log.created_at) / 10_000),
    place: "monday" as const,
    who,
    ref: item,
    url: item ? `${accountUrl}/boards/${boardId}/pulses/${item}` : undefined,
  };
  const on = name ? ` — ${clip(name, 70)}` : "";
  if (log.event === "update_column_value") {
    // Status columns only. Every other column edit (dates, people, text) is
    // tidying, and would drown the changes that move work.
    const type = str(d.column_type);
    if (type === "multiple-person" || type === "people") {
      const to = str(d.textual_value);
      if (!to) return null;
      return { ...base, action: "monday.status", detail: `${str(d.column_title)?.replace(/\s*↗️?\s*$/, "") ?? "People"} → ${to}${on}` };
    }
    if (type !== "color" && type !== "status") return null;
    const value = d.value as { label?: { text?: string } } | null;
    const to = value?.label?.text;
    if (!to) return null;
    return { ...base, action: "monday.status", detail: `${str(d.column_title) ?? "Status"} → ${to}${on}` };
  }
  if (log.event === "move_pulse_into_group") {
    const dest = (d.dest_group as { title?: string } | undefined)?.title;
    return { ...base, action: "monday.moved", detail: `${dest ? `to ${dest}` : "between groups"}${on}` };
  }
  if (log.event === "create_pulse") {
    return { ...base, action: "monday.created", detail: `${boardName}${on}` };
  }
  return null;
}

export interface MondayUpdate {
  id: string;
  created_at: string;
  creator_id: string | null;
  item_id: string | null;
  text_body: string | null;
}

export function activityFromMondayUpdate(
  u: MondayUpdate,
  boardId: string,
  users: Map<string, string>,
  accountUrl: string,
  itemNames: Map<string, string>,
): Activity | null {
  const who = u.creator_id ? users.get(String(u.creator_id)) : undefined;
  if (!who) return null;
  const at = Date.parse(u.created_at);
  if (!Number.isFinite(at)) return null;
  const item = u.item_id ?? undefined;
  const name = item ? itemNames.get(item) : undefined;
  const text = clip((u.text_body ?? "").replace(/\s+/g, " ").trim(), 90);
  return {
    id: `monu:${u.id}`,
    at,
    place: "monday",
    who,
    action: "monday.comment",
    ref: item,
    detail: [name ? clip(name, 60) : null, text || null].filter(Boolean).join(": ") || undefined,
    ticketId: ticketFromText(u.text_body ?? ""),
    url: item ? `${accountUrl}/boards/${boardId}/pulses/${item}` : undefined,
  };
}

// ── Scorecard ───────────────────────────────────────────────────────

export interface PersonRow {
  key: string;
  name: string;
  /** Count per scorecard column. */
  counts: Record<ColumnId, number>;
  total: number;
  /** Places this person showed up in, in PLACES order. */
  places: Place[];
  /** Distinct local days with any work. */
  activeDays: number;
  /** Last activity of any kind, sign-ins included. Unix ms. */
  lastAt: number;
  /** Median minutes from "a visitor asked for a person" to this person joining. */
  chatPickupMin: number | null;
  /** Median minutes from a Jetta Slack post to this person's first reply in it. */
  slackResponseMin: number | null;
  /** Work actions per hour of day (0–23, in `tz`). */
  hours: number[];
}

export interface Scorecard {
  people: PersonRow[];
  /** Count per place, all people. */
  byPlace: Record<Place, number>;
  total: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const zeroCounts = () => Object.fromEntries(COLUMNS.map((c) => [c.id, 0])) as Record<ColumnId, number>;

function localParts(at: number, tz: string): { day: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

export function buildScorecard(
  acts: Activity[],
  opts: { aliases: Map<string, string>; slackNames?: Record<string, string>; tz?: string },
): Scorecard {
  const tz = opts.tz ?? "UTC";
  const people = new Map<string, PersonRow & { _days: Set<string>; _pickup: number[]; _slack: number[]; _places: Set<Place> }>();
  const byPlace = Object.fromEntries(PLACES.map((p) => [p.id, 0])) as Record<Place, number>;
  let total = 0;
  for (const a of acts) {
    const { key, name } = resolvePerson(a.who, opts.aliases, opts.slackNames);
    let row = people.get(key);
    if (!row) {
      row = {
        key,
        name,
        counts: zeroCounts(),
        total: 0,
        places: [],
        activeDays: 0,
        lastAt: 0,
        chatPickupMin: null,
        slackResponseMin: null,
        hours: Array(24).fill(0),
        _days: new Set(),
        _pickup: [],
        _slack: [],
        _places: new Set(),
      };
      people.set(key, row);
    }
    row.lastAt = Math.max(row.lastAt, a.at);
    if (!COUNTS_AS_WORK(a.action)) continue;
    const col = COLUMN_OF.get(a.action);
    if (col) row.counts[col]++;
    row.total++;
    total++;
    byPlace[a.place]++;
    row._places.add(a.place);
    const { day, hour } = localParts(a.at, tz);
    row._days.add(day);
    row.hours[hour]++;
    if (a.action === "chat.joined" && a.waitMs != null && a.waitMs >= 0) row._pickup.push(a.waitMs / 60_000);
    if (a.action === "slack.reply" && a.waitMs != null && a.waitMs >= 0) row._slack.push(a.waitMs / 60_000);
  }
  const rows: PersonRow[] = [...people.values()]
    .map(({ _days, _pickup, _slack, _places, ...r }) => ({
      ...r,
      activeDays: _days.size,
      chatPickupMin: median(_pickup),
      slackResponseMin: median(_slack),
      places: PLACES.map((p) => p.id).filter((p) => _places.has(p)),
    }))
    .sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);
  return { people: rows, byPlace, total };
}

export interface TimelineFilter {
  person?: string;
  place?: Place;
  column?: ColumnId;
  /** Hide sign-ins (default true: they are noise unless asked for). */
  hideLogins?: boolean;
}

/** Newest first. `acts` may arrive in any order. */
export function filterTimeline(
  acts: Activity[],
  f: TimelineFilter,
  opts: { aliases: Map<string, string>; slackNames?: Record<string, string> },
): Activity[] {
  const cols = f.column ? new Set<ActionKind>(COLUMNS.find((c) => c.id === f.column)?.actions ?? []) : null;
  return acts
    .filter((a) => {
      if (f.place && a.place !== f.place) return false;
      if (cols && !cols.has(a.action)) return false;
      if ((f.hideLogins ?? true) && !cols && a.action === "console.login") return false;
      if (f.person && resolvePerson(a.who, opts.aliases, opts.slackNames).key !== f.person) return false;
      return true;
    })
    .sort((a, b) => b.at - a.at);
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
