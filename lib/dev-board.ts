/**
 * /dev-board — the monday dev boards read as a team: how engineering moves
 * client-reported work, what support does on the boards, and what the
 * conversations on items teach.
 *
 * Pure. lib/dev-board-sync.ts reads monday and calls these;
 * scripts/dev-board-test.ts pins them. Admin page: rows name people.
 *
 * Three kinds of people write on the boards (read off 2026-10-13):
 *  - support (Cherryl, Sujata, Gabriel) file client issues, relay customers,
 *    test fixes and set "Waiting Customer";
 *  - Jetta, through Suraj's API token — her posts open with "Product:" or
 *    "Follow-up from the SAME Freshdesk ticket";
 *  - everyone else — developers, QA, design, leads. The page calls them
 *    "engineering": for a client issue, any of them answering is the team
 *    answering.
 *
 * Only CLIENT ISSUES (filed by support or Jetta) feed the headline numbers. The
 * boards also carry roadmap work filed by leads, whose cycle time means
 * something else entirely; mixing the two made every median meaningless.
 */

export type BoardKey = "getsign" | "jetpackapps";

/** One comment or reply on an item, oldest first. */
export interface DevPost {
  id: string;
  at: number;
  who: string;
  text: string;
  /** Set on a reply: the comment it answers. */
  parentId?: string;
}

/** A Dev Status change or a move between groups, from the board's activity log. */
export interface StatusChange {
  at: number;
  kind: "status" | "group";
  to: string;
  by: string;
}

export interface DevItem {
  id: string;
  board: BoardKey;
  boardId: string;
  name: string;
  url: string;
  group: string;
  /** Dev Status. */
  status: string | null;
  developers: string[];
  /** UX and Testing Reviewer columns — engineering too. */
  reviewers: string[];
  reporter: string | null;
  priority: string | null;
  type: string | null;
  /** "Project": the app on Dev Tasks (VLOOKUP, TrackMy…), the product area on GetSign (Editor, Email…). */
  project: string | null;
  createdAt: number;
  updatedAt: number;
  creator: string | null;
  posts: DevPost[];
  changes: StatusChange[];
}

// ── What a conversation taught (lib/dev-board-mine.ts writes these) ──

export const MINED_KINDS = [
  "bug",
  "usage_or_setup",
  "knowledge_gap",
  "feature_request",
  "account_or_billing",
  "not_an_issue",
  "unclear",
] as const;
export type MinedKind = (typeof MINED_KINDS)[number];

export const KIND_LABEL: Record<MinedKind, string> = {
  bug: "Real bug",
  usage_or_setup: "Setup or usage",
  knowledge_gap: "Knowledge gap",
  feature_request: "Feature request",
  account_or_billing: "Account or billing",
  not_an_issue: "Not an issue",
  unclear: "Unclear",
};

export const FRICTIONS = [
  "missing_info",
  "slow_engineering_reply",
  "slow_support_reply",
  "fix_failed_testing",
  "customer_unresponsive",
  "unclear_ownership",
] as const;
export type Friction = (typeof FRICTIONS)[number];

export const FRICTION_LABEL: Record<Friction, string> = {
  missing_info: "Filed without enough to reproduce",
  slow_engineering_reply: "Engineering slow to reply",
  slow_support_reply: "Support slow to reply",
  fix_failed_testing: "Fix failed testing",
  customer_unresponsive: "Customer went quiet",
  unclear_ownership: "Nobody clearly owned it",
};

export interface MinedItem {
  /** Hash of the thread this was read from; a new comment re-mines. */
  hash: string;
  at: number;
  model: string;
  kind: MinedKind;
  /** The app, named as customers know it. */
  app: string;
  /** 2–4 words, reused across items so a pattern can show. */
  area: string;
  rootCause: string | null;
  resolution: string | null;
  /** What support or Jetta could tell the next customer without a developer. */
  lesson: string | null;
  kbWorthy: boolean;
  kbTitle: string | null;
  friction: Friction[];
  /** Closest PUBLISHED KB article to the lesson, when one is close. */
  kb: { id: string; title: string; score: number } | null;
  /** A draft article someone made from this item on /dev-board. */
  kbDraftId?: string;
}

// ── Classification ──────────────────────────────────────────────────

/**
 * Statuses that end engineering's part. Wider than devItemInFlight's list
 * (lib/tools/monday.ts), on purpose: that one asks "may the customer's ticket
 * close", where GetSign's "Done" (code done, not deployed) must still count as
 * open. Here the question is "has engineering finished the work", and "Done"
 * is exactly that.
 */
export const RESOLVED_STATUS = /^(done|deployed to prod|test passed on prod|archived|not an issue|not bug|not a bug|could not replicate|duplicated)$/i;
export const CLOSED_GROUP = /^(done|deployed|archive)/i;
/** The customer has the next move — support asked them something. */
export const CUSTOMER_STATUS = /^(waiting customer|need more info)$/i;
/** Engineering asking support to check — the move passes even without a comment. */
export const HANDOFF_STATUS = /^(ready for review|ready for review qa|test(ing)? passed on (dev|qa))$/i;
/** A fix that came back. */
export const BOUNCE_STATUS = /^(testing failed|re-opened)$/i;
/** Jetta's own posts on an item. Everything else from her token is a person. */
const JETTA_POST = /^(Product:|Follow-up from the SAME Freshdesk ticket)/;
/**
 * Support chasing engineering. Read off real threads: "are there any
 * updates?", "did you find anything?", "any news on this".
 */
const NUDGE = /\b(any (updates?|news|progress)|are there any updates|did you (find|get a chance)|following up|just checking|still (not|waiting|broken)|update on this)\b/i;

export type Role = "support" | "jetta" | "engineering";

/** An engineering comment that puts something to support: a question, or an @mention of one of them. */
export function asksSupport(text: string, roster: Roster): boolean {
  if (text.includes("?")) return true;
  return [...text.matchAll(/@([A-Za-z]+)/g)].some((m) => roster.support.has(m[1].toLowerCase()));
}

export interface Roster {
  /** Support people's first names, lowercase. */
  support: Set<string>;
  /** The monday user Jetta's token belongs to. */
  self: string;
}

const first = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

export function parseSupport(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => first(s))
      .filter(Boolean),
  );
}

export function isSupport(name: string | null | undefined, roster: Roster): boolean {
  return !!name && roster.support.has(first(name));
}

export function postRole(p: Pick<DevPost, "who" | "text">, roster: Roster): Role {
  if (p.who === roster.self && JETTA_POST.test(p.text)) return "jetta";
  return isSupport(p.who, roster) ? "support" : "engineering";
}

/**
 * One display name per person. monday has "Cherryl" and "Cherryl B" as two
 * users; first names line up the way /activity's identities do. The most
 * frequent spelling wins — longest picked "Prashant test account" over
 * "Prashant Uprety". Pass every occurrence, duplicates included.
 */
export function canonicalNames(names: Iterable<string>): Map<string, string> {
  const freq = new Map<string, number>();
  for (const n of names) if (n && n !== "Deleted member") freq.set(n, (freq.get(n) ?? 0) + 1);
  const best = new Map<string, string>();
  for (const [n, c] of freq) {
    const k = first(n);
    const cur = best.get(k);
    if (!cur || c > freq.get(cur)! || (c === freq.get(cur)! && n.length > cur.length)) best.set(k, n);
  }
  const out = new Map<string, string>();
  for (const n of freq.keys()) out.set(n, best.get(first(n))!);
  return out;
}

export type Origin = "jetta" | "support" | "internal";

/** Who brought the item to the board. Only the first two are client issues. */
export function itemOrigin(item: Pick<DevItem, "posts" | "creator" | "reporter">, roster: Roster): Origin {
  const firstPost = item.posts[0];
  if (firstPost && postRole(firstPost, roster) === "jetta") return "jetta";
  if (isSupport(item.creator, roster)) return "support";
  if ((item.reporter ?? "").split(",").some((r) => isSupport(r, roster))) return "support";
  return "internal";
}

export function isResolvedNow(item: Pick<DevItem, "group" | "status">): boolean {
  return CLOSED_GROUP.test(item.group.trim()) || RESOLVED_STATUS.test((item.status ?? "").trim());
}

const resolving = (c: StatusChange) =>
  c.kind === "status" ? RESOLVED_STATUS.test(c.to.trim()) : CLOSED_GROUP.test(c.to.trim());
const reopening = (c: StatusChange) => c.kind === "status" && !RESOLVED_STATUS.test(c.to.trim());

/**
 * When engineering finished it: the first resolving change after the last
 * time it was reopened. Null when it is open, or finished before the log we
 * hold reaches back (no time to put on it).
 */
export function resolvedAt(item: Pick<DevItem, "group" | "status" | "changes">): number | null {
  if (!isResolvedNow(item)) return null;
  const ch = [...item.changes].sort((a, b) => a.at - b.at);
  let lastOpen = -1;
  ch.forEach((c, i) => {
    if (reopening(c)) lastOpen = i;
  });
  const done = ch.slice(lastOpen + 1).find(resolving);
  return done?.at ?? null;
}

/** A person's action on an item: a comment, or a status/group change. */
interface Action {
  at: number;
  who: string;
  role: Role;
  kind: "post" | "change";
  text?: string;
  to?: string;
}

function actions(item: DevItem, roster: Roster): Action[] {
  const out: Action[] = [
    ...item.posts.map((p) => ({ at: p.at, who: p.who, role: postRole(p, roster), kind: "post" as const, text: p.text })),
    ...item.changes
      .filter((c) => c.by)
      .map((c) => ({
        at: c.at,
        who: c.by,
        // A status change from Jetta's token is Suraj, never Jetta: she never sets statuses.
        role: (isSupport(c.by, roster) ? "support" : "engineering") as Role,
        kind: "change" as const,
        to: c.to,
      })),
  ];
  return out.sort((a, b) => a.at - b.at);
}

/** Whose move an open item is on. */
export type Move = "engineering" | "support" | "customer";

export interface ReplyGap {
  /** Who answered. */
  who: string;
  role: Role;
  /** When the other side spoke. */
  from: number;
  at: number;
}

/** Everything the page shows about one item. ~0.5 KB; the drill sheet reads these. */
export interface DevRow {
  id: string;
  board: BoardKey;
  app: string;
  name: string;
  url: string;
  group: string;
  status: string | null;
  origin: Origin;
  filedBy: string | null;
  developers: string[];
  /** Support people who wrote on it. */
  support: string[];
  createdAt: number;
  resolvedAt: number | null;
  /** First engineering comment or status change after it was filed. */
  firstEngAt: number | null;
  move: Move | null;
  /** When the current move began (open items). */
  waitingSince: number | null;
  lastActionAt: number;
  nudgeAts: number[];
  bounceAts: number[];
  customerWaits: number;
  /** Answers across the support/engineering line, both directions. */
  gaps: ReplyGap[];
  posts: number;
  kind: MinedKind | null;
  area: string | null;
  rootCause: string | null;
  lesson: string | null;
  kbTitle: string | null;
  kbWorthy: boolean;
  kb: MinedItem["kb"];
  kbDraftId: string | null;
  friction: Friction[];
}

const GETSIGN = "GetSign";

/** The app as customers know it. Never the portfolio label. */
export function appOf(item: Pick<DevItem, "board" | "project">, mined?: Pick<MinedItem, "app"> | null): string {
  if (item.board === "getsign") return GETSIGN;
  const p = (item.project ?? "").trim();
  if (p) return /^vlookup/i.test(p) ? "VLOOKUP Auto-Link" : p;
  const m = (mined?.app ?? "").trim();
  return m && !/jetpack ?apps/i.test(m) ? m : "App not set";
}

export function devRow(item: DevItem, roster: Roster, names: Map<string, string>, mined: MinedItem | null): DevRow {
  const name = (n: string) => names.get(n) ?? n;
  const acts = actions(item, roster);
  const humans = acts.filter((a) => a.role !== "jetta");
  const origin = itemOrigin(item, roster);
  const firstEng = acts.find((a) => a.role === "engineering" && a.at > item.createdAt && a.who !== item.creator);

  // Reply gaps: each time one side speaks after the other, the first answer.
  const gaps: ReplyGap[] = [];
  let waitingFrom: { role: Role; at: number } | null = null;
  for (const a of acts) {
    const side: Role = a.role === "jetta" ? "support" : a.role;
    if (waitingFrom && waitingFrom.role !== side) {
      gaps.push({ who: name(a.who), role: side, from: waitingFrom.at, at: a.at });
      waitingFrom = { role: side, at: a.at };
    } else if (!waitingFrom) {
      waitingFrom = { role: side, at: a.at };
    }
  }

  const resolved = resolvedAt(item);
  const open = !isResolvedNow(item);
  let move: Move | null = null;
  let waitingSince: number | null = null;
  if (open) {
    const last = humans[humans.length - 1];
    // Engineering keeps the move with its own queue statuses (Ready to start,
    // Working on it) and with progress notes ("I will look at this today"). It
    // passes with a question, an @mention of support, or a status asking support to check.
    const passes =
      last?.role === "engineering" &&
      (last.kind === "post" ? asksSupport(last.text ?? "", roster) : HANDOFF_STATUS.test((last.to ?? "").trim()));
    if (CUSTOMER_STATUS.test((item.status ?? "").trim())) {
      move = "customer";
      const set = [...item.changes].reverse().find((c) => c.kind === "status" && CUSTOMER_STATUS.test(c.to.trim()));
      waitingSince = set?.at ?? last?.at ?? item.createdAt;
    } else if (!passes) {
      move = "engineering";
      // Since the first support/Jetta action engineering hasn't answered with a comment.
      const lastEngPost = [...acts].reverse().find((a) => a.role === "engineering" && a.kind === "post");
      const unanswered = acts.find((a) => a.role !== "engineering" && (!lastEngPost || a.at > lastEngPost.at));
      waitingSince = unanswered?.at ?? last?.at ?? item.createdAt;
    } else {
      move = "support";
      const lastOther = [...acts].reverse().find((a) => a.role !== "engineering");
      const after = acts.find((a) => a.role === "engineering" && (!lastOther || a.at > lastOther.at));
      waitingSince = after?.at ?? last!.at;
    }
  }

  const supportPeople = [...new Set(humans.filter((a) => a.role === "support").map((a) => name(a.who)))];
  return {
    id: item.id,
    board: item.board,
    app: appOf(item, mined),
    name: item.name,
    url: item.url,
    group: item.group,
    status: item.status,
    origin,
    filedBy: origin === "jetta" ? "Jetta" : item.creator ? name(item.creator) : null,
    developers: item.developers.filter((d) => d !== "Deleted member").map(name),
    support: supportPeople,
    createdAt: item.createdAt,
    resolvedAt: resolved,
    firstEngAt: firstEng?.at ?? null,
    move,
    waitingSince,
    lastActionAt: Math.max(item.createdAt, ...humans.map((a) => a.at)),
    nudgeAts: acts.filter((a) => a.role === "support" && a.kind === "post" && NUDGE.test(a.text ?? "")).map((a) => a.at),
    bounceAts: item.changes.filter((c) => c.kind === "status" && BOUNCE_STATUS.test(c.to.trim())).map((c) => c.at),
    customerWaits: item.changes.filter((c) => c.kind === "status" && CUSTOMER_STATUS.test(c.to.trim())).length,
    gaps,
    posts: humans.filter((a) => a.kind === "post").length,
    kind: mined?.kind ?? null,
    area: mined?.area ?? null,
    rootCause: mined?.rootCause ?? null,
    lesson: mined?.lesson ?? null,
    kbTitle: mined?.kbTitle ?? null,
    kbWorthy: mined?.kbWorthy ?? false,
    kb: mined?.kb ?? null,
    kbDraftId: mined?.kbDraftId ?? null,
    friction: mined?.friction ?? [],
  };
}

// ── Summary ─────────────────────────────────────────────────────────

export const WINDOW_DAYS = 28;
const DAY = 86_400_000;
/** Open, and nobody has touched it in this long. */
export const STALE_DAYS = 14;
/**
 * Open but untouched this long: backlog, not work in progress. The live groups
 * hold client issues from 2023 nobody has looked at since; counted in "open",
 * they made every wait time read as hundreds of days.
 */
export const DORMANT_DAYS = 90;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hours = (ms: number) => +(ms / 3_600_000).toFixed(1);
const days = (ms: number) => +(ms / DAY).toFixed(1);

export const isClient = (r: Pick<DevRow, "origin">) => r.origin !== "internal";
/** Open and touched within DORMANT_DAYS — work in progress. */
export const isActive = (r: DevRow, now: number) => !!r.move && now - r.lastActionAt <= DORMANT_DAYS * DAY;
export const isDormant = (r: DevRow, now: number) => !!r.move && now - r.lastActionAt > DORMANT_DAYS * DAY;
export const isStale = (r: DevRow, now: number) => isActive(r, now) && now - r.lastActionAt > STALE_DAYS * DAY;
const inWin = (t: number | null, from: number, to: number) => t != null && t >= from && t < to;

export interface PeriodStats {
  filed: number;
  filedByJetta: number;
  resolved: number;
  /** Median hours to the first engineering response, items filed in the period. */
  firstEngH: number | null;
  /** Median days filed → resolved, items resolved in the period. */
  cycleDays: number | null;
  bounced: number;
  nudges: number;
}

function period(rows: DevRow[], from: number, to: number): PeriodStats {
  const c = rows.filter(isClient);
  const filed = c.filter((r) => inWin(r.createdAt, from, to));
  const resolved = c.filter((r) => inWin(r.resolvedAt, from, to));
  return {
    filed: filed.length,
    filedByJetta: filed.filter((r) => r.origin === "jetta").length,
    resolved: resolved.length,
    firstEngH: (() => {
      const m = median(filed.filter((r) => r.firstEngAt != null).map((r) => r.firstEngAt! - r.createdAt));
      return m == null ? null : hours(m);
    })(),
    cycleDays: (() => {
      const m = median(resolved.map((r) => r.resolvedAt! - r.createdAt));
      return m == null ? null : days(m);
    })(),
    bounced: c.filter((r) => r.bounceAts.some((t) => inWin(t, from, to))).length,
    nudges: c.reduce((n, r) => n + r.nudgeAts.filter((t) => inWin(t, from, to)).length, 0),
  };
}

export interface DevPerson {
  name: string;
  open: number;
  openClient: number;
  stale: number;
  resolved: number;
  resolvedClient: number;
  cycleDays: number | null;
  /** Median hours this person took to answer support, last 28 days. */
  replyH: number | null;
  replies: number;
  bounced: number;
}

export interface SupportPerson {
  name: string;
  filed: number;
  nudges: number;
  /** Median hours this person took to answer engineering, last 28 days. */
  replyH: number | null;
  replies: number;
  /** Open client issues waiting on support that this person is on. */
  yourMove: number;
  customerWaiting: number;
}

export interface Pattern {
  app: string;
  area: string;
  recent: number;
  prior: number;
  total: number;
  kinds: Partial<Record<MinedKind, number>>;
  /** Root causes as written, newest first, deduped. */
  causes: string[];
}

export interface DevBoardSummary {
  computedAt: number;
  windowDays: number;
  items: number;
  clientItems: number;
  recent: PeriodStats;
  previous: PeriodStats;
  now: {
    open: number;
    stale: number;
    /** Open but untouched for DORMANT_DAYS — not in `open`. */
    dormant: number;
    engineering: number;
    support: number;
    customer: number;
    /** Median days the open items on each side have waited. */
    engineeringWaitDays: number | null;
    supportWaitDays: number | null;
  };
  developers: DevPerson[];
  supportTeam: SupportPerson[];
  weeks: { week: string; filed: number; resolved: number; firstEngH: number | null }[];
  mined: {
    total: number;
    pending: number;
    kinds: Partial<Record<MinedKind, number>>;
    friction: Partial<Record<Friction, number>>;
    lessons: number;
    lessonsNotInKb: number;
  };
  patterns: Pattern[];
  boards: Record<string, string>;
}

/** Monday of the week, YYYY-MM-DD, UTC. */
export function weekStart(at: number): string {
  const d = new Date(at);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function buildSummary(
  rows: DevRow[],
  opts: { now: number; minedPending: number; boards: Record<string, string> },
): DevBoardSummary {
  const { now } = opts;
  const w = WINDOW_DAYS * DAY;
  const from = now - w;
  const client = rows.filter(isClient);
  const open = client.filter((r) => isActive(r, now));
  const stale = (r: DevRow) => isStale(r, now);
  const waitDays = (xs: DevRow[]) => {
    const m = median(xs.map((r) => now - (r.waitingSince ?? r.createdAt)));
    return m == null ? null : days(m);
  };

  // Developers: by the Developer column, all work; client issues called out.
  const devs = new Map<string, DevRow[]>();
  for (const r of rows) for (const d of r.developers) devs.set(d, [...(devs.get(d) ?? []), r]);
  const developers: DevPerson[] = [...devs.entries()]
    .map(([name, rs]) => {
      const answered = rows.flatMap((r) => r.gaps).filter((g) => g.who === name && g.role === "engineering" && g.at >= from);
      const resolved = rs.filter((r) => inWin(r.resolvedAt, from, now));
      const cyc = median(resolved.filter(isClient).map((r) => r.resolvedAt! - r.createdAt));
      const rm = median(answered.map((g) => g.at - g.from));
      return {
        name,
        open: rs.filter((r) => isActive(r, now)).length,
        openClient: rs.filter((r) => isActive(r, now) && isClient(r)).length,
        stale: rs.filter(stale).length,
        resolved: resolved.length,
        resolvedClient: resolved.filter(isClient).length,
        cycleDays: cyc == null ? null : days(cyc),
        replyH: rm == null ? null : hours(rm),
        replies: answered.length,
        bounced: rs.filter((r) => r.bounceAts.some((t) => t >= from)).length,
      };
    })
    .filter((d) => d.open || d.resolved || d.replies)
    .sort((a, b) => b.resolved + b.open - (a.resolved + a.open));

  const supportNames = new Set(rows.flatMap((r) => r.support));
  // Support people are sometimes put in the Developer column (to test, or to own a
  // follow-up). Their work is counted in the support table, not here.
  const engineers = developers.filter((d) => !supportNames.has(d.name));
  const supportTeam: SupportPerson[] = [...supportNames]
    .map((name) => {
      const answered = rows.flatMap((r) => r.gaps).filter((g) => g.who === name && g.role === "support" && g.at >= from);
      const rm = median(answered.map((g) => g.at - g.from));
      const mine = open.filter((r) => r.support.includes(name) || r.filedBy === name);
      return {
        name,
        filed: client.filter((r) => r.filedBy === name && r.createdAt >= from).length,
        nudges: rows.filter((r) => r.support.includes(name)).reduce((n, r) => n + r.nudgeAts.filter((t) => t >= from).length, 0),
        replyH: rm == null ? null : hours(rm),
        replies: answered.length,
        yourMove: mine.filter((r) => r.move === "support").length,
        customerWaiting: mine.filter((r) => r.move === "customer").length,
      };
    })
    .sort((a, b) => b.filed + b.replies - (a.filed + a.replies));

  // Weekly, 12 full weeks plus this one.
  const weeks: DevBoardSummary["weeks"] = [];
  for (let i = 12; i >= 0; i--) {
    const week = weekStart(now - i * 7 * DAY);
    const ws = Date.parse(`${week}T00:00:00Z`);
    const we = ws + 7 * DAY;
    const filed = client.filter((r) => inWin(r.createdAt, ws, we));
    const m = median(filed.filter((r) => r.firstEngAt != null).map((r) => r.firstEngAt! - r.createdAt));
    weeks.push({
      week,
      filed: filed.length,
      resolved: client.filter((r) => inWin(r.resolvedAt, ws, we)).length,
      firstEngH: m == null ? null : hours(m),
    });
  }

  // What the conversations add up to.
  const mined = client.filter((r) => r.kind);
  const kinds: Partial<Record<MinedKind, number>> = {};
  const friction: Partial<Record<Friction, number>> = {};
  for (const r of mined) {
    kinds[r.kind!] = (kinds[r.kind!] ?? 0) + 1;
    for (const f of r.friction) friction[f] = (friction[f] ?? 0) + 1;
  }
  const lessons = mined.filter((r) => r.lesson && r.kbWorthy);

  return {
    computedAt: now,
    windowDays: WINDOW_DAYS,
    items: rows.length,
    clientItems: client.length,
    recent: period(rows, from, now),
    previous: period(rows, from - w, from),
    now: {
      open: open.length,
      stale: open.filter(stale).length,
      dormant: client.filter((r) => isDormant(r, now)).length,
      engineering: open.filter((r) => r.move === "engineering").length,
      support: open.filter((r) => r.move === "support").length,
      customer: open.filter((r) => r.move === "customer").length,
      engineeringWaitDays: waitDays(open.filter((r) => r.move === "engineering")),
      supportWaitDays: waitDays(open.filter((r) => r.move === "support")),
    },
    developers: engineers,
    supportTeam,
    weeks,
    mined: {
      total: mined.length,
      pending: opts.minedPending,
      kinds,
      friction,
      lessons: lessons.length,
      lessonsNotInKb: lessons.filter((r) => !r.kb && !r.kbDraftId).length,
    },
    patterns: buildPatterns(client, now),
    boards: opts.boards,
  };
}

/**
 * Recurring areas: the same app + area on more than one client issue. The
 * miner is handed each app's existing areas and told to reuse one when it
 * fits, so a match on the normalised label is a real repeat, not a guess.
 */
export function buildPatterns(client: DevRow[], now: number): Pattern[] {
  const w = WINDOW_DAYS * DAY;
  const by = new Map<string, DevRow[]>();
  for (const r of client) {
    if (!r.area) continue;
    const k = `${r.app}\u0000${norm(r.area)}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()]
    .filter((rs) => rs.length >= 2)
    .map((rs) => {
      const sorted = [...rs].sort((a, b) => b.createdAt - a.createdAt);
      const kinds: Partial<Record<MinedKind, number>> = {};
      for (const r of rs) if (r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      const seen = new Set<string>();
      const causes: string[] = [];
      for (const r of sorted) {
        const c = r.rootCause?.trim();
        if (c && !seen.has(norm(c))) {
          seen.add(norm(c));
          causes.push(c);
        }
      }
      return {
        app: rs[0].app,
        area: sorted[0].area!,
        recent: rs.filter((r) => r.createdAt >= now - w).length,
        prior: rs.filter((r) => r.createdAt >= now - 2 * w && r.createdAt < now - w).length,
        total: rs.length,
        kinds,
        causes: causes.slice(0, 3),
      };
    })
    .sort((a, b) => b.recent - a.recent || b.total - a.total)
    .slice(0, 20);
}

// ── Drill-down: the items behind a number ───────────────────────────

export type DevDrill =
  | { kind: "filed" | "resolved" | "firstEng" | "cycle" | "bounced" | "nudges" }
  | { kind: "open"; move?: Move; stale?: boolean }
  | { kind: "dormant" }
  | { kind: "dev"; person: string; metric: "open" | "resolved" | "stale" | "replies" | "bounced" }
  | { kind: "support"; person: string; metric: "filed" | "yourMove" | "customer" | "nudges" | "replies" }
  | { kind: "pattern"; app: string; area: string }
  | { kind: "mined"; mined: MinedKind | "lessons" | "lessonsNotInKb" }
  | { kind: "friction"; friction: Friction }
  | { kind: "week"; week: string; metric: "filed" | "resolved" };

/**
 * Pure, so the headline numbers and the lists behind them come from one place
 * — scripts/dev-board-test.ts checks each drill adds up to its number.
 */
export function drillRows(rows: DevRow[], d: DevDrill, now: number): DevRow[] {
  const from = now - WINDOW_DAYS * DAY;
  const client = rows.filter(isClient);
  const open = client.filter((r) => isActive(r, now));
  const newest = (xs: DevRow[]) => xs.sort((a, b) => b.createdAt - a.createdAt);
  const longest = (xs: DevRow[]) => xs.sort((a, b) => (a.waitingSince ?? a.createdAt) - (b.waitingSince ?? b.createdAt));
  switch (d.kind) {
    case "filed":
      return newest(client.filter((r) => r.createdAt >= from));
    case "resolved":
      return client.filter((r) => inWin(r.resolvedAt, from, now)).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
    case "firstEng":
      return client
        .filter((r) => r.createdAt >= from)
        .sort((a, b) => (b.firstEngAt ?? now) - b.createdAt - ((a.firstEngAt ?? now) - a.createdAt));
    case "cycle":
      return client
        .filter((r) => inWin(r.resolvedAt, from, now))
        .sort((a, b) => b.resolvedAt! - b.createdAt - (a.resolvedAt! - a.createdAt));
    case "bounced":
      return newest(client.filter((r) => r.bounceAts.some((t) => inWin(t, from, now))));
    case "nudges":
      return newest(client.filter((r) => r.nudgeAts.some((t) => inWin(t, from, now))));
    case "open":
      return longest(open.filter((r) => (!d.move || r.move === d.move) && (!d.stale || isStale(r, now))));
    case "dormant":
      return client.filter((r) => isDormant(r, now)).sort((a, b) => b.lastActionAt - a.lastActionAt);
    case "dev": {
      const mine = rows.filter((r) => r.developers.includes(d.person));
      if (d.metric === "open") return longest(mine.filter((r) => isActive(r, now)));
      if (d.metric === "stale") return longest(mine.filter((r) => isStale(r, now)));
      if (d.metric === "resolved") return mine.filter((r) => inWin(r.resolvedAt, from, now)).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
      if (d.metric === "bounced") return newest(mine.filter((r) => r.bounceAts.some((t) => t >= from)));
      return newest(rows.filter((r) => r.gaps.some((g) => g.who === d.person && g.role === "engineering" && g.at >= from)));
    }
    case "support": {
      const on = open.filter((r) => r.support.includes(d.person) || r.filedBy === d.person);
      if (d.metric === "filed") return newest(client.filter((r) => r.filedBy === d.person && r.createdAt >= from));
      if (d.metric === "yourMove") return longest(on.filter((r) => r.move === "support"));
      if (d.metric === "customer") return longest(on.filter((r) => r.move === "customer"));
      if (d.metric === "nudges") return newest(rows.filter((r) => r.support.includes(d.person) && r.nudgeAts.some((t) => t >= from)));
      return newest(rows.filter((r) => r.gaps.some((g) => g.who === d.person && g.role === "support" && g.at >= from)));
    }
    case "pattern":
      return newest(client.filter((r) => r.app === d.app && r.area != null && norm(r.area) === norm(d.area)));
    case "mined":
      if (d.mined === "lessons") return newest(client.filter((r) => r.kind && r.lesson && r.kbWorthy));
      if (d.mined === "lessonsNotInKb") return newest(client.filter((r) => r.kind && r.lesson && r.kbWorthy && !r.kb && !r.kbDraftId));
      return newest(client.filter((r) => r.kind === d.mined));
    case "friction":
      return newest(client.filter((r) => r.kind && r.friction.includes(d.friction)));
    case "week": {
      const ws = Date.parse(`${d.week}T00:00:00Z`);
      const we = ws + 7 * DAY;
      return d.metric === "filed"
        ? newest(client.filter((r) => inWin(r.createdAt, ws, we)))
        : client.filter((r) => inWin(r.resolvedAt, ws, we)).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
    }
  }
}

// ── Mining input ────────────────────────────────────────────────────

/** Which items are worth reading for lessons: client issues with a human conversation. */
export function wantsMining(row: DevRow): boolean {
  return isClient(row) && row.posts >= 2;
}

/** Stable hash of what the miner reads — re-mine only when the thread or outcome moved. */
export function threadHash(item: DevItem): string {
  const s = `${item.status}|${item.group}|${item.posts.map((p) => p.id).join(",")}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The thread as the miner and the KB drafter read it, oldest first, roles named. */
export function threadText(item: DevItem, roster: Roster, names: Map<string, string>): string {
  const lines = [
    `Item: ${item.name}`,
    `Board: ${item.board === "getsign" ? "GetSign" : "Jetpack Apps dev tasks"}${item.project ? ` · Project: ${item.project}` : ""}`,
    `Group: ${item.group} · Dev Status now: ${item.status ?? "(blank)"}`,
    "",
  ];
  const events = [
    ...item.posts.map((p) => {
      const role = postRole(p, roster);
      const who = role === "jetta" ? "Jetta (AI support agent)" : `${names.get(p.who) ?? p.who} (${role})`;
      return { at: p.at, line: `${p.parentId ? "  ↳ " : ""}${who}: ${p.text}` };
    }),
    ...item.changes.map((c) => ({
      at: c.at,
      line: `  [${c.kind === "status" ? "Dev Status" : "moved to group"} → ${c.to}${c.by ? ` by ${names.get(c.by) ?? c.by}` : ""}]`,
    })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) lines.push(`${new Date(e.at).toISOString().slice(0, 10)} ${e.line}`);
  return lines.join("\n");
}
