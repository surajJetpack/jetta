/**
 * Cloudflare, read-only, for the error watch (lib/error-watch.ts, the /logs
 * page). One account token (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) with
 * Analytics, Workers Scripts, Zone and Firewall Services read.
 *
 * What the zones' Free plan allows (checked 2026-11-10):
 *   - GraphQL Analytics reaches back at most 3 days per query, so the watch
 *     keeps its own 14-day hourly series (like CloudWatch's).
 *   - firewallEventsAdaptiveGroups (grouped) is paid-only; the raw
 *     firewallEventsAdaptive list works, so firewall events are grouped here.
 *   - Health Checks are a paid feature: the watch probes the busiest hosts
 *     itself instead (probeUrls).
 *   - workersInvocationsAdaptive works at account level.
 */
import { config } from "../config";

const API = "https://api.cloudflare.com/client/v4";

export function cloudflareEnabled(): boolean {
  return !!(config.cloudflare.token && config.cloudflare.accountId && config.cloudflare.enabled);
}

const headers = () => ({ Authorization: `Bearer ${config.cloudflare.token}`, "Content-Type": "application/json" });

async function rest<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  const d = (await r.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (!r.ok || !d?.success) throw new Error(`Cloudflare ${path}: ${d?.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
  return d.result as T;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = (await r.json().catch(() => null)) as { data?: T; errors?: { message: string }[] | null } | null;
  if (!r.ok || d?.errors?.length || !d?.data) throw new Error(`Cloudflare GraphQL: ${d?.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
  return d.data;
}

/** GraphQL refuses ranges over 3 days on Free; 71h leaves room. */
export const MAX_HOURS = 71;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const hourKey = (t: string) => t.slice(0, 13); // "2026-11-10T07"

export interface CfZone {
  id: string;
  name: string;
}

export async function listZones(): Promise<CfZone[]> {
  const zones = await rest<{ id: string; name: string; status: string }[]>("/zones?per_page=50&status=active");
  return zones.map((z) => ({ id: z.id, name: z.name }));
}

/**
 * Hosts that are not production: dev, QA and staging subdomains
 * (smart-dev.getsign.io, qa-go.jobflows.co, prabeshdev.jetpackapps.io). Shown,
 * never counted toward a zone's flags or alerts.
 */
export function isNonProdHost(host: string): boolean {
  const first = host.split(".")[0] ?? "";
  return /dev|qa|staging|stg|test|preview/i.test(first);
}

/** Bots scanning for WordPress/PHP/secrets: their 5xx says little about real visitors. */
export const SCAN_PATH = /\.php\b|\/wp-|\/\.env\b|\/\.git\b|\/xmlrpc/i;

export interface HostHour {
  hour: string;
  host: string;
  requests: number;
  errors: number;
}

/** Requests and 5xx per host per hour, from the zone's sampled request analytics. */
export async function zoneHostHours(zoneId: string, hours: number): Promise<HostHour[]> {
  const end = Date.now();
  const start = end - Math.min(hours, MAX_HOURS) * 3_600_000;
  type Row = { count: number; dimensions: { datetimeHour: string; clientRequestHTTPHost: string } };
  const q = (errorsOnly: boolean) => `query($z:String!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){
    httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e${errorsOnly ? ",edgeResponseStatus_geq:500" : ""}}){
      count dimensions{datetimeHour clientRequestHTTPHost}}}}}`;
  const vars = { z: zoneId, s: iso(start), e: iso(end) };
  const [all, errs] = await Promise.all([
    gql<{ viewer: { zones: { httpRequestsAdaptiveGroups: Row[] }[] } }>(q(false), vars),
    gql<{ viewer: { zones: { httpRequestsAdaptiveGroups: Row[] }[] } }>(q(true), vars),
  ]);
  const out = new Map<string, HostHour>();
  const at = (r: Row) => {
    const k = `${hourKey(r.dimensions.datetimeHour)}|${r.dimensions.clientRequestHTTPHost}`;
    let h = out.get(k);
    if (!h) out.set(k, (h = { hour: hourKey(r.dimensions.datetimeHour), host: r.dimensions.clientRequestHTTPHost, requests: 0, errors: 0 }));
    return h;
  };
  for (const r of all.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? []) at(r).requests += r.count;
  for (const r of errs.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? []) at(r).errors += r.count;
  return [...out.values()];
}

export interface EdgeError {
  host: string;
  path: string;
  /** What Cloudflare answered (522 = origin timed out, 521 = origin refused). */
  status: number;
  /** What the origin answered; 0 when it never answered. */
  origin: number;
  count: number;
}

/** The zone's most common 5xx (host, path, status) over the last `hours`. */
export async function zoneTopErrors(zoneId: string, hours = 24, limit = 15): Promise<EdgeError[]> {
  const end = Date.now();
  type Row = { count: number; dimensions: { clientRequestHTTPHost: string; clientRequestPath: string; edgeResponseStatus: number; originResponseStatus: number } };
  const d = await gql<{ viewer: { zones: { httpRequestsAdaptiveGroups: Row[] }[] } }>(
    `query($z:String!,$s:Time!,$e:Time!,$n:Int!){viewer{zones(filter:{zoneTag:$z}){
      httpRequestsAdaptiveGroups(limit:$n,filter:{datetime_geq:$s,datetime_lt:$e,edgeResponseStatus_geq:500},orderBy:[count_DESC]){
        count dimensions{clientRequestHTTPHost clientRequestPath edgeResponseStatus originResponseStatus}}}}}`,
    { z: zoneId, s: iso(end - hours * 3_600_000), e: iso(end), n: limit },
  );
  return (d.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? []).map((r) => ({
    host: r.dimensions.clientRequestHTTPHost,
    path: r.dimensions.clientRequestPath,
    status: r.dimensions.edgeResponseStatus,
    origin: r.dimensions.originResponseStatus,
    count: r.count,
  }));
}

export interface FirewallEvent {
  at: string;
  action: string;
  source: string;
  rule: string;
  host: string;
  path: string;
  userAgent: string;
}

/** Raw firewall events (Free has no grouped dataset), newest first, at most `limit`. */
export async function firewallEvents(zoneId: string, hours: number, limit = 10_000): Promise<{ events: FirewallEvent[]; truncated: boolean }> {
  const end = Date.now();
  type Row = { datetime: string; action: string; source: string; ruleId: string; description: string; clientRequestHTTPHost: string; clientRequestPath: string; userAgent: string };
  const d = await gql<{ viewer: { zones: { firewallEventsAdaptive: Row[] }[] } }>(
    `query($z:String!,$s:Time!,$e:Time!,$n:Int!){viewer{zones(filter:{zoneTag:$z}){
      firewallEventsAdaptive(limit:$n,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[datetime_DESC]){
        datetime action source ruleId description clientRequestHTTPHost clientRequestPath userAgent}}}}`,
    { z: zoneId, s: iso(end - Math.min(hours, MAX_HOURS) * 3_600_000), e: iso(end), n: limit },
  );
  const rows = d.viewer.zones[0]?.firewallEventsAdaptive ?? [];
  return {
    events: rows.map((r) => ({
      at: r.datetime,
      action: r.action,
      source: r.source,
      rule: r.description || r.ruleId || r.source,
      host: r.clientRequestHTTPHost,
      path: r.clientRequestPath,
      userAgent: r.userAgent,
    })),
    truncated: rows.length >= limit,
  };
}

export interface WorkerHour {
  hour: string;
  script: string;
  status: string;
  requests: number;
  errors: number;
}

/** Every Worker's invocations per hour and outcome, account-wide. */
export async function workerHours(hours: number): Promise<WorkerHour[]> {
  const end = Date.now();
  type Row = { sum: { requests: number; errors: number }; dimensions: { scriptName: string; status: string; datetimeHour: string } };
  const d = await gql<{ viewer: { accounts: { workersInvocationsAdaptive: Row[] }[] } }>(
    `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
      workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e}){
        sum{requests errors} dimensions{scriptName status datetimeHour}}}}}`,
    { a: config.cloudflare.accountId, s: iso(end - Math.min(hours, MAX_HOURS) * 3_600_000), e: iso(end) },
  );
  return (d.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).map((r) => ({
    hour: hourKey(r.dimensions.datetimeHour),
    script: r.dimensions.scriptName,
    status: r.dimensions.status,
    requests: r.sum.requests,
    errors: r.sum.errors,
  }));
}

/** Cloudflare reports invocations it can't tie to a script as "__unknown__". */
export const workerLabel = (script: string) => (script === "__unknown__" ? "unnamed Worker (Cloudflare: __unknown__)" : script);

export interface ProbeResult {
  url: string;
  status: number | null;
  ms: number;
  error?: string;
}

/** One GET per URL, no redirects followed. Down = 5xx, timeout or no connection. */
export async function probeUrls(urls: string[]): Promise<ProbeResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      const t = Date.now();
      try {
        const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "JettaUptimeProbe/1.0" } });
        await r.body?.cancel().catch(() => {});
        return { url, status: r.status, ms: Date.now() - t };
      } catch (e) {
        return { url, status: null, ms: Date.now() - t, error: e instanceof Error ? (e.name === "TimeoutError" ? "timed out after 15s" : e.message) : String(e) };
      }
    }),
  );
}

export const probeDown = (p: ProbeResult) => p.status == null || p.status >= 500;

/** The dashboard pages a person opens to look further. */
export const zoneDashboardUrl = (zone: string, page: "analytics" | "security" = "analytics") =>
  `https://dash.cloudflare.com/${config.cloudflare.accountId}/${zone}/${page === "analytics" ? "analytics/traffic" : "security/events"}`;
export const workerDashboardUrl = (script: string) =>
  script === "__unknown__"
    ? `https://dash.cloudflare.com/${config.cloudflare.accountId}/workers-and-pages`
    : `https://dash.cloudflare.com/${config.cloudflare.accountId}/workers/services/view/${script}/production/metrics`;
