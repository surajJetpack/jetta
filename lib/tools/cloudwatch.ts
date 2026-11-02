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
 * Lines that read as a failure. Each app logs differently ("level": "error",
 * {"type":"monday error"}, "❌ Failed…", "failed query"), so this is a word
 * match, minus lines the app itself marked debug or info.
 */
const ERROR_FILTERS = [
  'filter @message like /(?i)(error|exception|fail|timeout|timed out|denied|unauthori[sz]ed|not authenticated|forbidden|"status(code)?"\\s*:\\s*[45]\\d\\d)/',
  'filter @message not like /"level"\\s*:\\s*"(debug|info|verbose)"/',
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

export interface LogLine {
  at: string;
  group: string;
  message: string;
}

export interface LogSearch {
  app: LogApp;
  /** Substring to match: an email, monday account/board/item id, slug or error text. */
  contains?: string;
  /** Numeric ids, any of which may match (monday account/board ids). Internal use. */
  anyId?: string[];
  errorsOnly?: boolean;
  hours?: number;
  limit?: number;
  includeStaging?: boolean;
  /** Give up after this long and return what has arrived. */
  timeoutMs?: number;
}

export interface LogSearchResult {
  app: string;
  groups: string[];
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

  const query = [
    "fields @timestamp, @log, @message",
    ...(term ? [`filter @message like "${term}"`] : []),
    ...(ids.length ? [`filter @message like /(${ids.join("|")})/`] : []),
    ...(q.errorsOnly ? ERROR_FILTERS : []),
    "sort @timestamp desc",
    `limit ${limit}`,
  ].join(" | ");

  const end = Math.floor(Date.now() / 1000);
  const start = end - hours * 3600;
  const { queryId } = await cw().send(
    new StartQueryCommand({ logGroupNames: groups, startTime: start, endTime: end, queryString: query }),
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
    const message = redact((f["@message"] ?? "").replace(/\s+/g, " ").trim());
    return {
      at: f["@timestamp"] ? new Date(`${f["@timestamp"].replace(" ", "T")}Z`).toISOString() : "",
      // @log is "<account>:<group>"; the account id is noise.
      group: (f["@log"] ?? "").replace(/^\d+:/, ""),
      message: message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS)}…` : message,
    };
  });

  return {
    app: entry.label,
    groups,
    window: `last ${hours}h`,
    lines,
    complete,
    scannedMb: Math.round(((res.statistics?.bytesScanned ?? 0) / 1e6) * 10) / 10,
  };
}

/** The monday ids a set of log lines carries, as the apps write them. */
export function idsIn(lines: LogLine[]): { accounts: string[]; users: string[]; boards: string[] } {
  const accounts = new Set<string>();
  const users = new Set<string>();
  const boards = new Set<string>();
  for (const { message } of lines) {
    // "accountId": "26408309" · "accountId": 18443935 · "account":"22879975"
    for (const m of message.matchAll(/"account(?:Id|_id)?"\s*:\s*"?(\d{5,})/gi)) accounts.add(m[1]);
    // GetSign logs an email only inside monday's `me` answer, next to the user id.
    for (const m of message.matchAll(/"me"\s*:\s*\{\s*"id"\s*:\s*"?(\d{5,})/g)) users.add(m[1]);
    for (const m of message.matchAll(/"board(?:Id|_id)?"\s*:\s*"?(\d{6,})/gi)) boards.add(m[1]);
  }
  return { accounts: [...accounts], users: [...users], boards: [...boards] };
}

const EVIDENCE_LINES = 15;

/**
 * What the logs say about one customer, for a dev item.
 *
 * Failure lines rarely carry an email: they carry a monday account or board
 * id. So: find the lines that mention the email, take the account and user ids
 * from them; when there is only a user id (GetSign), take the boards that user
 * appears on; then fetch the recent failures for the email or any of those
 * ids. Null when there is nothing worth adding or logs are off. Never throws:
 * a bug report must not wait on, or fail because of, a log search.
 */
export async function logEvidence(input: {
  app: string | null | undefined;
  email: string | null | undefined;
  hours?: number;
}): Promise<string | null> {
  if (!logsEnabled() || !input.email || !input.app || !(input.app in LOG_GROUPS)) return null;
  const app = input.app as LogApp;
  const email = input.email;
  const hours = input.hours ?? 72;
  const t = { hours, timeoutMs: 15_000 };
  try {
    const [byEmail, emailFailures] = await Promise.all([
      searchLogs({ app, contains: email, limit: 30, ...t }),
      searchLogs({ app, contains: email, errorsOnly: true, limit: EVIDENCE_LINES, ...t }),
    ]);
    const found = idsIn(byEmail.lines);
    let boards: string[] = [];
    if (!found.accounts.length && found.users.length) {
      const byUser = await searchLogs({ app, anyId: found.users.slice(0, 3), limit: 50, ...t });
      const more = idsIn(byUser.lines);
      found.accounts.push(...more.accounts);
      boards = more.boards.slice(0, 5);
    }
    const accounts = [...new Set(found.accounts)].slice(0, 3);
    const idFailures =
      accounts.length || boards.length
        ? await searchLogs({ app, anyId: [...accounts, ...boards], errorsOnly: true, limit: EVIDENCE_LINES, ...t })
        : null;

    const seen = new Set<string>();
    const failures = [...emailFailures.lines, ...(idFailures?.lines ?? [])]
      .filter((l) => !seen.has(l.at + l.message) && !!seen.add(l.at + l.message))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, EVIDENCE_LINES);
    if (!byEmail.lines.length && !failures.length) return null;

    const ids = [
      accounts.length ? `monday account ${accounts.join(", ")}` : "",
      found.users.length ? `monday user ${found.users.slice(0, 3).join(", ")}` : "",
      boards.length ? `board${boards.length > 1 ? "s" : ""} ${boards.join(", ")}` : "",
    ].filter(Boolean);
    return [
      `${LOG_GROUPS[app].label} logs, last ${hours}h (searched ${byEmail.groups.join(", ")}).`,
      byEmail.lines.length
        ? `${byEmail.lines.length}${byEmail.lines.length === 30 ? "+" : ""} line(s) mention ${email}${ids.length ? `; tied to ${ids.join("; ")}` : ""}.`
        : `No line mentions ${email}.`,
      ...(failures.length
        ? [
            `Newest error/failure lines for ${[email, ...ids].join(" / ")}:`,
            ...failures.map((l) => `- ${l.at} [${l.group}] ${l.message.slice(0, 300)}`),
          ]
        : ["No error or failure lines for this customer in that window."]),
    ].join("\n");
  } catch (e) {
    console.warn(`[cloudwatch] log evidence failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
