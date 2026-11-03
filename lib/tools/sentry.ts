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
let gapCache: { at: number; since: string | null } | null = null;
export async function storageGap(): Promise<string | null> {
  if (gapCache && Date.now() - gapCache.at < 3_600_000) return gapCache.since;
  try {
    const d = await get<{
      intervals: string[];
      groups: { by: { outcome: string }; series: Record<string, number[]> }[];
    }>(`/organizations/${config.sentry.org}/stats_v2/?field=sum(quantity)&category=error&statsPeriod=30d&interval=1d&groupBy=outcome`);
    const series = (o: string) => d.groups.find((g) => g.by.outcome === o)?.series["sum(quantity)"] ?? [];
    const accepted = series("accepted");
    const dropped = d.intervals.map((_, i) => (series("rate_limited")[i] ?? 0) + (series("client_discard")[i] ?? 0));
    let last = -1;
    accepted.forEach((n, i) => {
      if (n > 0) last = i;
    });
    // Today is partial, so a gap counts only once a whole day stored nothing
    // while errors were still arriving and being turned away.
    const after = last + 1;
    const gap = after <= d.intervals.length - 2 && dropped.slice(after).some((n) => n > 0);
    const since = gap ? d.intervals[after].slice(0, 10) : null;
    gapCache = { at: Date.now(), since };
    return since;
  } catch {
    return null;
  }
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
