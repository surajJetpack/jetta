/**
 * The Cloudflare part of the error watch (lib/error-watch.ts): per zone, the
 * edge 5xx on production hosts and the firewall's blocks; per Worker, its
 * errors; and an uptime probe of each zone's busiest hosts.
 *
 * Cloudflare's Free plan lets a query reach back only 3 days, so the hourly
 * counts are merged into a series kept here (15 days), like CloudWatch's. A
 * day only counts as a "usual day" once at least 20 of its hours were read,
 * so the first days after this ships compare against little or nothing, and
 * flag only on a high error rate.
 */
import { Redis } from "@upstash/redis";
import { config } from "./config";
import {
  SCAN_PATH,
  cloudflareEnabled,
  firewallEvents,
  isNonProdHost,
  listZones,
  probeDown,
  probeUrls,
  workerDashboardUrl,
  workerHours,
  workerLabel,
  zoneDashboardUrl,
  zoneHostHours,
  zoneTopErrors,
  type EdgeError,
} from "./tools/cloudflare";

export type CfFlag = "spike" | "high";

export interface CfZoneRow {
  zone: string;
  /** Production hosts only (dev/QA/staging left out), last 24h. */
  requests24h: number;
  errors24h: number;
  /** errors24h / requests24h, in percent, one decimal. */
  rate: number;
  /** The usual day's 5xx (complete days before yesterday), null until there is one. */
  priorDailyAvg: number | null;
  /** 5xx on production hosts per UTC day, oldest first (14 days). */
  daily: number[];
  flag?: CfFlag;
  hosts: { host: string; requests: number; errors: number; nonProd: boolean }[];
  topErrors: (EdgeError & { scan: boolean; nonProd: boolean })[];
  firewall: {
    blocked24h: number;
    priorDailyAvg: number | null;
    daily: number[];
    spike: boolean;
    rules: { rule: string; action: string; count: number }[];
    paths: { host: string; path: string; count: number; userAgent: string }[];
    truncated: boolean;
  };
  link: string;
  securityLink: string;
  error?: string;
}

export interface CfWorkerRow {
  script: string;
  label: string;
  requests24h: number;
  errors24h: number;
  priorDailyAvg: number | null;
  daily: number[];
  statuses: { status: string; requests: number }[];
  flag?: CfFlag;
  link: string;
}

export interface CfProbe {
  url: string;
  zone: string;
  status: number | null;
  ms: number;
  error?: string;
  down: boolean;
  /** When it was first seen down in a row of runs (ms). */
  failingSince?: number;
}

export interface CloudflareSummary {
  enabled: boolean;
  zones: CfZoneRow[];
  workers: CfWorkerRow[];
  probes: CfProbe[];
  /** Complete days of history the usual day can be taken from (0 to 6). */
  baselineDays: number;
  error?: string;
}

const HOURS_KEY = "jetta:errorwatch:cfhours:v1";
const PROBE_KEY = "jetta:errorwatch:cfprobe:v1";
const DAY = 86_400_000;

let redis: Redis | null = null;
function client(): Redis | null {
  if (config.kv.url && config.kv.token) {
    redis ??= new Redis({ url: config.kv.url, token: config.kv.token });
    return redis;
  }
  return null;
}
const mem = new Map<string, unknown>();

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pair = (v: string | number | undefined): [number, number] => {
  const [a, b] = String(v ?? "0,0").split(",");
  return [Number(a) || 0, Number(b) || 0];
};
function topBy<T>(items: T[], key: (t: T) => string, n: number): { key: string; count: number; sample: T }[] {
  const m = new Map<string, { key: string; count: number; sample: T }>();
  for (const t of items) {
    const k = key(t);
    const g = m.get(k);
    if (g) g.count++;
    else m.set(k, { key: k, count: 1, sample: t });
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

/** A day's value from the series, and whether at least 20 of its hours were read. */
function series(stored: Record<string, string>, prefix: string, days: string[], coverage: Map<string, number>, pick: 0 | 1) {
  const byDay = new Map<string, number>();
  const since = new Date(Date.now() - DAY).toISOString().slice(0, 13);
  let last24 = 0, req24 = 0;
  for (const [k, v] of Object.entries(stored)) {
    if (!k.startsWith(prefix)) continue;
    const hour = k.slice(prefix.length);
    const p = pair(v);
    byDay.set(hour.slice(0, 10), (byDay.get(hour.slice(0, 10)) ?? 0) + p[pick]);
    if (hour >= since) {
      last24 += p[pick];
      req24 += p[0];
    }
  }
  const daily = days.map((d) => byDay.get(d) ?? 0);
  // The usual day: complete days among the 6 before yesterday (the last 24h overlaps yesterday).
  const prior = days.slice(-8, -2).filter((d) => (coverage.get(d) ?? 0) >= 20).map((d) => byDay.get(d) ?? 0);
  const priorDailyAvg = prior.length >= 2 ? Math.round(sum(prior) / prior.length) : null;
  return { daily, last24, req24, priorDailyAvg, baselineDays: prior.length };
}

/** Flag an error count: far above its usual day, or (no usual day yet) a high share of requests. */
function flagOf(errors: number, requests: number, prior: number | null, minErrors: number, coldRate: number): CfFlag | undefined {
  if (errors < minErrors) return undefined;
  if (prior != null) return errors >= 3 * Math.max(prior, 1) ? "spike" : undefined;
  return requests > 0 && errors / requests >= coldRate ? "high" : undefined;
}

export async function readCloudflare(days: string[]): Promise<CloudflareSummary> {
  if (!cloudflareEnabled()) return { enabled: false, zones: [], workers: [], probes: [], baselineDays: 0 };
  const r = client();
  const stored: Record<string, string> =
    (r ? await r.hgetall<Record<string, string>>(HOURS_KEY).catch(() => null) : (mem.get(HOURS_KEY) as Record<string, string>)) ?? {};
  const merged: Record<string, string> = { ...stored };
  // A cold series is seeded with the most Cloudflare gives (71h); after that
  // 26h, overlapping the last run so a missed hour is filled in.
  const hours = Object.keys(stored).some((k) => k.startsWith("c|")) ? 26 : 71;
  const windowHours = Array.from({ length: hours }, (_, i) => new Date(Date.now() - i * 3_600_000).toISOString().slice(0, 13));
  const since24 = new Date(Date.now() - DAY).toISOString().slice(0, 13);

  let zones: Awaited<ReturnType<typeof listZones>>;
  try {
    zones = await listZones();
  } catch (e) {
    return { enabled: true, zones: [], workers: [], probes: [], baselineDays: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const zoneRaw = await Promise.all(
    zones.map(async (z) => {
      try {
        const [hhAll, top, fwAll] = await Promise.all([zoneHostHours(z.id, hours), zoneTopErrors(z.id, 24), firewallEvents(z.id, hours)]);
        // Bots send any Host header ("ip-api.com", "jetpackapps.io:2095"): only the zone's own hosts count.
        const own = (host: string) => host === z.name || host.endsWith(`.${z.name}`);
        const hh = hhAll.filter((h) => own(h.host));
        const prod = new Map<string, [number, number]>();
        for (const h of hh) {
          if (isNonProdHost(h.host)) continue;
          const p = prod.get(h.hour) ?? [0, 0];
          prod.set(h.hour, [p[0] + h.requests, p[1] + h.errors]);
        }
        for (const hour of windowHours) merged[`z|${z.name}|${hour}`] = (prod.get(hour) ?? [0, 0]).join(",");
        const fw = { ...fwAll, events: fwAll.events.filter((e) => own(e.host)) };
        // Raw events come newest first: when the list was cut off, its oldest
        // hour is partial and the ones before it are missing, not zero.
        const oldest = fw.truncated ? fw.events[fw.events.length - 1]?.at.slice(0, 13) : undefined;
        const fwHours = new Map<string, number>();
        for (const e of fw.events) fwHours.set(e.at.slice(0, 13), (fwHours.get(e.at.slice(0, 13)) ?? 0) + 1);
        for (const hour of windowHours) if (!oldest || hour > oldest) merged[`f|${z.name}|${hour}`] = `0,${fwHours.get(hour) ?? 0}`;
        return { z, hh, top: top.filter((t) => own(t.host)), fw, error: undefined as string | undefined };
      } catch (e) {
        return { z, hh: [], top: [], fw: { events: [], truncated: false }, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  let workerRows: Awaited<ReturnType<typeof workerHours>> = [];
  let workerError: string | undefined;
  try {
    workerRows = await workerHours(hours);
    const w = new Map<string, [number, number]>();
    for (const x of workerRows) {
      const k = `w|${x.script}|${x.hour}`;
      const p = w.get(k) ?? [0, 0];
      w.set(k, [p[0] + x.requests, p[1] + x.errors]);
    }
    const scripts = new Set(workerRows.map((x) => x.script));
    for (const s of scripts) for (const hour of windowHours) merged[`w|${s}|${hour}`] = (w.get(`w|${s}|${hour}`) ?? [0, 0]).join(",");
  } catch (e) {
    workerError = e instanceof Error ? e.message : String(e);
  }

  // Coverage: which hours were read. The current hour is partial, so it is
  // re-read next run; it still counts as read.
  if (zoneRaw.some((x) => !x.error)) for (const hour of windowHours) merged[`c|${hour}`] = "1,1";
  const coverage = new Map<string, number>();
  for (const k of Object.keys(merged)) if (k.startsWith("c|")) coverage.set(k.slice(2, 12), (coverage.get(k.slice(2, 12)) ?? 0) + 1);

  // ── Zones
  let baselineDays = 0;
  const zoneRows: CfZoneRow[] = zoneRaw.map(({ z, hh, top, fw, error }) => {
    const s = series(merged, `z|${z.name}|`, days, coverage, 1);
    baselineDays = Math.max(baselineDays, s.baselineDays);
    const f = series(merged, `f|${z.name}|`, days, coverage, 1);
    const hostMap = new Map<string, { host: string; requests: number; errors: number; nonProd: boolean }>();
    for (const h of hh.filter((x) => x.hour >= since24)) {
      const g = hostMap.get(h.host) ?? { host: h.host, requests: 0, errors: 0, nonProd: isNonProdHost(h.host) };
      g.requests += h.requests;
      g.errors += h.errors;
      hostMap.set(h.host, g);
    }
    const ev24 = fw.events.filter((e) => e.at.slice(0, 13) >= since24);
    return {
      zone: z.name,
      requests24h: s.req24,
      errors24h: s.last24,
      rate: s.req24 ? Math.round((s.last24 / s.req24) * 1000) / 10 : 0,
      priorDailyAvg: s.priorDailyAvg,
      daily: s.daily,
      flag: error ? undefined : flagOf(s.last24, s.req24, s.priorDailyAvg, 200, 0.1),
      hosts: [...hostMap.values()].sort((a, b) => b.errors - a.errors || b.requests - a.requests).slice(0, 15),
      topErrors: top.map((t) => ({ ...t, scan: SCAN_PATH.test(t.path), nonProd: isNonProdHost(t.host) })),
      firewall: {
        blocked24h: ev24.length,
        priorDailyAvg: f.priorDailyAvg,
        daily: f.daily,
        spike: f.priorDailyAvg != null && ev24.length >= 300 && ev24.length >= 3 * Math.max(f.priorDailyAvg, 1),
        rules: topBy(ev24, (e) => `${e.rule}\u0000${e.action}`, 6).map((g) => ({ rule: g.sample.rule, action: g.sample.action, count: g.count })),
        paths: topBy(ev24, (e) => `${e.host}${e.path}`, 8).map((g) => ({ host: g.sample.host, path: g.sample.path, count: g.count, userAgent: g.sample.userAgent.slice(0, 160) })),
        truncated: fw.truncated,
      },
      link: zoneDashboardUrl(z.name),
      securityLink: zoneDashboardUrl(z.name, "security"),
      ...(error ? { error } : {}),
    };
  });

  // ── Workers
  const scripts = [...new Set(Object.keys(merged).filter((k) => k.startsWith("w|")).map((k) => k.split("|")[1]))];
  const workers: CfWorkerRow[] = scripts
    .map((script) => {
      const s = series(merged, `w|${script}|`, days, coverage, 1);
      const statuses = new Map<string, number>();
      for (const x of workerRows.filter((x) => x.script === script && x.hour >= since24)) statuses.set(x.status, (statuses.get(x.status) ?? 0) + x.requests);
      return {
        script,
        label: workerLabel(script),
        requests24h: s.req24,
        errors24h: s.last24,
        priorDailyAvg: s.priorDailyAvg,
        daily: s.daily,
        statuses: [...statuses.entries()].map(([status, requests]) => ({ status, requests })).sort((a, b) => b.requests - a.requests),
        flag: flagOf(s.last24, s.req24, s.priorDailyAvg, 50, 0.05),
        link: workerDashboardUrl(script),
      };
    })
    .filter((w) => w.requests24h > 0 || sum(w.daily) > 0)
    .sort((a, b) => b.errors24h - a.errors24h || b.requests24h - a.requests24h);

  // ── Uptime probe: each zone's apex and its 3 busiest production hosts.
  const targets: { url: string; zone: string }[] = [];
  for (const z of zoneRows) {
    const hosts = [z.zone, ...z.hosts.filter((h) => !h.nonProd && h.host !== z.zone).sort((a, b) => b.requests - a.requests).slice(0, 3).map((h) => h.host)];
    for (const h of hosts) targets.push({ url: `https://${h}/`, zone: z.zone });
  }
  const prevDown: Record<string, number> = (r ? await r.get<Record<string, number>>(PROBE_KEY).catch(() => null) : (mem.get(PROBE_KEY) as Record<string, number>)) ?? {};
  const results = await probeUrls(targets.map((t) => t.url));
  const nextDown: Record<string, number> = {};
  const probes: CfProbe[] = results.map((p, i) => {
    const down = probeDown(p);
    if (down) nextDown[p.url] = prevDown[p.url] ?? Date.now();
    return { ...p, zone: targets[i].zone, down, ...(down ? { failingSince: nextDown[p.url] } : {}) };
  });

  // ── Save: keep 15 days of hours.
  const cutoff = new Date(Date.now() - 15 * DAY).toISOString().slice(0, 13);
  const keep = Object.fromEntries(Object.entries(merged).filter(([k]) => k.slice(k.lastIndexOf("|") + 1) >= cutoff));
  if (r) {
    const stale = Object.keys(stored).filter((k) => !(k in keep));
    const fresh = Object.entries(keep).filter(([k, v]) => stored[k] !== v);
    for (let i = 0; i < fresh.length; i += 200) await r.hset(HOURS_KEY, Object.fromEntries(fresh.slice(i, i + 200)));
    if (stale.length) await r.hdel(HOURS_KEY, ...stale);
    await r.set(PROBE_KEY, nextDown);
  } else {
    mem.set(HOURS_KEY, keep);
    mem.set(PROBE_KEY, nextDown);
  }

  return {
    enabled: true,
    zones: zoneRows.sort((a, b) => b.errors24h - a.errors24h),
    workers,
    probes,
    baselineDays,
    ...(workerError ? { error: `Workers: ${workerError}` } : {}),
  };
}

/** Down in two runs in a row (about an hour), not a single blip. */
export const probeConfirmedDown = (p: CfProbe) => p.down && !!p.failingSince && Date.now() - p.failingSince >= 45 * 60_000;
