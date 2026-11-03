/**
 * The error watch behind /logs: what the apps' errors are doing, and who they
 * hit. Admin only (the page names customer accounts and shows raw errors).
 *
 * An hourly cron (app/api/cron/error-watch) runs `runErrorWatch`:
 *   1. Sentry: each app's most active error issues over 14 days, with daily
 *      counts (lib/tools/sentry.ts watchIssues).
 *   2. CloudWatch: each app's failure lines per hour, merged into a 14-day
 *      series kept here, so the trend survives a missed run.
 *   3. Flags: an issue is NEW when Sentry first saw it in the last 24h, and
 *      SPIKING when the last 24h ran far above its usual day. Known noise
 *      (our own back-office job, bot scans) is never flagged.
 *   4. Who: for flagged issues, the monday accounts it hit (Sentry tags), the
 *      chat tickets from those accounts, and any dev item that already names it.
 *   5. Proactive: one Slack alert per newly flagged customer-hitting issue
 *      (deduped for 3 days), and a dev item for one that has none, through
 *      JETTA_ERROR_WATCH_DEV_ITEMS: shadow (default) only lists what it would
 *      file; on files it, at most 2 a day.
 *   6. The AI read: written when what is flagged changes, grounded like
 *      /health (every point cites a number on the page).
 *
 * The page reads one key (the summary). Nothing here ever reaches a customer.
 */
import { Redis } from "@upstash/redis";
import { generateObject } from "ai";
import { config } from "./config";
import { bumpDataVersion } from "./data-version";
import { markEventSeen, rateCount, rateCountPeek, unmarkEventSeen } from "./kv";
import { getModel, modelLabel } from "./llm";
import { accountTicketIds } from "./chat-store";
import { devItemsMentioning } from "./dev-board-sync";
import { logOpsEvent } from "./events";
import { insightSchema, reconcileInsight, type Evidence, type Insight } from "./grounded-insight";
import * as freshdesk from "./tools/freshdesk";
import * as monday from "./tools/monday";
import * as slack from "./tools/slack";
import {
  EVIDENCE_NOISE,
  LOG_GROUPS,
  errorCountsByHour,
  groupLines,
  logsEnabled,
  searchLogs,
  type LogApp,
} from "./tools/cloudwatch";
import {
  SENTRY_PROJECTS,
  issueAccounts,
  sentryEnabled,
  storageStatus,
  watchIssues,
  type IssueAccount,
  type SentryApp,
  type WatchedIssueRaw,
} from "./tools/sentry";

// ── Types ───────────────────────────────────────────────────────────

export type WatchFlag = "new" | "spike";

export interface WatchIssue {
  id: string;
  shortId: string;
  app: string;
  appLabel: string;
  project: string;
  frontend: boolean;
  title: string;
  where?: string;
  status?: string;
  link: string;
  firstSeen: string;
  lastSeen: string;
  users: number;
  /** Events per UTC day, oldest first; the last is today so far. */
  daily: number[];
  events24h: number;
  events7d: number;
  /** The usual day: median of the 7 full days before the last 24h. */
  baseline: number;
  flags: WatchFlag[];
  /** Why it is never flagged, when it is known noise. */
  noise?: string;
  /** Filled for flagged issues only (costs a Sentry call each). */
  accounts?: IssueAccount[];
  accountsDistinct?: number;
  /** Chat tickets opened from the accounts it hit. */
  tickets?: { id: string; url: string; status: string | null; slug: string }[];
  /** A dev item that names this issue (its short id or link), or the one the watch filed. */
  devItem?: { id: string; name: string; url: string; status: string | null; open: boolean } | null;
  /** Hits customers: accounts tagged, or (no account tags) at least 5 users. */
  customerHitting: boolean;
}

export interface LogsApp {
  app: string;
  label: string;
  /** Failure lines in the last 24h, and the daily average of the 6 days before. */
  errors24h: number | null;
  priorDailyAvg: number | null;
  /** Failure lines per UTC day, oldest first (14 days; the last is today so far). */
  daily: number[];
  /** The last 24h's failures, grouped (newest first), noise left out. */
  top: { count: number; at: string; group: string; message: string }[];
  spike: boolean;
  error?: string;
}

export interface SentryAppRow {
  app: string;
  label: string;
  errors24h: number;
  errors7d: number;
  issues: number;
  flagged: number;
  daily: number[];
  failed: string[];
}

export interface WatchAlert {
  at: number;
  issueId: string;
  shortId: string;
  app: string;
  title: string;
  kind: WatchFlag | "logs_spike";
  /** Slack message ts; absent when alerts are off. */
  ts?: string;
}

export interface WatchDevItem {
  at: number;
  issueId: string;
  shortId: string;
  app: string;
  title: string;
  mode: "shadow" | "on";
  /** Filed item (mode on), or why it was not filed. */
  item?: { id: string; url: string };
  skipped?: string;
}

export interface ErrorWatchSummary {
  computedAt: number;
  days: string[];
  sentry: {
    enabled: boolean;
    /** Day Sentry stopped storing errors (quota), if it has. */
    notStoringSince: string | null;
    /** Days in the window Sentry stored nothing (quota): counts missing, not zero. */
    gapDays: string[];
    apps: SentryAppRow[];
  };
  logs: { enabled: boolean; apps: LogsApp[] };
  /** Flagged issues, most serious first. */
  attention: WatchIssue[];
  /** Every watched issue (top per app), for the page's tables. */
  issues: WatchIssue[];
  alerts: WatchAlert[];
  devItems: WatchDevItem[];
  settings: { alerts: boolean; devItems: "off" | "shadow" | "on"; channel: string };
}

export type WatchDrill = { kind: "issue"; id: string } | { kind: "app"; app: string; source: "sentry" | "logs" };
export type ErrorWatchInsight = Insight<WatchDrill>;

// ── Storage ─────────────────────────────────────────────────────────

const SUMMARY_KEY = "jetta:errorwatch:summary:v1";
const LOG_HOURS_KEY = "jetta:errorwatch:loghours:v1";
const INSIGHT_KEY = "jetta:errorwatch:insight:v1";
const HISTORY_KEY = "jetta:errorwatch:history:v1";
const FILED_KEY = "jetta:errorwatch:filed:v1";
const LOCK_ID = "errorwatch-lock";

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, unknown>();
async function getJson<T>(key: string): Promise<T | null> {
  const r = client();
  if (!r) return (mem.get(key) as T) ?? null;
  return (await r.get<T>(key)) ?? null;
}
async function setJson(key: string, value: unknown): Promise<void> {
  const r = client();
  if (!r) return void mem.set(key, value);
  await r.set(key, value);
}

export const getErrorWatchSummary = () => getJson<ErrorWatchSummary>(SUMMARY_KEY);
export const getErrorWatchInsight = () => getJson<ErrorWatchInsight & { fingerprint?: string }>(INSIGHT_KEY);

// ── Helpers ─────────────────────────────────────────────────────────

const DAY = 86_400_000;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The 14 UTC days the page shows, oldest first, ending today. */
function lastDays(n = 14): string[] {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10));
}

/**
 * Errors that are never flagged. Our own background job naming customer
 * accounts (see cloudwatch EVIDENCE_NOISE), bots probing for PHP/WordPress
 * paths (JobFlows' top "Not Found" errors), and 404s from scanners.
 */
function noiseOf(i: WatchedIssueRaw): string | undefined {
  const text = `${i.title} ${i.where ?? ""}`;
  if (EVIDENCE_NOISE.test(text) || /Back office board \d+ not found/i.test(text)) return "our back-office sync job";
  if (/\.php\b|\/wp-|\/\.env\b|\/\.git\b/i.test(text)) return "bot scanning for web paths";
  return undefined;
}

/** Events in the last 24h, approximated from day buckets: today + the matching share of yesterday. */
function last24h(daily: number[]): number {
  if (!daily.length) return 0;
  const now = new Date();
  const dayFrac = (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const today = daily[daily.length - 1] ?? 0;
  const yesterday = daily[daily.length - 2] ?? 0;
  return Math.round(today + yesterday * (1 - dayFrac));
}

/** Spike: the last 24h well above the usual day, and big enough to matter. */
function isSpike(events24h: number, baseline: number): boolean {
  return events24h >= 20 && events24h >= 4 * Math.max(baseline, 1);
}

function productOf(app: string): "getsign" | "jetpackapps" {
  return app === "getsign" ? "getsign" : "jetpackapps";
}

// ── 1. Sentry ───────────────────────────────────────────────────────

async function readSentry(
  notStoringSince: string | null,
  gapDays: Set<string>,
  days: string[],
): Promise<{ rows: SentryAppRow[]; issues: WatchIssue[] }> {
  const rows: SentryAppRow[] = [];
  const issues: WatchIssue[] = [];
  const day = Date.now() - DAY;
  await Promise.all(
    (Object.keys(SENTRY_PROJECTS) as SentryApp[]).map(async (app) => {
      const { issues: raw, failed } = await watchIssues(app, 15).catch(() => ({ issues: [] as WatchedIssueRaw[], failed: ["all"] }));
      const label = SENTRY_PROJECTS[app].label;
      for (const r of raw) {
        const daily = r.daily.length === 14 ? r.daily : [...Array(Math.max(0, 14 - r.daily.length)).fill(0), ...r.daily].slice(-14);
        const events24h = last24h(daily);
        // The 7 full days before yesterday (the last 24h overlaps yesterday),
        // minus days Sentry stored nothing: those are missing, not quiet.
        const usual = daily.slice(-9, -2).filter((_, k) => !gapDays.has(days[days.length - 9 + k]));
        const baseline = median(usual);
        // A spike needs a usual day to compare with: at least 4 real days, and
        // a full last 24h (yesterday stored).
        const comparable = usual.length >= 4 && !gapDays.has(days[days.length - 2]);
        const noise = noiseOf(r);
        const flags: WatchFlag[] = [];
        if (!noise) {
          if (Date.parse(r.firstSeen) >= day && events24h >= 3) flags.push("new");
          // With storage off, counts are missing, not low: no spikes then.
          else if (!notStoringSince && comparable && isSpike(events24h, baseline)) flags.push("spike");
        }
        issues.push({
          id: r.id,
          shortId: r.shortId,
          app,
          appLabel: label,
          project: r.project,
          frontend: r.frontend,
          title: r.title,
          ...(r.where ? { where: r.where } : {}),
          status: r.status,
          link: r.link,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
          users: r.users,
          daily,
          events24h,
          events7d: sum(daily.slice(-7)),
          baseline,
          flags,
          ...(noise ? { noise } : {}),
          customerHitting: false,
        });
      }
      const mine = issues.filter((i) => i.app === app);
      rows.push({
        app,
        label,
        errors24h: sum(mine.map((i) => i.events24h)),
        errors7d: sum(mine.map((i) => i.events7d)),
        issues: mine.filter((i) => i.events7d > 0).length,
        flagged: mine.filter((i) => i.flags.length).length,
        daily: Array.from({ length: 14 }, (_, d) => sum(mine.map((i) => i.daily[d] ?? 0))),
        failed,
      });
    }),
  );
  rows.sort((a, b) => b.errors7d - a.errors7d);
  return { rows, issues };
}

// ── 2. CloudWatch ───────────────────────────────────────────────────

/** Hourly failure counts per app, merged into a 14-day series. */
async function readLogs(days: string[]): Promise<LogsApp[]> {
  const r = client();
  const stored: Record<string, number> =
    (r ? await r.hgetall<Record<string, number>>(LOG_HOURS_KEY).catch(() => null) : (mem.get(LOG_HOURS_KEY) as Record<string, number>)) ?? {};
  const out: LogsApp[] = [];
  const merged: Record<string, number> = { ...stored };
  const cutoff = new Date(Date.now() - 15 * DAY).toISOString().slice(0, 13);
  await Promise.all(
    (Object.keys(LOG_GROUPS) as LogApp[]).map(async (app) => {
      const label = LOG_GROUPS[app].label;
      const have = Object.keys(stored).some((k) => k.startsWith(`${app}|`));
      try {
        // A cold series is seeded with 14 days in one query (the page's whole
        // window); after that 26h, which overlaps the previous run so a missed
        // hour is filled in.
        const [counts, recent] = await Promise.all([
          errorCountsByHour(app, have ? 26 : 24 * 14, have ? 40_000 : 120_000),
          searchLogs({ app, errorsOnly: true, hours: 24, limit: 50, timeoutMs: 25_000 }).catch(() => null),
        ]);
        for (const [hour, n] of Object.entries(counts.counts)) merged[`${app}|${hour}`] = n;
        const hourly = Object.entries(merged)
          .filter(([k]) => k.startsWith(`${app}|`))
          .map(([k, n]) => [k.split("|")[1], n] as const);
        const daily = days.map((d) => sum(hourly.filter(([h]) => h.startsWith(d)).map(([, n]) => n)));
        const since = new Date(Date.now() - DAY).toISOString().slice(0, 13);
        const errors24h = sum(hourly.filter(([h]) => h >= since).map(([, n]) => n));
        const prior = daily.slice(-8, -2);
        const priorDailyAvg = prior.some((n) => n > 0) ? Math.round(sum(prior) / prior.length) : null;
        out.push({
          app,
          label,
          errors24h,
          priorDailyAvg,
          daily,
          top: groupLines((recent?.lines ?? []).filter((l) => !EVIDENCE_NOISE.test(l.message))).slice(0, 6),
          spike: priorDailyAvg != null && errors24h >= 50 && errors24h >= 3 * Math.max(priorDailyAvg, 1),
        });
      } catch (e) {
        out.push({
          app,
          label,
          errors24h: null,
          priorDailyAvg: null,
          daily: days.map(() => 0),
          top: [],
          spike: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  // Keep 15 days of hours.
  const keep = Object.fromEntries(Object.entries(merged).filter(([k]) => k.split("|")[1] >= cutoff));
  if (r) {
    const stale = Object.keys(merged).filter((k) => !(k in keep));
    const fresh = Object.fromEntries(Object.entries(keep).filter(([k, v]) => stored[k] !== v));
    const entries = Object.entries(fresh);
    for (let i = 0; i < entries.length; i += 200) await r.hset(LOG_HOURS_KEY, Object.fromEntries(entries.slice(i, i + 200)));
    if (stale.length) await r.hdel(LOG_HOURS_KEY, ...stale);
  } else mem.set(LOG_HOURS_KEY, keep);
  return out.sort((a, b) => (b.errors24h ?? -1) - (a.errors24h ?? -1));
}

// ── 3-4. Who it hits ────────────────────────────────────────────────

async function enrich(flagged: WatchIssue[]): Promise<void> {
  const named = await devItemsMentioning(flagged.flatMap((i) => [i.shortId, `/issues/${i.id}/`])).catch(() => new Map());
  const filed = await getJson<Record<string, { id: string; url: string }>>(FILED_KEY).catch(() => null);
  let ticketReads = 0;
  for (const issue of flagged) {
    const acc = await issueAccounts(issue.id, issue.project).catch(() => ({ top: [], distinct: 0 }));
    issue.accounts = acc.top;
    issue.accountsDistinct = acc.distinct;
    issue.customerHitting = acc.distinct > 0 || (issue.frontend || !acc.top.length ? issue.users >= 5 : false);

    // Chat tickets from the accounts it hit (the only account → ticket link we keep).
    const tickets: WatchIssue["tickets"] = [];
    for (const a of acc.top.slice(0, 5)) {
      if (!a.slug) continue;
      const ids = (await accountTicketIds(a.slug).catch(() => [])).slice(0, 2);
      for (const id of ids) {
        // Freshdesk shares 40 calls a minute with live Jetta: a handful per run.
        const status = ticketReads < 8 ? (ticketReads++, await freshdesk.getTicketStatus(id)) : null;
        tickets.push({ id, url: freshdesk.freshdeskTicketUrl(id), status, slug: a.slug });
      }
    }
    issue.tickets = tickets;

    // A dev item that names it: our own filing, or any item whose comments carry its short id or link.
    const mine = filed?.[issue.id];
    const item = named.get(issue.shortId) ?? named.get(`/issues/${issue.id}/`);
    issue.devItem = item
      ? { id: item.id, name: item.name, url: item.url, status: item.status, open: !/^(done|deployed|archive)/i.test(item.group) }
      : mine
        ? { id: mine.id, name: issue.title, url: mine.url, status: null, open: true }
        : null;
  }
}

// ── 5. Proactive ────────────────────────────────────────────────────

export function alertText(i: WatchIssue): { headline: string; details: string[] } {
  const why = i.flags.includes("new")
    ? `new error, first seen ${i.firstSeen.slice(0, 16).replace("T", " ")} UTC`
    : `spiking: ${i.events24h} events in 24h against a usual ${i.baseline}/day`;
  const who = i.accountsDistinct
    ? `${i.accountsDistinct} monday account${i.accountsDistinct === 1 ? "" : "s"}`
    : `${i.users} user${i.users === 1 ? "" : "s"}`;
  const headline = `:rotating_light: *${i.appLabel}* ${why}, hitting ${who}: *${i.title.slice(0, 160)}* <${i.link}|${i.shortId}>`;
  const details = [
    ...(i.where ? [`Where: \`${i.where}\``] : []),
    ...(i.accounts?.length
      ? [`Accounts: ${i.accounts.slice(0, 5).map((a) => `${a.slug ?? a.id} (${a.events})`).join(", ")}`]
      : []),
    ...(i.tickets?.length
      ? [`Tickets from those accounts: ${i.tickets.map((t) => `<${t.url}|#${t.id}>${t.status ? ` ${t.status}` : ""}`).join(", ")}`]
      : []),
    i.devItem ? `Dev item: <${i.devItem.url}|${i.devItem.name.slice(0, 80)}>${i.devItem.status ? ` (${i.devItem.status})` : ""}` : "No dev item names this error yet.",
    `More on the console's Logs page.`,
  ];
  return { headline, details };
}

const DEV_ITEMS_PER_DAY = 2;

export async function maybeFileDevItem(i: WatchIssue): Promise<WatchDevItem | null> {
  const mode = config.errorWatch.devItems;
  if (mode === "off" || i.devItem) return null;
  // Worth a developer's time: more than one account, or a customer already wrote in.
  if ((i.accountsDistinct ?? 0) < 2 && !(i.tickets ?? []).length && !(i.frontend && i.users >= 10)) return null;
  const base = { at: Date.now(), issueId: i.id, shortId: i.shortId, app: i.app, title: i.title, mode } as const;
  // Once per issue per mode: a "would file" in shadow does not stop the real
  // filing once the switch is turned on.
  if (!(await markEventSeen(`errorwatch:devitem:${mode}:${i.id}`, 30 * 86_400))) return null;

  const existing = await monday.searchDevBoard(i.title.slice(0, 200), productOf(i.app)).catch(() => []);
  const strong = existing.find((x) => x.confidence === "strong");
  if (strong) return { ...base, skipped: `already on the board: ${strong.title}` };
  if (mode === "shadow") return { ...base, skipped: "shadow mode: would file" };
  if ((await rateCountPeek(`errorwatch:devitems:${new Date().toISOString().slice(0, 10)}`)) >= DEV_ITEMS_PER_DAY) {
    return { ...base, skipped: `daily cap of ${DEV_ITEMS_PER_DAY} reached` };
  }
  await rateCount(`errorwatch:devitems:${new Date().toISOString().slice(0, 10)}`, 2 * 86_400);
  const accounts = (i.accounts ?? []).slice(0, 5);
  const item = await monday.createDevItem({
    title: `[Error watch] ${i.title.slice(0, 120)}`,
    product: productOf(i.app),
    accountUrl: accounts[0]?.slug ? `https://${accounts[0].slug}.monday.com` : "(several accounts, see below)",
    errorDescription: `${i.title}${i.where ? ` at ${i.where}` : ""}. ${i.flags.includes("new") ? "New error" : "Spiking error"} found by Jetta's error watch: ${i.events24h} events in the last 24h (usual day ${i.baseline}), ${i.accountsDistinct ?? 0} monday account(s), ${i.users} user(s).`,
    reproSteps: "Filed automatically from Sentry; no customer repro yet. Start from the Sentry issue and the accounts below.",
    freshdeskTicketUrl: i.tickets?.[0]?.url ?? "(none: found by the error watch, not a ticket)",
    sentryEvidence: [
      `Sentry ${i.shortId}: ${i.link}`,
      `First seen ${i.firstSeen.slice(0, 16)}, last seen ${i.lastSeen.slice(0, 16)}; last 14 days per day: ${i.daily.join(", ")}.`,
      ...(accounts.length ? [`Accounts (events): ${accounts.map((a) => `${a.slug ?? ""}${a.id ? ` ${a.id}` : ""} (${a.events})`).join(", ")}`] : []),
      ...(i.tickets?.length ? [`Tickets from those accounts: ${i.tickets.map((t) => t.url).join(", ")}`] : []),
    ].join("\n"),
  });
  const filed = (await getJson<Record<string, { id: string; url: string }>>(FILED_KEY)) ?? {};
  filed[i.id] = { id: item.id, url: item.url };
  await setJson(FILED_KEY, filed);
  return { ...base, item: { id: item.id, url: item.url } };
}

// ── 6. The AI read ──────────────────────────────────────────────────

const SYSTEM = `You write a short read of what the apps' errors are doing, for the founder who runs a portfolio of monday.com apps (GetSign, Extract AI, JobFlows, VLOOKUP Auto-Link, TrackMy, Hashtask and others). Sources: Sentry (grouped errors) and the CloudWatch server logs (failure lines).

Rules:
1. Every point cites exactly one EVIDENCE entry by id (e.g. "E4"). The reader clicks it to open that issue or app.
2. Use only figures printed below, written the same way. Never compute new numbers. Write counts as digits.
3. Name the app. Never say "Jetpack Apps" as if it were one app.
4. What matters most: errors that hit customers (accounts, tickets) and have no dev item; new errors; spikes. Volume alone is not a problem: a steady noisy error is "watch", not an emergency.
5. Sentry "resolved" does not mean fixed (issues auto-resolve). If Sentry is not storing errors, say so first: its counts are then incomplete, and the logs are the record.
6. Plain language, no drama, no praise. A quiet day is a fine answer. Empty sections beat padded ones.
7. Actions are concrete: "file a dev item for GETSIGN-BE-X", "check account acme-co's ticket", "raise the Sentry quota".
8. Call something a spike, new, rising, an increase or up ONLY when its evidence line says so (flagged "new"/"spike", or "SPIKE" for logs). A number higher than its usual day without that mark is normal variation: do not call it a spike.
9. Log volume differs hugely between apps by how they log (TrackMy writes about a million failure lines a day, every day). Compare an app only with its own usual day, never with another app.
10. Each point is ONE short sentence, at most 30 words. The headline is one sentence, at most 30 words. No lists of figures inside a point.
11. "Worth watching" is only for something that is flagged, getting worse, or hitting customers. An app having its usual day goes nowhere (or under "going well" if it is worth saying at all).`;

export const ErrorWatchInsightSchema = insightSchema(
  "One plain sentence: are the apps healthy right now, and the single biggest reason why or why not.",
  "0 to 3 errors or trends worth attention, most serious first: new or spiking errors hitting customers, errors with tickets and no dev item.",
);

function buildEvidence(s: ErrorWatchSummary): Evidence<WatchDrill>[] {
  const out: Evidence<WatchDrill>[] = [];
  const add = (label: string, count: number, title: string, description: string, drill: WatchDrill, worse = false, unit?: string) =>
    out.push({ id: `E${out.length + 1}`, label, count, title, description, drill, worse, ...(unit ? { unit } : {}) });
  for (const i of s.attention.slice(0, 10)) {
    add(
      `${i.appLabel} ${i.shortId} "${i.title.slice(0, 120)}": ${i.flags.join("+")}, ${i.events24h} events last 24h (usual day ${i.baseline}), ${i.events7d} in 7 days, ${i.accountsDistinct ?? 0} accounts, ${i.users} users, ${(i.tickets ?? []).length} tickets from those accounts, dev item: ${i.devItem ? `${i.devItem.name.slice(0, 60)} (${i.devItem.status ?? "status unknown"})` : "none"}`,
      i.events24h,
      `${i.shortId}: ${i.title.slice(0, 80)}`,
      "The Sentry issue, the accounts it hit and their tickets.",
      { kind: "issue", id: i.id },
      true,
      "events in 24h",
    );
  }
  for (const a of s.sentry.apps.filter((x) => x.errors7d > 0)) {
    add(
      `${a.label} Sentry: ${a.errors24h} errors last 24h, ${a.errors7d} in 7 days, ${a.issues} active issues, ${a.flagged} flagged`,
      a.errors7d,
      `${a.label} · Sentry errors`,
      "The app's most active Sentry issues.",
      { kind: "app", app: a.app, source: "sentry" },
      false,
      "errors in 7 days",
    );
  }
  for (const a of s.logs.apps.filter((x) => x.errors24h)) {
    add(
      `${a.label} logs: ${a.errors24h} failure lines last 24h${a.priorDailyAvg != null ? ` (usual day ${a.priorDailyAvg})` : ""}${a.spike ? ", SPIKE" : ""}; most common: ${a.top[0] ? `${a.top[0].count}× ${a.top[0].message.slice(0, 120)}` : "n/a"}`,
      a.errors24h ?? 0,
      `${a.label} · log failures`,
      "Failure lines from the app's server logs, last 24h, grouped.",
      { kind: "app", app: a.app, source: "logs" },
      a.spike,
      "log lines in 24h",
    );
  }
  return out;
}

function fingerprint(s: ErrorWatchSummary): string {
  return JSON.stringify([
    s.sentry.notStoringSince,
    s.sentry.gapDays.length,
    s.attention.map((i) => [i.id, i.flags, !!i.devItem]),
    s.logs.apps.filter((a) => a.spike).map((a) => a.app),
  ]);
}

/** The evidence and prompt a read is written from. Exported for the eval script. */
export function errorWatchPrompt(s: ErrorWatchSummary): { evidence: Evidence<WatchDrill>[]; prompt: string; system: string } {
  const evidence = buildEvidence(s);
  const prompt = [
    s.sentry.notStoringSince
      ? `SENTRY IS NOT STORING ERRORS since ${s.sentry.notStoringSince} (over its quota): its counts after that are missing.`
      : "Sentry is storing errors normally.",
    s.sentry.gapDays.length
      ? `Sentry stored NOTHING on ${s.sentry.gapDays.length} of the last 14 days (${s.sentry.gapDays[0]} to ${s.sentry.gapDays[s.sentry.gapDays.length - 1]}, quota). Those days are missing data, not quiet days: never compare against them, never call an error new or rising because of them, and say Sentry trends are unreliable until a week of storage has built up. Low Sentry counts are NOT good news while the gap is in the window: no "going well" point may rest on a Sentry count.${s.sentry.notStoringSince ? "" : " Storage is working again now, so do not suggest raising the quota."}`
      : "",
    `Dev items from the watch: ${s.settings.devItems} mode.`,
    "",
    "EVIDENCE (cite by id):",
    ...evidence.map((e) => `[${e.id}] ${e.label}`),
  ].join("\n");
  return { evidence, prompt, system: SYSTEM };
}

export async function generateErrorWatchInsight(s: ErrorWatchSummary): Promise<ErrorWatchInsight & { fingerprint: string }> {
  const { evidence, prompt } = errorWatchPrompt(s);
  const { object } = await generateObject({
    model: getModel("standard"),
    schema: ErrorWatchInsightSchema,
    system: SYSTEM,
    prompt: `${prompt}\n\nWrite the read.`,
  });
  const read = reconcileInsight(object, evidence, `${SYSTEM}\n${prompt}`);
  // The model keeps calling a higher-than-usual number "an increase" against
  // rule 8 (it called VLOOKUP's 2.1x a rise). A point that claims a rise must
  // rest on evidence the watch itself flagged; otherwise it is dropped.
  const flagged = new Set(evidence.filter((e) => e.worse).map((e) => JSON.stringify(e.drill)));
  const RISE = /\b(spik\w*|increas\w*|ris(e|es|ing|en)|surg\w*|jump\w*|climb\w*|grow\w*|doubl\w*|tripl\w*|up from)\b/i;
  // "Worth watching" padded with apps having a normal day ("Steady, no
  // action") on glm-5.2: a watch point that says so about unflagged evidence
  // is not worth watching.
  const NORMAL = /\b(normal|steady|stable|in line with|as expected|expected|no action|routine|flat|unchanged|nothing (?:new|unusual))\b/i;
  let dropped = read.dropped;
  const isFlagged = (p: (typeof read.watch)[number]) => !!p.evidence && flagged.has(JSON.stringify(p.evidence.drill));
  const keep = (pts: typeof read.watch, watch = false) =>
    pts.filter((p) => {
      const ok = (!RISE.test(p.text) || isFlagged(p)) && !(watch && NORMAL.test(p.text) && !isFlagged(p));
      if (!ok) dropped++;
      return ok;
    });
  return {
    ...read,
    goingWell: keep(read.goingWell),
    watch: keep(read.watch, true),
    actions: keep(read.actions),
    dropped,
    basedOn: s.computedAt,
    generatedAt: Date.now(),
    model: modelLabel("standard"),
    fingerprint: fingerprint(s),
  };
}

/** The read for the page: cached until what is flagged changes, or 6 hours pass. */
export async function errorWatchInsight(s: ErrorWatchSummary, force = false): Promise<ErrorWatchInsight & { fingerprint?: string }> {
  const cached = await getErrorWatchInsight().catch(() => null);
  if (!force && cached && cached.fingerprint === fingerprint(s) && Date.now() - cached.generatedAt < 6 * 3_600_000) return cached;
  const fresh = await generateErrorWatchInsight(s);
  await setJson(INSIGHT_KEY, fresh);
  return fresh;
}

// ── The run ─────────────────────────────────────────────────────────

export interface ErrorWatchRunResult {
  status: "ok" | "busy" | "off" | "error";
  flagged?: number;
  alerts?: number;
  devItems?: number;
  ms?: number;
  error?: string;
}

const rank = (i: WatchIssue) =>
  (i.customerHitting ? 1000 : 0) + (i.devItem ? 0 : 300) + (i.flags.includes("new") ? 200 : 0) + Math.min(i.events24h, 199);

export async function runErrorWatch(opts: { notify?: boolean } = {}): Promise<ErrorWatchRunResult> {
  if (!config.errorWatch.enabled) return { status: "off" };
  if (!sentryEnabled() && !logsEnabled()) return { status: "off", error: "neither Sentry nor CloudWatch is configured" };
  if (!(await markEventSeen(LOCK_ID, 280))) return { status: "busy" };
  const started = Date.now();
  try {
    const days = lastDays();
    const storage = sentryEnabled() ? await storageStatus() : { notStoringSince: null, gapDays: [] };
    const notStoringSince = storage.notStoringSince;
    const gapDays = storage.gapDays.filter((d) => d >= days[0]);
    const [sentry, logs] = await Promise.all([
      sentryEnabled() ? readSentry(notStoringSince, new Set(gapDays), days) : Promise.resolve({ rows: [], issues: [] }),
      logsEnabled() ? readLogs(days) : Promise.resolve([] as LogsApp[]),
    ]);
    const flagged = sentry.issues.filter((i) => i.flags.length);
    await enrich(flagged.slice(0, 15));
    const attention = flagged.filter((i) => i.customerHitting).sort((a, b) => rank(b) - rank(a));

    const history = (await getJson<{ alerts: WatchAlert[]; devItems: WatchDevItem[] }>(HISTORY_KEY)) ?? { alerts: [], devItems: [] };
    const alerts: WatchAlert[] = [];
    const devItems: WatchDevItem[] = [];
    if (opts.notify !== false) {
      for (const i of attention.slice(0, 5)) {
        const kind = i.flags[0];
        if (!(await markEventSeen(`errorwatch:alert:${i.id}:${kind}`, 3 * 86_400))) continue;
        const a: WatchAlert = { at: Date.now(), issueId: i.id, shortId: i.shortId, app: i.app, title: i.title, kind };
        if (config.errorWatch.alerts) {
          const { headline, details } = alertText(i);
          a.ts = await slack.notifyErrorWatch(headline, details).catch(() => undefined);
        }
        alerts.push(a);
      }
      // Every run, not only when the alert fires: an error that reaches a
      // second account or gets a ticket later qualifies then. Deduped inside.
      for (const i of attention.slice(0, 5)) {
        const d = await maybeFileDevItem(i).catch((e) => ({
          at: Date.now(), issueId: i.id, shortId: i.shortId, app: i.app, title: i.title,
          mode: config.errorWatch.devItems === "on" ? ("on" as const) : ("shadow" as const),
          skipped: `failed: ${e instanceof Error ? e.message : String(e)}`,
        }));
        if (d) devItems.push(d);
      }
      for (const a of logs.filter((x) => x.spike)) {
        if (!(await markEventSeen(`errorwatch:logspike:${a.app}`, 86_400))) continue;
        const al: WatchAlert = { at: Date.now(), issueId: `logs:${a.app}`, shortId: "logs", app: a.app, title: a.top[0]?.message.slice(0, 160) ?? "", kind: "logs_spike" };
        if (config.errorWatch.alerts) {
          al.ts = await slack
            .notifyErrorWatch(`:chart_with_upwards_trend: *${a.label}* server logs: ${a.errors24h} failure lines in 24h against a usual ${a.priorDailyAvg}/day.`, [
              ...a.top.slice(0, 4).map((t) => `• ${t.count}× \`${t.message.slice(0, 200)}\``),
              "More on the console's Logs page.",
            ])
            .catch(() => undefined);
        }
        alerts.push(al);
      }
    }

    const summary: ErrorWatchSummary = {
      computedAt: Date.now(),
      days,
      sentry: { enabled: sentryEnabled(), notStoringSince, gapDays, apps: sentry.rows },
      logs: { enabled: logsEnabled(), apps: logs },
      attention,
      issues: sentry.issues.filter((i) => i.events7d > 0).sort((a, b) => b.events7d - a.events7d),
      alerts: [...alerts, ...history.alerts].slice(0, 40),
      devItems: [...devItems, ...history.devItems].slice(0, 40),
      settings: {
        alerts: config.errorWatch.alerts,
        devItems: config.errorWatch.devItems,
        channel: config.errorWatch.channel ?? config.slack.opsChannel ?? config.slack.escalationChannel ?? "",
      },
    };
    await setJson(SUMMARY_KEY, summary);
    await setJson(HISTORY_KEY, { alerts: summary.alerts, devItems: summary.devItems });
    await bumpDataVersion("errorwatch");
    // Proactive: the read is ready before anyone opens the page.
    await errorWatchInsight(summary).catch((e) =>
      logOpsEvent({ level: "warn", event: "errorwatch.insight_failed", source: "cron", data: { message: e instanceof Error ? e.message : String(e) } }),
    );
    return { status: "ok", flagged: attention.length, alerts: alerts.length, devItems: devItems.length, ms: Date.now() - started };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  } finally {
    await unmarkEventSeen(LOCK_ID).catch(() => {});
  }
}
