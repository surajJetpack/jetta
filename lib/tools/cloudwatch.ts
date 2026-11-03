/**
 * The apps' own logs, read from AWS CloudWatch Logs. READ-ONLY.
 *
 * Credentials are the IAM user `jetta-logs-reader` (account 239505812368),
 * whose only policy allows Describe/Filter/Get and Logs Insights queries — so
 * nothing here can write, delete or export, whatever the code below says.
 *
 * Two callers:
 *   - `search_app_logs` in lib/assistant-tools.ts, for colleagues (Slack DM
 *     assistant, console assistant).
 *   - `logEvidence`, called by create_dev_item so a bug report carries what
 *     the logs said about that customer. The ticket agent never sees the
 *     result: it goes straight onto the dev item, so nothing from a log can
 *     find its way into a customer reply.
 *
 * Only the log groups listed in LOG_GROUPS can be searched. The model picks an
 * app, never a group name, so it cannot be steered at infrastructure logs.
 */
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { config } from "../config";

interface LogGroup {
  name: string;
  /** Staging/test groups are searchable on request but never used as evidence. */
  staging?: boolean;
}

/**
 * Which groups belong to which app. Apps with no entry (Extract AI, Smart
 * Columns) have no logs in this AWS account.
 */
export const LOG_GROUPS: Record<string, { label: string; groups: LogGroup[] }> = {
  getsign: {
    label: "GetSign",
    groups: [
      { name: "GetSign" },
      { name: "/ecs/getsign-standalone" },
      { name: "/getsign/mcp" },
      { name: "/aws/lambda/pdfFieldDetector" },
      { name: "/aws/lambda/pdfFieldDetectorV2" },
      { name: "/aws/events/getsign-email-monitoring" },
      { name: "/ecs/getsign-staging", staging: true },
    ],
  },
  vlookup: { label: "VLOOKUP Auto-Link", groups: [{ name: "AutoLinkProdLog" }] },
  trackmy: { label: "TrackMy", groups: [{ name: "tracking" }] },
  jobflows: { label: "JobFlows", groups: [{ name: "Jobflows" }] },
  pivotreports: { label: "Pivot Reports Pro", groups: [{ name: "PivotPro" }] },
  triggerly: { label: "Triggerly", groups: [{ name: "Triggerly" }] },
  jetscan: { label: "JetScan HR", groups: [{ name: "JetScanHR" }] },
  hashtask: { label: "Hashtask", groups: [{ name: "Hashtask" }] },
};

export type LogApp = keyof typeof LOG_GROUPS;
export const LOG_APPS = Object.keys(LOG_GROUPS) as [LogApp, ...LogApp[]];

export function logsEnabled(): boolean {
  const c = config.cloudwatch;
  return c.enabled && !!c.accessKeyId && !!c.secretAccessKey;
}

let client: CloudWatchLogsClient | null = null;
function cw(): CloudWatchLogsClient {
  if (!client) {
    const c = config.cloudwatch;
    client = new CloudWatchLogsClient({
      region: c.region,
      credentials: { accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! },
    });
  }
  return client;
}

/**
 * Each group's creation time and retention, cached for an hour. CloudWatch
 * rejects a WHOLE query when one group cannot reach the window's end
 * ("end date … before the log group's creation time or exceeds the log
 * group's log retention"): /getsign/mcp keeps 14 days, so every GetSign search
 * of a ticket older than that failed outright. Groups that cannot cover the
 * window are left out and named instead.
 */
type Coverage = Map<string, { created: number; retentionDays?: number }>;
let groupInfo: { at: number; byName: Coverage } | null = null;
async function groupCoverage(): Promise<Coverage> {
  if (groupInfo && Date.now() - groupInfo.at < 3_600_000) return groupInfo.byName;
  const byName: Coverage = new Map();
  let nextToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await cw().send(new DescribeLogGroupsCommand({ limit: 50, nextToken }));
    for (const g of r.logGroups ?? []) {
      if (g.logGroupName) byName.set(g.logGroupName, { created: g.creationTime ?? 0, retentionDays: g.retentionInDays });
    }
    nextToken = r.nextToken;
    if (!nextToken) break;
  }
  groupInfo = { at: Date.now(), byName };
  return byName;
}

/** Split groups into those whose stored logs reach `endSec`, and those that do not. */
async function coveringGroups(names: string[], endSec: number): Promise<{ usable: string[]; skipped: string[] }> {
  const info = await groupCoverage().catch(() => null);
  if (!info) return { usable: names, skipped: [] };
  const endMs = endSec * 1000;
  const usable: string[] = [];
  const skipped: string[] = [];
  for (const n of names) {
    const g = info.get(n);
    // A day's margin: retention is enforced by whole days.
    const oldestKept = g?.retentionDays ? Date.now() - (g.retentionDays - 1) * 86_400_000 : 0;
    if (!g || endMs < g.created || endMs < oldestKept) skipped.push(n);
    else usable.push(n);
  }
  return { usable, skipped };
}

/**
 * Lines that read as a failure. Each app logs differently ("level": "error",
 * {"type":"monday error"}, "❌ Failed…", "failed query"), so this is a word
 * match, minus lines the app itself marked debug or info.
 */
const ERROR_FILTERS = [
  'filter @message like /(?i)(error|exception|fail|timeout|timed out|denied|unauthori[sz]ed|not authenticated|forbidden|"status(code)?"\\s*:\\s*[45]\\d\\d)/',
  'filter @message not like /"level"\\s*:\\s*"(debug|info|verbose)"/',
  // GetSign logs every monday query it sends, and the query text itself names
  // fields like "error": 6,904 of 7,086 such lines in 14 days had no error in
  // them at all. A query line counts only when it carries an error.
  'filter @message not like /"query"\\s*:\\s*"/ or @message like /"errors?"\\s*:|"level"\\s*:\\s*"(error|warn)"/',
];

/**
 * Search terms are reduced to characters that occur in emails, ids, slugs and
 * error words, so a term can never close the string and add query syntax.
 */
export function cleanTerm(raw: string): string {
  return raw.replace(/[^A-Za-z0-9@._\-+:/ ]/g, "").trim().slice(0, 120);
}

/** Secrets that turn up in request logs. Applied to every line before it leaves this module. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[aws key redacted]")
    // Only a quoted JSON key or a key=value pair: "Get Monday Token: Unauthorized"
    // in a message is the error worth reading, not a secret.
    .replace(
      /("(?:authorization|token|access_?token|refresh_?token|id_?token|api[_-]?key|x-api-key|secret|client_?secret|password|cookie|set-cookie)"\s*:\s*)("[^"]*"|[^\s,}]+)/gi,
      '$1"[redacted]"',
    )
    .replace(
      /\b((?:token|access_token|api_key|apikey|secret|password)=)[^\s&"]+/gi,
      "$1[redacted]",
    );
}

/**
 * Many failure lines open with the query that failed and only end with why
 * ("…items_page_by_column_values(…) : {"errors":[{"message":"Concurrency limit
 * exceeded for the field"…"). Clipped, the reason is the part lost. So any
 * error/message values are pulled to the front, ahead of the line itself.
 */
export function errorFirst(message: string): string {
  const found: string[] = [];
  for (const m of message.matchAll(/\\*"(?:message|error|errorMessage|reason)\\*"\s*:\s*\\*"([^"\\]{3,200})/g)) {
    const v = m[1].trim();
    if (!found.includes(v) && !/^\[redacted\]$/.test(v)) found.push(v);
    if (found.length === 3) break;
  }
  if (!found.length || message.indexOf(found[0]) < 120) return message;
  return `${found.join(" | ")} :: ${message}`;
}

export interface LogLine {
  at: string;
  group: string;
  message: string;
  /** The log stream, for a link to this exact line in the AWS console. */
  stream?: string;
}

/**
 * The AWS console's own escaping for paths inside its #fragment:
 * percent-encode, then write each "%" as "$25" ("/" becomes "$252F").
 */
const awsFrag = (s: string) => encodeURIComponent(s).replace(/%/g, "$25");

/**
 * A link that opens one log line in the CloudWatch console: its stream,
 * narrowed to ten seconds around it (several apps log everything to one
 * "Prod" stream). Needs an AWS console login to the account; without the
 * stream it opens the log group instead.
 */
export function cloudwatchLineUrl(l: Pick<LogLine, "group" | "stream" | "at">): string {
  const region = config.cloudwatch.region;
  const base = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${awsFrag(l.group)}`;
  const t = Date.parse(l.at);
  if (!l.stream || !Number.isFinite(t)) return base;
  // Names inside the path are double-escaped ($252F); the query after them is
  // escaped once ("?" is $3F, "=" $3D, "&" $26), as the console writes it.
  return `${base}/log-events/${awsFrag(l.stream)}$3Fstart$3D${t - 5_000}$26end$3D${t + 5_000}`;
}

export interface LogSearch {
  app: LogApp;
  /** Substring to match: an email, monday account/board/item id, slug or error text. */
  contains?: string;
  /** Numeric ids, any of which may match (monday account/board ids). Internal use. */
  anyId?: string[];
  /** monday account slugs ("accountSlug": "acme"), any of which may match. Internal use. */
  anySlug?: string[];
  /** Only lines that carry a monday account or board id. Internal use. */
  withIds?: boolean;
  errorsOnly?: boolean;
  hours?: number;
  limit?: number;
  includeStaging?: boolean;
  /** Give up after this long and return what has arrived. */
  timeoutMs?: number;
  /** End of the window. Default now; set it to look at the hours before a past event. */
  endAt?: Date;
}

export interface LogSearchResult {
  app: string;
  groups: string[];
  /** Groups left out because their stored logs do not reach the window (retention, or created later). */
  skipped?: string[];
  window: string;
  lines: LogLine[];
  complete: boolean;
  scannedMb: number;
}

const MESSAGE_CHARS = 500;
const MAX_HOURS = 24 * 14;

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function searchLogs(q: LogSearch): Promise<LogSearchResult> {
  const entry = LOG_GROUPS[q.app];
  if (!entry) throw new Error(`no log groups for app "${q.app}"`);
  const groups = entry.groups.filter((g) => q.includeStaging || !g.staging).map((g) => g.name);
  const hours = Math.min(Math.max(q.hours ?? 24, 1), MAX_HOURS);
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  const term = q.contains ? cleanTerm(q.contains) : "";
  if (q.contains && term.length < 3) throw new Error("search term too short after cleaning; use an email, id or a word from the error");
  // Digits only, so they are safe inside a regex literal.
  const ids = (q.anyId ?? []).filter((id) => /^\d{5,}$/.test(id));
  // Slugs are letters, digits and hyphens, so they are safe inside a regex literal.
  const slugs = (q.anySlug ?? []).filter((x) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(x));

  const query = [
    "fields @timestamp, @log, @logStream, @message",
    ...(term ? [`filter @message like "${term}"`] : []),
    ...(ids.length ? [`filter @message like /(${ids.join("|")})/`] : []),
    ...(slugs.length ? [`filter @message like /(?i)"(account_?slug|slug)"\\s*:\\s*"(${slugs.join("|")})"/`] : []),
    ...(q.withIds ? ['filter @message like /"(account|board)(Id|_id)?"\\s*:/'] : []),
    ...(q.errorsOnly ? ERROR_FILTERS : []),
    "sort @timestamp desc",
    `limit ${limit}`,
  ].join(" | ");

  const end = Math.floor((q.endAt?.getTime() ?? Date.now()) / 1000);
  const start = end - hours * 3600;
  const { usable, skipped } = await coveringGroups(groups, end);
  const base = {
    app: entry.label,
    groups: usable,
    ...(skipped.length ? { skipped } : {}),
    window: q.endAt ? `${hours}h before ${q.endAt.toISOString()}` : `last ${hours}h`,
  };
  if (!usable.length) return { ...base, lines: [], complete: true, scannedMb: 0 };
  const { queryId } = await cw().send(
    new StartQueryCommand({ logGroupNames: usable, startTime: start, endTime: end, queryString: query }),
  );
  if (!queryId) throw new Error("CloudWatch did not start the query");

  const deadline = Date.now() + (q.timeoutMs ?? 25_000);
  let res = await cw().send(new GetQueryResultsCommand({ queryId }));
  while ((res.status === "Scheduled" || res.status === "Running") && Date.now() < deadline) {
    await wait(1000);
    res = await cw().send(new GetQueryResultsCommand({ queryId }));
  }
  const complete = res.status === "Complete";
  if (!complete && (res.status === "Scheduled" || res.status === "Running")) {
    await cw().send(new StopQueryCommand({ queryId })).catch(() => {});
  }
  if (res.status === "Failed" || res.status === "Cancelled" || res.status === "Timeout") {
    throw new Error(`CloudWatch query ${res.status.toLowerCase()}`);
  }

  const lines: LogLine[] = (res.results ?? []).map((row) => {
    const f = Object.fromEntries(row.map((c) => [c.field, c.value ?? ""]));
    const message = errorFirst(redact((f["@message"] ?? "").replace(/\s+/g, " ").trim()));
    return {
      at: f["@timestamp"] ? new Date(`${f["@timestamp"].replace(" ", "T")}Z`).toISOString() : "",
      // @log is "<account>:<group>"; the account id is noise.
      group: (f["@log"] ?? "").replace(/^\d+:/, ""),
      message: message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS)}…` : message,
      ...(f["@logStream"] ? { stream: f["@logStream"] } : {}),
    };
  });

  return {
    ...base,
    lines,
    complete,
    scannedMb: Math.round(((res.statistics?.bytesScanned ?? 0) / 1e6) * 10) / 10,
  };
}

/**
 * Failure lines per hour for one app (production groups only), newest hour
 * last. For the error watch's trend: one Logs Insights `stats` query, so it
 * costs a scan but returns 24-170 numbers, not lines. Hours with no failures
 * are absent from CloudWatch's answer and come back as 0. Hour keys are ISO
 * strings truncated to the hour ("2026-11-03T05").
 */
export async function errorCountsByHour(app: LogApp, hours: number, timeoutMs = 40_000): Promise<{ counts: Record<string, number>; complete: boolean; groups: string[] }> {
  const entry = LOG_GROUPS[app];
  if (!entry) throw new Error(`no log groups for app "${app}"`);
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.min(Math.max(hours, 1), MAX_HOURS) * 3600;
  // Same rule as searchLogs: a group whose stored logs cannot reach the end
  // fails the whole query, so it is left out.
  const { usable } = await coveringGroups(entry.groups.filter((g) => !g.staging).map((g) => g.name), end);
  if (!usable.length) return { counts: {}, complete: true, groups: [] };
  const query = [...ERROR_FILTERS, "stats count() as n by bin(1h) as hour"].join(" | ");
  const { queryId } = await cw().send(
    new StartQueryCommand({ logGroupNames: usable, startTime: start, endTime: end, queryString: query }),
  );
  if (!queryId) throw new Error("CloudWatch did not start the query");
  const deadline = Date.now() + timeoutMs;
  let res = await cw().send(new GetQueryResultsCommand({ queryId }));
  while ((res.status === "Scheduled" || res.status === "Running") && Date.now() < deadline) {
    await wait(1500);
    res = await cw().send(new GetQueryResultsCommand({ queryId }));
  }
  const complete = res.status === "Complete";
  if (!complete && (res.status === "Scheduled" || res.status === "Running")) {
    await cw().send(new StopQueryCommand({ queryId })).catch(() => {});
  }
  if (res.status === "Failed" || res.status === "Cancelled" || res.status === "Timeout") {
    throw new Error(`CloudWatch query ${res.status.toLowerCase()}`);
  }
  const counts: Record<string, number> = {};
  for (const row of res.results ?? []) {
    const f = Object.fromEntries(row.map((c) => [c.field, c.value ?? ""]));
    if (!f.hour) continue;
    // "2026-11-03 05:00:00.000" (UTC)
    counts[f.hour.replace(" ", "T").slice(0, 13)] = Number(f.n) || 0;
  }
  return { counts, complete, groups: usable };
}

/** The monday ids a set of log lines carries, as the apps write them. */
export function idsIn(lines: LogLine[]): { accounts: string[]; users: string[]; boards: string[] } {
  const accounts = new Set<string>();
  const users = new Set<string>();
  const boards = new Set<string>();
  for (const { message } of lines) {
    // "accountId": "26408309" · "accountId": 18443935 · "account":"22879975"
    // At most 10 digits: AWS's own events (getsign-email-monitoring) carry a
    // 12-digit "account", the AWS account, which is nobody's monday account.
    for (const m of message.matchAll(/"account(?:Id|_id)?"\s*:\s*"?(\d{5,10})(?!\d)/gi)) accounts.add(m[1]);
    // GetSign logs an email only inside monday's `me` answer, next to the user id.
    for (const m of message.matchAll(/"me"\s*:\s*\{\s*"id"\s*:\s*"?(\d{5,})/g)) users.add(m[1]);
    for (const m of message.matchAll(/"board(?:Id|_id)?"\s*:\s*"?(\d{6,})/gi)) boards.add(m[1]);
  }
  return { accounts: [...accounts], users: [...users], boards: [...boards] };
}

const EVIDENCE_LINES = 40;

/**
 * Our own background jobs that fail while naming a customer's account, which
 * is not something that customer experienced. Seen on 3 of 8 GetSign tickets
 * tested (2026-11-03): "Back office board 4050887480 not found |
 * BackofficeFunnelSyncProcessor job failed". Left out of dev items only;
 * search_app_logs still finds them.
 */
export const EVIDENCE_NOISE = /BackofficeFunnelSync/;

/** Repeats of one failure (same text bar ids and times) collapse to one row with a count. */
export function groupLines(lines: LogLine[]): (LogLine & { count: number })[] {
  const groups = new Map<string, LogLine & { count: number }>();
  for (const l of lines) {
    // Ids first, then digits: digits first shortens a uuid below the length
    // test and leaves its letters to split one error into many rows.
    const key =
      l.group +
      l.message
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
        .replace(/\b[0-9a-f]{24}\b/gi, "<id>")
        .replace(/"[^"]{24,}"/g, '"…"')
        .replace(/\d+/g, "#")
        .slice(0, 160);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { ...l, count: 1 });
  }
  return [...groups.values()].slice(0, 10);
}

/** monday hosts that are not a customer's account. */
const NOT_ACCOUNTS = new Set(["www", "auth", "apps", "view", "developer", "support", "community", "api", "forms", "wkf"]);

/**
 * monday references in what a customer wrote: board and item ids from links
 * (https://acme.monday.com/boards/123/pulses/456) or labelled ids ("board id:
 * 123", "item #456"), and the account slug from the link's host. Pass only the
 * customer's own words: our notes link to Jetpack's dev boards, which would
 * point the search at the wrong place.
 */
export function mondayRefsIn(text: string, ownHost?: string): { slugs: string[]; boards: string[]; items: string[] } {
  const slugs = new Set<string>();
  const boards = new Set<string>();
  const items = new Set<string>();
  const own = ownHost?.toLowerCase();
  for (const m of text.matchAll(/(?:https?:\/\/)?([a-z0-9][a-z0-9-]{1,62})\.monday\.com\/boards\/(\d{6,})(?:\/(?:views\/\d+\/)?(?:pulses|items)\/(\d{6,}))?/gi)) {
    const slug = m[1].toLowerCase();
    if (own && `${slug}.monday.com` === own) continue;
    if (!NOT_ACCOUNTS.has(slug)) slugs.add(slug);
    boards.add(m[2]);
    if (m[3]) items.add(m[3]);
  }
  for (const m of text.matchAll(/\bboard(?:\s*id)?\s*[:#]?\s*(\d{8,12})\b/gi)) boards.add(m[1]);
  for (const m of text.matchAll(/\b(?:item|pulse)(?:\s*id)?\s*[:#]?\s*(\d{9,12})\b/gi)) items.add(m[1]);
  return { slugs: [...slugs].slice(0, 3), boards: [...boards].slice(0, 5), items: [...items].slice(0, 5) };
}

/**
 * What the logs say about one customer, for a dev item.
 *
 * Failure lines rarely carry an email: they carry a monday account, board or
 * item id. So the ids come from two places:
 *   - the customer's own words (`text`): monday links and labelled ids. This
 *     is the only way in for apps that never log an email (JobFlows,
 *     Triggerly, TrackMy);
 *   - the logs: lines naming the email give account and user ids, and a user
 *     id (GetSign) gives the boards that user works on.
 * Then the recent failures for the email or any of those ids. Null when there
 * is nothing worth adding or logs are off. Never throws: a bug report must not
 * wait on, or fail because of, a log search.
 */
export async function logEvidence(input: {
  app: string | null | undefined;
  email: string | null | undefined;
  /** What the customer wrote (opening message and their replies). */
  text?: string;
  /**
   * monday ids already known for this customer, e.g. from the in-app chat
   * widget that opened the ticket (monday's session token vouches for them).
   */
  known?: { accountIds?: string[]; userIds?: string[]; slugs?: string[]; verified?: boolean };
  hours?: number;
  /** End of the window; default now. */
  at?: Date;
  /**
   * Told the monday accounts and slugs the search settled on, so the Sentry
   * evidence (./sentry.ts) can look up the same customer. Called once, before
   * the failure search; not called when there was nothing to search by.
   */
  found?: (ids: { accounts: string[]; slugs: string[] }) => void;
}): Promise<string | null> {
  if (!logsEnabled() || !input.app || !(input.app in LOG_GROUPS)) return null;
  const app = input.app as LogApp;
  const email = input.email ?? null;
  const ownHost = (() => {
    try {
      return config.monday.accountUrl ? new URL(config.monday.accountUrl).host : undefined;
    } catch {
      return undefined;
    }
  })();
  const refs = mondayRefsIn(input.text ?? "", ownHost);
  const digits = (xs?: string[]) => (xs ?? []).filter((x) => /^\d{5,12}$/.test(x));
  const known = {
    accounts: digits(input.known?.accountIds),
    users: digits(input.known?.userIds),
    slugs: (input.known?.slugs ?? []).map((x) => x.toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(x)),
  };
  refs.slugs = [...new Set([...known.slugs, ...refs.slugs])].slice(0, 3);
  if (!email && !refs.boards.length && !refs.items.length && !refs.slugs.length && !known.accounts.length && !known.users.length) {
    return null;
  }
  const hours = input.hours ?? 72;
  const t = { hours, timeoutMs: 15_000, endAt: input.at };
  const none = Promise.resolve(null);
  try {
    // The newest lines naming the email are often all the same kind (GetSign's
    // `me` answers), so the id-carrying ones are fetched on their own: taking
    // ids from "the newest 30" made the result depend on which 30 came back.
    const [byEmail, byEmailIds, emailFailures, bySlug] = await Promise.all([
      email ? searchLogs({ app, contains: email, limit: 30, ...t }) : none,
      email ? searchLogs({ app, contains: email, withIds: true, limit: 50, ...t }) : none,
      email ? searchLogs({ app, contains: email, errorsOnly: true, limit: EVIDENCE_LINES, ...t }) : none,
      refs.slugs.length ? searchLogs({ app, anySlug: refs.slugs, limit: 20, ...t }) : none,
    ]);
    const found = idsIn([...(byEmail?.lines ?? []), ...(byEmailIds?.lines ?? []), ...(bySlug?.lines ?? [])]);
    // Known ids lead: they are the customer's for certain, the rest is inferred.
    found.accounts.unshift(...known.accounts);
    found.users = [...new Set([...known.users, ...found.users])];
    const boardSet = new Set([...refs.boards, ...found.boards]);
    if (found.users.length) {
      const byUser = await searchLogs({ app, anyId: found.users.slice(0, 3), withIds: true, limit: 50, ...t });
      const more = idsIn(byUser.lines);
      found.accounts.push(...more.accounts);
      more.boards.forEach((b) => boardSet.add(b));
    }
    // The customer's own boards first: they are what the ticket is about.
    const boards = [...boardSet].slice(0, 6);
    const accounts = [...new Set(found.accounts)].slice(0, 3);
    const items = refs.items.slice(0, 4);
    input.found?.({ accounts, slugs: refs.slugs });
    const anyId = [...accounts, ...boards, ...items];
    const idFailures = anyId.length
      ? await searchLogs({ app, anyId, errorsOnly: true, limit: EVIDENCE_LINES, ...t })
      : null;

    const seen = new Set<string>();
    const failures = [...(emailFailures?.lines ?? []), ...(idFailures?.lines ?? [])]
      .filter((l) => !EVIDENCE_NOISE.test(l.message))
      .filter((l) => !seen.has(l.at + l.message) && !!seen.add(l.at + l.message))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, EVIDENCE_LINES);
    const mentioned = (byEmail?.lines.length ?? 0) + (bySlug?.lines.length ?? 0);
    if (!mentioned && !failures.length) return null;

    const fromChat = [
      known.slugs.length ? `account ${known.slugs.join(", ")}` : "",
      known.accounts.length ? `monday account ${known.accounts.join(", ")}` : "",
      known.users.length ? `monday user ${known.users.join(", ")}` : "",
    ].filter(Boolean);
    const fromTicket = [
      refs.slugs.filter((x) => !known.slugs.includes(x)).length
        ? `account ${refs.slugs.filter((x) => !known.slugs.includes(x)).join(", ")}`
        : "",
      refs.boards.length ? `board${refs.boards.length > 1 ? "s" : ""} ${refs.boards.join(", ")}` : "",
      items.length ? `item${items.length > 1 ? "s" : ""} ${items.join(", ")}` : "",
    ].filter(Boolean);
    const logBoards = boards.filter((b) => !refs.boards.includes(b));
    const fromLogs = [
      accounts.filter((a) => !known.accounts.includes(a)).length
        ? `monday account ${accounts.filter((a) => !known.accounts.includes(a)).join(", ")}`
        : "",
      found.users.filter((u) => !known.users.includes(u)).length
        ? `monday user ${found.users.filter((u) => !known.users.includes(u)).slice(0, 3).join(", ")}`
        : "",
      logBoards.length ? `board${logBoards.length > 1 ? "s" : ""} ${logBoards.join(", ")}` : "",
    ].filter(Boolean);
    const searchedFor = [email, ...fromChat, ...fromTicket, ...fromLogs].filter(Boolean).join(" / ");
    const groups = (byEmail ?? bySlug ?? idFailures)?.groups ?? LOG_GROUPS[app].groups.filter((g) => !g.staging).map((g) => g.name);
    return [
      `${LOG_GROUPS[app].label} logs, ${input.at ? `${hours}h before ${input.at.toISOString()}` : `last ${hours}h`} (searched ${groups.join(", ")}).`,
      ...(fromChat.length
        ? [`From the in-app chat: ${fromChat.join("; ")}${input.known?.verified ? " (verified by monday)" : " (unverified)"}.`]
        : []),
      ...(fromTicket.length ? [`From the ticket: ${fromTicket.join("; ")}.`] : []),
      email
        ? byEmail?.lines.length
          ? `${byEmail.lines.length}${byEmail.lines.length === 30 ? "+" : ""} line(s) mention ${email}${fromLogs.length ? `; tied to ${fromLogs.join("; ")}` : ""}.`
          : `No line mentions ${email}.`
        : "",
      ...(failures.length
        ? [
            `Newest error/failure lines for ${searchedFor}:`,
            ...groupLines(failures).map(
              (g) => `- ${g.count > 1 ? `${g.count}× (newest ${g.at})` : g.at} [${g.group}] ${g.message.slice(0, 300)}`,
            ),
          ]
        : ["No error or failure lines for this customer in that window."]),
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    console.warn(`[cloudwatch] log evidence failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export interface CustomerLogSearch extends LogSearch {
  /** Also search the boards this customer's lines name. Default true. */
  followBoards?: boolean;
}

export interface CustomerLogResult extends LogSearchResult {
  /** Boards found for the customer and searched as well. */
  boardsFollowed: string[];
  /** Lines from the followed boards, kept apart so the reader knows how they were found. */
  viaBoards: LogLine[];
}

/**
 * A search for a customer (email, account id, user id or slug) that also
 * covers their boards. Many failures are logged against a board, not an
 * account: asked about account 26342721, the assistant reported two error
 * types and missed 6× "Cannot change column value for inactive items", which
 * name only board 5106468624. So the customer's id-carrying lines are read for
 * board ids (via the user id when that is all GetSign logged), and those
 * boards are searched with the same filters. Board lines come back separately.
 */
export async function followCustomer(q: CustomerLogSearch): Promise<CustomerLogResult> {
  const main = await searchLogs(q);
  const term = q.contains ? cleanTerm(q.contains) : "";
  // A customer reference, not an error word or a board/item id (10+ digits):
  // email, account/user id (5-10 digits) or slug.
  const isCustomer = /@/.test(term) || /^\d{5,10}$/.test(term) || (/^[a-z0-9][a-z0-9-]{2,62}$/.test(term) && /-/.test(term));
  if (q.followBoards === false || !isCustomer) return { ...main, boardsFollowed: [], viaBoards: [] };

  const t = { app: q.app, hours: q.hours, endAt: q.endAt, includeStaging: q.includeStaging, timeoutMs: 12_000 };
  const withIds = await searchLogs({ ...t, contains: term, withIds: true, limit: 50 }).catch(() => null);
  const found = idsIn(withIds?.lines ?? []);
  const boards = new Set(found.boards);
  if (found.users.length && boards.size < 3) {
    const byUser = await searchLogs({ ...t, anyId: found.users.slice(0, 3), withIds: true, limit: 50 }).catch(() => null);
    idsIn(byUser?.lines ?? []).boards.forEach((b) => boards.add(b));
  }
  const followed = [...boards].filter((b) => b !== term).slice(0, 5);
  if (!followed.length) return { ...main, boardsFollowed: [], viaBoards: [] };

  const viaBoardsRes = await searchLogs({
    ...t,
    anyId: followed,
    errorsOnly: q.errorsOnly,
    limit: q.limit,
  }).catch(() => null);
  const seen = new Set(main.lines.map((l) => l.at + l.message));
  return {
    ...main,
    complete: main.complete && (viaBoardsRes?.complete ?? true),
    boardsFollowed: followed,
    viaBoards: (viaBoardsRes?.lines ?? []).filter((l) => !seen.has(l.at + l.message)),
  };
}
