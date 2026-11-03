/**
 * The apps' error tracker, Sentry (jetpackapps.sentry.io). READ-ONLY.
 *
 * The token is an internal integration ("Jetta (read-only)") with Project,
 * Issue & Event and Organization set to Read and nothing else, so nothing here
 * can resolve, assign, delete or mute an issue, whatever the code below says.
 *
 * Two callers, as with the CloudWatch logs (./cloudwatch.ts):
 *   - `search_sentry` in lib/assistant-tools.ts, for colleagues (Slack DM
 *     assistant, console assistant).
 *   - `sentryEvidence`, called by create_dev_item so a bug report carries the
 *     Sentry issues tagged with that customer's monday account. The ticket
 *     agent never sees the result, so nothing from Sentry reaches a customer.
 *
 * Only the projects in SENTRY_PROJECTS can be searched; the model picks an
 * app, never a project. Which projects tag errors with the customer:
 *   getsign-be  accountId + slug        (monday account id + account slug)
 *   extract-be  account_id + account_slug
 *   jobflow     userId + boardId
 * The frontends (getsign-application, getsign-item-view, vlookup-frontend)
 * carry no account, only an IP, so they answer "what is breaking in the app",
 * never "what is breaking for this customer".
 *
 * Trap: nearly every getsign-be issue is status "resolved" (auto-resolve), yet
 * still firing. Never filter on is:unresolved; a resolved issue whose lastSeen
 * is recent is a live error.
 */
import { config } from "../config";
import { cleanTerm, redact } from "./cloudwatch";

interface SentryProject {
  slug: string;
  /** Browser code: errors carry no account, and help only by app and release. */
  frontend?: boolean;
  /** Tag keys this project sets, by meaning. */
  tags?: { account?: string; slug?: string; user?: string; board?: string };
}

export const SENTRY_PROJECTS: Record<string, { label: string; projects: SentryProject[] }> = {
  getsign: {
    label: "GetSign",
    projects: [
      { slug: "getsign-be", tags: { account: "accountId", slug: "slug" } },
      { slug: "getsign-application", frontend: true },
      { slug: "getsign-item-view", frontend: true },
      { slug: "signserver" },
    ],
  },
  extract: {
    label: "Extract AI",
    projects: [{ slug: "extract-be", tags: { account: "account_id", slug: "account_slug" } }],
  },
  jobflows: { label: "JobFlows", projects: [{ slug: "jobflow", tags: { user: "userId", board: "boardId" } }] },
  vlookup: {
    label: "VLOOKUP Auto-Link",
    projects: [{ slug: "vlookup-backend" }, { slug: "vlookup-frontend", frontend: true }],
  },
  trackmy: { label: "TrackMy", projects: [{ slug: "trackmy" }] },
  hashtask: { label: "Hashtask", projects: [{ slug: "hashtask" }] },
};

export type SentryApp = keyof typeof SENTRY_PROJECTS;
export const SENTRY_APPS = Object.keys(SENTRY_PROJECTS) as [SentryApp, ...SentryApp[]];

export function sentryEnabled(): boolean {
  const c = config.sentry;
  return c.enabled && !!c.token;
}

const API = "https://sentry.io/api/0";

async function get<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${config.sentry.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Sentry ${res.status} on ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

/** Project slug → numeric id, cached for an hour. The issues endpoint wants ids. */
let projectCache: { at: number; ids: Map<string, string> } | null = null;
async function projectIds(): Promise<Map<string, string>> {
  if (projectCache && Date.now() - projectCache.at < 3_600_000) return projectCache.ids;
  const list = await get<{ id: string; slug: string }[]>(`/organizations/${config.sentry.org}/projects/?all_projects=1`);
  const ids = new Map(list.map((p) => [p.slug, p.id]));
  projectCache = { at: Date.now(), ids };
  return ids;
}

/**
 * When Sentry stopped STORING errors, if it has. Over its error quota, Sentry
 * rate-limits every new error, so from that day nothing new is recorded and a
 * search that finds nothing proves nothing. Seen 2026-11-03: zero errors
 * accepted in any project since 2026-10-26 (and likewise before 2026-10-07),
 * all rate-limited or dropped by the SDKs. Org-wide, cached for an hour; null
 * when errors are being stored, or when the check itself fails.
 */
let gapCache: { at: number; status: StorageStatus } | null = null;

export interface StorageStatus {
  /** Sentry is not storing errors right now, since this day. */
  notStoringSince: string | null;
  /**
   * Full UTC days in the last 30 on which Sentry stored no error at all while
   * errors were being turned away: their counts are missing, not zero. A
   * trend must skip them, or the day storage resumes reads as a spike.
   */
  gapDays: string[];
}

export async function storageStatus(): Promise<StorageStatus> {
  if (gapCache && Date.now() - gapCache.at < 3_600_000) return gapCache.status;
  try {
    const d = await get<{
      intervals: string[];
      groups: { by: { outcome: string }; series: Record<string, number[]> }[];
    }>(`/organizations/${config.sentry.org}/stats_v2/?field=sum(quantity)&category=error&statsPeriod=30d&interval=1d&groupBy=outcome`);
    const series = (o: string) => d.groups.find((g) => g.by.outcome === o)?.series["sum(quantity)"] ?? [];
    const accepted = series("accepted");
    const dropped = d.intervals.map((_, i) => (series("rate_limited")[i] ?? 0) + (series("client_discard")[i] ?? 0));
    const days = d.intervals.map((x) => x.slice(0, 10));
    // Today is partial: only whole days count as a gap.
    const gapDays = days.filter((_, i) => i < days.length - 1 && !(accepted[i] > 0) && dropped[i] > 0);
    let last = -1;
    accepted.forEach((n, i) => {
      if (n > 0) last = i;
    });
    const after = last + 1;
    const stopped = after <= d.intervals.length - 2 && dropped.slice(after).some((n) => n > 0);
    const status = { notStoringSince: stopped ? days[after] : null, gapDays };
    gapCache = { at: Date.now(), status };
    return status;
  } catch {
    return { notStoringSince: null, gapDays: [] };
  }
}

/**
 * When Sentry stopped STORING errors, if it has. Over its error quota, Sentry
 * rate-limits every new error, so from that day nothing new is recorded and a
 * search that finds nothing proves nothing. Seen 2026-11-03: zero errors
 * accepted in any project from 2026-10-26 until the quota was raised that
 * morning. Null when errors are being stored, or when the check itself fails.
 */
export async function storageGap(): Promise<string | null> {
  return (await storageStatus()).notStoringSince;
}

interface RawIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string;
  level?: string;
  status?: string;
  count: string;
  userCount?: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project: { slug: string };
  /** The issue over its whole life, not just the window: firstSeen here is the real one. */
  lifetime?: { count?: string; firstSeen?: string; lastSeen?: string } | null;
  /** Present when the query filters on event fields (a tag): the matching events only. */
  filtered?: { count: string; userCount?: number; firstSeen?: string; lastSeen?: string } | null;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  project: string;
  title: string;
  where?: string;
  level?: string;
  /** Sentry's status. "resolved" does NOT mean fixed here: see the header. */
  status?: string;
  /** Events in the window, all customers. */
  events: number;
  /** Events in the window for the customer searched, when one was. */
  customerEvents?: number;
  users?: number;
  firstSeen: string;
  lastSeen: string;
  /** Last seen for the customer searched, when one was. */
  customerLastSeen?: string;
  link: string;
  /** Release of the newest event (frontends: a commit sha), when looked up. */
  release?: string | null;
}

export interface SentrySearch {
  app: SentryApp;
  /** monday account id (5-10 digits). */
  accountId?: string;
  /** monday account slug ("acme-co"). */
  accountSlug?: string;
  /** monday user id (JobFlows tags it). */
  userId?: string;
  /** monday board id (JobFlows tags it). */
  boardId?: string;
  /** Words from the error. */
  text?: string;
  /** How far back, 1-30 days. Default 14. */
  days?: number;
  /** End of the window; default now. */
  endAt?: Date;
  limit?: number;
  /** "freq": most events first (default). "date": most recently seen first. */
  sort?: "freq" | "date";
  /** Look up the release of the newest event for the top N issues. */
  releasesFor?: number;
}

export interface SentrySearchResult {
  app: string;
  window: string;
  /** Projects searched. */
  searched: string[];
  /** Projects left out because they do not tag errors with the customer reference given. */
  untagged: string[];
  issues: SentryIssue[];
  /** Projects that failed to answer. */
  failed: string[];
  /** Day Sentry stopped storing errors (quota), if it has: newer errors are missing. */
  notStoringSince: string | null;
}

const ID = /^\d{5,12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function windowParams(days: number, endAt?: Date): string {
  if (!endAt) return `statsPeriod=${days}d`;
  const start = new Date(endAt.getTime() - days * 86_400_000);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(endAt.toISOString())}`;
}

export async function searchIssues(q: SentrySearch): Promise<SentrySearchResult> {
  const entry = SENTRY_PROJECTS[q.app];
  if (!entry) throw new Error(`no Sentry projects for app "${q.app}"`);
  const days = Math.min(Math.max(Math.round(q.days ?? 14), 1), 30);
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 25);
  // A malformed customer reference is an error, not ignored: ignored, the
  // search would quietly widen to every customer and read as theirs.
  const checked = (v: string | undefined, re: RegExp, what: string) => {
    const t = v?.trim().toLowerCase();
    if (!t) return undefined;
    if (!re.test(t)) throw new Error(`"${v}" is not a valid ${what}`);
    return t;
  };
  const accountId = checked(q.accountId, ID, "monday account id (digits)");
  const accountSlug = checked(q.accountSlug, SLUG, "monday account slug");
  const userId = checked(q.userId, ID, "monday user id (digits)");
  const boardId = checked(q.boardId, ID, "monday board id (digits)");
  // Free text: quoted so Sentry reads it as one phrase, and cleaned so it
  // cannot close the quote or add search syntax.
  const text = q.text ? cleanTerm(q.text).replace(/[:"]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (q.text && text.length < 3) throw new Error("search text too short after cleaning; use a word from the error");
  const byCustomer = !!(accountId || accountSlug || userId || boardId);

  const [ids, notStoringSince] = await Promise.all([projectIds(), storageGap()]);
  const searched: string[] = [];
  const untagged: string[] = [];
  const failed: string[] = [];
  const window = windowParams(days, q.endAt);

  const perProject = await Promise.all(
    entry.projects.map(async (p) => {
      // Errors only: the frontends also raise performance issues ("N+1 API
      // Call", "Uncompressed Asset"), which outnumber their errors and are no
      // help to support.
      const parts: string[] = ["issue.category:error"];
      if (accountId) {
        if (!p.tags?.account) return (untagged.push(p.slug), []);
        parts.push(`${p.tags.account}:${accountId}`);
      }
      if (accountSlug) {
        if (!p.tags?.slug) return (untagged.push(p.slug), []);
        parts.push(`${p.tags.slug}:${accountSlug}`);
      }
      if (userId) {
        if (!p.tags?.user) return (untagged.push(p.slug), []);
        parts.push(`${p.tags.user}:${userId}`);
      }
      if (boardId) {
        if (!p.tags?.board) return (untagged.push(p.slug), []);
        parts.push(`${p.tags.board}:${boardId}`);
      }
      if (text) parts.push(`"${text}"`);
      const pid = ids.get(p.slug);
      if (!pid) return (failed.push(p.slug), []);
      searched.push(p.slug);
      const qs = [
        `project=${pid}`,
        window,
        `sort=${q.sort ?? "freq"}`,
        `limit=${limit}`,
        `query=${encodeURIComponent(parts.join(" "))}`,
      ].join("&");
      try {
        return await get<RawIssue[]>(`/organizations/${config.sentry.org}/issues/?${qs}`);
      } catch {
        failed.push(p.slug);
        return [];
      }
    }),
  );

  const issues: SentryIssue[] = perProject.flat().map((i) => {
    const f = byCustomer && i.filtered ? i.filtered : null;
    return {
      id: i.id,
      shortId: i.shortId,
      project: i.project.slug,
      title: redact(i.title).slice(0, 300),
      ...(i.culprit ? { where: redact(i.culprit).slice(0, 160) } : {}),
      level: i.level,
      status: i.status,
      events: Number(i.count) || 0,
      ...(f ? { customerEvents: Number(f.count) || 0, ...(f.lastSeen ? { customerLastSeen: f.lastSeen } : {}) } : {}),
      users: i.userCount,
      firstSeen: i.lifetime?.firstSeen ?? i.firstSeen,
      lastSeen: i.lastSeen,
      link: i.permalink,
    };
  });
  issues.sort((a, b) =>
    q.sort === "date"
      ? (b.customerLastSeen ?? b.lastSeen).localeCompare(a.customerLastSeen ?? a.lastSeen)
      : (b.customerEvents ?? b.events) - (a.customerEvents ?? a.events),
  );
  const top = issues.slice(0, limit);

  const n = Math.min(q.releasesFor ?? 0, top.length, 5);
  await Promise.all(
    top.slice(0, n).map(async (issue) => {
      issue.release = await latestRelease(issue.id).catch(() => null);
    }),
  );

  return {
    app: entry.label,
    window: q.endAt ? `${days}d before ${q.endAt.toISOString()}` : `last ${days}d`,
    searched,
    untagged,
    issues: top,
    failed,
    notStoringSince,
  };
}

async function latestRelease(issueId: string): Promise<string | null> {
  const e = await get<{ release?: { version?: string } | string | null }>(
    `/organizations/${config.sentry.org}/issues/${issueId}/events/latest/`,
    6_000,
  );
  const r = e.release;
  return (typeof r === "string" ? r : r?.version) ?? null;
}

function day(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * The Sentry issues tagged with this customer's monday account, for a dev
 * item. Null when there is nothing to search by, nothing found, or Sentry is
 * off. Never throws: a bug report must not wait on, or fail because of, Sentry.
 */
export async function sentryEvidence(input: {
  app: string | null | undefined;
  accountIds?: string[];
  slugs?: string[];
  days?: number;
  at?: Date;
}): Promise<string | null> {
  if (!sentryEnabled() || !input.app || !(input.app in SENTRY_PROJECTS)) return null;
  const app = input.app as SentryApp;
  if (!SENTRY_PROJECTS[app].projects.some((p) => p.tags?.account || p.tags?.slug)) return null;
  const accounts = [...new Set((input.accountIds ?? []).filter((x) => /^\d{5,10}$/.test(x)))].slice(0, 2);
  const slugs = [...new Set((input.slugs ?? []).map((s) => s.toLowerCase()).filter((s) => SLUG.test(s)))].slice(0, 2);
  if (!accounts.length && !slugs.length) return null;
  const days = input.days ?? 14;
  try {
    // An account id is exact; a slug only when no id is known (a slug can be
    // renamed, and the id search already covers the same events).
    const searches = accounts.length
      ? accounts.map((accountId) => searchIssues({ app, accountId, days, endAt: input.at, limit: 6, releasesFor: 0 }))
      : slugs.map((accountSlug) => searchIssues({ app, accountSlug, days, endAt: input.at, limit: 6, releasesFor: 0 }));
    const results = await Promise.all(searches);
    const seen = new Set<string>();
    const issues = results
      .flatMap((r) => r.issues)
      .filter((i) => !seen.has(i.id) && !!seen.add(i.id))
      .sort((a, b) => (b.customerEvents ?? 0) - (a.customerEvents ?? 0))
      .slice(0, 6);
    const who = accounts.length ? `monday account ${accounts.join(", ")}` : `account ${slugs.join(", ")}`;
    const searched = [...new Set(results.flatMap((r) => r.searched))];
    const gap = results[0]?.notStoringSince;
    const gapNote = gap
      ? `Sentry has stored no errors since ${gap} (over its quota), so anything newer is missing here; the app logs above are the record for that period.`
      : "";
    const head = `${SENTRY_PROJECTS[app].label} Sentry, ${input.at ? `${days}d before ${input.at.toISOString()}` : `last ${days}d`}, ${who} (searched ${searched.join(", ")}; the app's frontend errors carry no account, so they are not here).`;
    if (!issues.length) {
      // With storage off, "nothing found" says nothing about the customer.
      if (gap) return null;
      return `${head}\nNo Sentry issues tagged with this account in that window.`;
    }
    return [
      head,
      ...(gapNote ? [gapNote] : []),
      ...issues.map(
        (i) =>
          `- ${i.shortId} ${i.title}${i.where ? ` (${i.where})` : ""}: ${i.customerEvents ?? "?"} event(s) for this account, last ${day(i.customerLastSeen ?? i.lastSeen)}; ${i.events} across all customers, first seen ${day(i.firstSeen)}${i.status === "resolved" ? ", marked resolved in Sentry" : ""}. ${i.link}`,
      ),
    ].join("\n");
  } catch (e) {
    console.warn(`[sentry] evidence failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** One issue as the error watch sees it: identity, daily counts and lifetime first-seen. */
export interface WatchedIssueRaw {
  id: string;
  shortId: string;
  project: string;
  frontend: boolean;
  title: string;
  where?: string;
  status?: string;
  users: number;
  /** Lifetime first seen (the real one, not clipped to the window). */
  firstSeen: string;
  lastSeen: string;
  link: string;
  /** Events per UTC day, oldest first, the last entry being today so far. */
  daily: number[];
}

/**
 * The most active error issues of one app over the last 14 days, with their
 * daily counts, for the error watch (lib/error-watch.ts). Errors only; status
 * ignored (see the header). `perProject` issues from each project.
 */
export async function watchIssues(app: SentryApp, perProject = 15): Promise<{ issues: WatchedIssueRaw[]; failed: string[] }> {
  const entry = SENTRY_PROJECTS[app];
  const ids = await projectIds();
  const failed: string[] = [];
  const lists = await Promise.all(
    entry.projects.map(async (p) => {
      const pid = ids.get(p.slug);
      if (!pid) return (failed.push(p.slug), []);
      const qs = [
        `project=${pid}`,
        "statsPeriod=14d",
        "groupStatsPeriod=14d",
        "sort=freq",
        `limit=${perProject}`,
        `query=${encodeURIComponent("issue.category:error")}`,
      ].join("&");
      try {
        const raw = await get<(RawIssue & { stats?: Record<string, [number, number][]> })[]>(
          `/organizations/${config.sentry.org}/issues/?${qs}`,
          15_000,
        );
        return raw.map(
          (i): WatchedIssueRaw => ({
            id: i.id,
            shortId: i.shortId,
            project: i.project.slug,
            frontend: !!p.frontend,
            title: redact(i.title).slice(0, 300),
            ...(i.culprit ? { where: redact(i.culprit).slice(0, 160) } : {}),
            status: i.status,
            users: i.userCount ?? 0,
            firstSeen: i.lifetime?.firstSeen ?? i.firstSeen,
            lastSeen: i.lastSeen,
            link: i.permalink,
            daily: (i.stats?.["14d"] ?? []).map((x) => Number(x[1]) || 0),
          }),
        );
      } catch {
        failed.push(p.slug);
        return [];
      }
    }),
  );
  return { issues: lists.flat(), failed };
}

/** A monday account an issue hit, from the issue's own tags. */
export interface IssueAccount {
  id?: string;
  slug?: string;
  events: number;
  lastSeen?: string;
}

type TagValues = { uniqueValues?: number; topValues?: { value: string; count: number; firstSeen?: string; lastSeen?: string }[] };

/**
 * The accounts one issue hit most (top 10 by events) and how many distinct
 * accounts it hit, from the project's account tags. Empty for projects that
 * tag no account (frontends, most small backends).
 */
export async function issueAccounts(issueId: string, project: string): Promise<{ top: IssueAccount[]; distinct: number }> {
  const p = Object.values(SENTRY_PROJECTS)
    .flatMap((e) => e.projects)
    .find((x) => x.slug === project);
  const idKey = p?.tags?.account;
  const slugKey = p?.tags?.slug;
  if (!idKey && !slugKey) return { top: [], distinct: 0 };
  const read = (key?: string) =>
    key ? get<TagValues>(`/organizations/${config.sentry.org}/issues/${issueId}/tags/${key}/`, 10_000).catch(() => null) : Promise.resolve(null);
  const [ids, slugs] = await Promise.all([read(idKey), read(slugKey)]);
  const idVals = (ids?.topValues ?? []).filter((v) => v.value);
  const slugVals = (slugs?.topValues ?? []).filter((v) => v.value);
  // The two tags are set on the same events, so an account's id and slug have
  // the same count and the same first and last sighting: pair on all three.
  const same = (a: { count: number; firstSeen?: string; lastSeen?: string }, b: typeof a) =>
    a.count === b.count && a.firstSeen === b.firstSeen && a.lastSeen === b.lastSeen;
  const used = new Set<number>();
  const top: IssueAccount[] = (idVals.length ? idVals : slugVals).map((v) => {
    if (!idVals.length) return { slug: v.value, events: v.count, lastSeen: v.lastSeen };
    const j = slugVals.findIndex((x, k) => !used.has(k) && same(x, v));
    if (j >= 0) used.add(j);
    return { id: v.value, ...(j >= 0 ? { slug: slugVals[j].value } : {}), events: v.count, lastSeen: v.lastSeen };
  });
  // An empty value is "no account on this event"; it is not an account.
  const src = idVals.length ? ids : slugs;
  const hasBlank = (src?.topValues ?? []).some((v) => !v.value);
  const distinct = Math.max(0, (src?.uniqueValues ?? top.length) - (hasBlank ? 1 : 0));
  return { top: top.slice(0, 10), distinct };
}
