"use client";

import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { StatusChip } from "@/components/jetta/status-chip";
import { SectionHeader } from "@/components/jetta/page-header";
import { cn } from "@/lib/utils";
import type { ErrorWatchSummary } from "@/lib/error-watch";
import type { CfFlag, CfWorkerRow, CfZoneRow, CloudflareSummary } from "@/lib/error-watch-cloudflare";
import { DailyChart, DailySpark, type LogsDrillRequest, type OpenLogs } from "./logs-drill";

const fmt = (n: number) => n.toLocaleString("en-US");

export function zoneRequest(z: CfZoneRow): LogsDrillRequest {
  return {
    title: `${z.zone} · Cloudflare`,
    description: "Edge 5xx on production hosts, the hosts and paths behind them, and what the firewall blocked.",
    drill: { kind: "cloudflare", zone: z.zone },
  };
}
export function workerRequest(w: CfWorkerRow): LogsDrillRequest {
  return { title: `${w.label} · Worker`, description: "The Worker's errors per day and how its invocations ended.", drill: { kind: "cloudflare", worker: w.script } };
}

function FlagChip({ flag }: { flag?: CfFlag }) {
  if (!flag) return null;
  return <StatusChip tone="stale">{flag === "spike" ? "spike" : "high rate"}</StatusChip>;
}

function DashLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
      {children} <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/** Edge, Workers and the uptime probe, on the /logs page. */
export function CloudflareCard({ s, open }: { s: ErrorWatchSummary; open: OpenLogs }) {
  const cf = s.cloudflare;
  if (!cf?.enabled) return null;
  const down = cf.probes.filter((p) => p.down);
  return (
    <Card id="cloudflare" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle>Cloudflare</CardTitle>
        <CardDescription className="text-xs">
          Server errors (5xx) Cloudflare served on each site&apos;s production hosts, what its firewall blocked, each Worker&apos;s errors, and an hourly
          check that the busiest hosts answer. Click a number for the hosts and paths behind it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        {cf.error && <p className="text-xs text-tone-warn">Part of the last read failed: {cf.error}</p>}
        {cf.baselineDays < 2 && (
          <p className="text-xs text-tone-warn">
            History is still building: Cloudflare&apos;s Free plan gives only 3 days back, so there is no usual day to compare with yet. Until there is,
            a site or Worker is flagged only when errors are a high share of its traffic.
          </p>
        )}

        <div>
          <SectionHeader className="mb-1.5" meta="last 24h, UTC days">
            Sites
          </SectionHeader>
          {cf.zones.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">5xx 24h · usual day</TableHead>
                  <TableHead className="text-right">Of requests</TableHead>
                  <TableHead>14 days</TableHead>
                  <TableHead className="text-right">Firewall blocks 24h</TableHead>
                  <TableHead>Uptime</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cf.zones.map((z) => {
                  const probes = cf.probes.filter((p) => p.zone === z.zone);
                  const zDown = probes.filter((p) => p.down);
                  const go = () => open(zoneRequest(z));
                  return (
                    <TableRow key={z.zone}>
                      <TableCell className="font-medium">
                        {z.zone}
                        {z.error && (
                          <span className="ml-1.5 text-xs text-tone-warn" title={z.error}>
                            couldn&apos;t read
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={z.errors24h} onClick={go}>
                          {fmt(z.errors24h)}
                        </CellLink>{" "}
                        <span className="text-muted-foreground">· {z.priorDailyAvg != null ? fmt(z.priorDailyAvg) : "—"}</span> <FlagChip flag={z.flag} />
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", z.flag && "font-medium text-tone-bad")}>
                        {z.requests24h ? `${z.rate}%` : "—"}
                        <span className="block text-xs font-normal text-muted-foreground">{fmt(z.requests24h)} req</span>
                      </TableCell>
                      <TableCell>
                        <button type="button" onClick={go} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`${z.zone} 5xx per day`}>
                          <DailySpark daily={z.daily} days={s.days} color="var(--chart-5)" label={`${z.zone} 5xx per day`} />
                        </button>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={z.firewall.blocked24h} onClick={go}>
                          {fmt(z.firewall.blocked24h)}
                        </CellLink>
                        {z.firewall.spike && (
                          <>
                            {" "}
                            <StatusChip tone="stale">spike</StatusChip>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {!probes.length ? (
                          <span className="text-muted-foreground">—</span>
                        ) : zDown.length ? (
                          <span className="text-tone-bad" title={zDown.map((p) => `${p.url}: ${p.status ?? p.error}`).join("\n")}>
                            {zDown.length} of {probes.length} down
                          </span>
                        ) : (
                          <span className="text-tone-good" title={probes.map((p) => `${p.url}: ${p.status} in ${p.ms} ms`).join("\n")}>
                            {probes.length} up
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No Cloudflare sites were read" />
          )}
        </div>

        {down.length > 0 && (
          <ul className="grid gap-1 text-xs">
            {down.map((p) => (
              <li key={p.url} className="text-tone-bad">
                {p.url} did not answer properly ({p.status ? `HTTP ${p.status}` : (p.error ?? "no answer")})
                {p.failingSince && (
                  <>
                    , failing since <RelativeTime at={Math.floor(p.failingSince / 1000)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <div>
          <SectionHeader className="mb-1.5" meta="last 24h">
            Workers
          </SectionHeader>
          {cf.workers.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead className="text-right">Errors 24h · usual day</TableHead>
                  <TableHead className="text-right">Invocations 24h</TableHead>
                  <TableHead>14 days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cf.workers.map((w) => {
                  const go = () => open(workerRequest(w));
                  return (
                    <TableRow key={w.script}>
                      <TableCell className="font-medium">{w.label}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", w.flag && "font-medium text-tone-bad")}>
                        <CellLink n={w.errors24h} onClick={go}>
                          {fmt(w.errors24h)}
                        </CellLink>{" "}
                        <span className="font-normal text-muted-foreground">· {w.priorDailyAvg != null ? fmt(w.priorDailyAvg) : "—"}</span> <FlagChip flag={w.flag} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={w.requests24h} onClick={go}>
                          {fmt(w.requests24h)}
                        </CellLink>
                      </TableCell>
                      <TableCell>
                        <button type="button" onClick={go} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`${w.label} errors per day`}>
                          <DailySpark daily={w.daily} days={s.days} color="var(--chart-5)" label={`${w.label} errors per day`} />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No Worker ran in the last 24h.</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Dev, QA and staging hosts are shown in the drill-down but never counted or flagged. Counts come from Cloudflare&apos;s sampled analytics, so
          they are close estimates. 522 means the origin server timed out; 521 that it refused the connection.
        </p>
      </CardContent>
    </Card>
  );
}

function ZoneBody({ z, days }: { z: CfZoneRow; days: string[] }) {
  return (
    <div className="grid gap-5 pt-4">
      {z.error && <p className="text-xs text-tone-warn">The last read failed: {z.error}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <DashLink href={z.link}>Traffic analytics</DashLink>
        <DashLink href={z.securityLink}>Security events</DashLink>
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta="production hosts, UTC days; the last is today so far">
          5xx per day
        </SectionHeader>
        <DailyChart daily={z.daily} days={days} gapDays={[]} unit="5xx" color="var(--chart-5)" />
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta="last 24h, most errors first">
          Hosts
        </SectionHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">5xx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {z.hosts.map((h) => (
              <TableRow key={h.host}>
                <TableCell className="font-mono text-xs break-all">
                  {h.host} {h.nonProd && <StatusChip tone="archived">not prod</StatusChip>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(h.requests)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", h.errors > 0 && !h.nonProd && "text-tone-bad")}>{fmt(h.errors)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta="last 24h, all hosts">
          Most common 5xx
        </SectionHeader>
        {z.topErrors.length ? (
          <ul className="divide-y">
            {z.topErrors.map((t, k) => (
              <li key={k} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 text-xs">
                <span className="font-medium tabular-nums">{fmt(t.count)}×</span>
                <span className="font-mono">{t.status}</span>
                <span className="text-muted-foreground">{t.origin ? `origin ${t.origin}` : t.status >= 520 ? "origin never answered" : "no origin status"}</span>
                <span className="min-w-0 font-mono break-all">
                  {t.host}
                  {t.path}
                </span>
                {t.scan && <StatusChip tone="archived">bot scan</StatusChip>}
                {t.nonProd && <StatusChip tone="archived">not prod</StatusChip>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No 5xx in the last 24h.</p>
        )}
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta={`last 24h${z.firewall.truncated ? ", first 10,000 events" : ""}`}>
          Firewall: {fmt(z.firewall.blocked24h)} blocked or challenged
        </SectionHeader>
        <DailyChart daily={z.firewall.daily} days={days} gapDays={[]} unit="Blocks" color="var(--chart-3)" />
        {z.firewall.rules.length > 0 && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium">Rules</p>
              <ul className="grid gap-1 text-xs">
                {z.firewall.rules.map((r, k) => (
                  <li key={k}>
                    <span className="font-medium tabular-nums">{fmt(r.count)}×</span> {r.rule} <span className="text-muted-foreground">({r.action})</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">Paths</p>
              <ul className="grid gap-1 text-xs">
                {z.firewall.paths.map((p, k) => (
                  <li key={k} title={p.userAgent ? `e.g. ${p.userAgent}` : undefined} className="break-all">
                    <span className="font-medium tabular-nums">{fmt(p.count)}×</span>{" "}
                    <span className="font-mono">
                      {p.host}
                      {p.path}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerBody({ w, days }: { w: CfWorkerRow; days: string[] }) {
  return (
    <div className="grid gap-5 pt-4">
      <DashLink href={w.link}>{w.script === "__unknown__" ? "Workers & Pages" : "Worker metrics"}</DashLink>
      {w.script === "__unknown__" && (
        <p className="text-xs text-muted-foreground">
          Cloudflare could not tie these invocations to a named script: usually a Pages project&apos;s Functions or a Worker that was renamed or
          deleted.
        </p>
      )}
      <div>
        <SectionHeader className="mb-1.5" meta="UTC days; the last is today so far">
          Errors per day
        </SectionHeader>
        <DailyChart daily={w.daily} days={days} gapDays={[]} unit="Errors" color="var(--chart-5)" />
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta="last 24h">
          How invocations ended
        </SectionHeader>
        <Table>
          <TableBody>
            {w.statuses.map((x) => (
              <TableRow key={x.status}>
                <TableCell className={cn("font-mono text-xs", !/^(success|clientDisconnected|responseStreamDisconnected)$/.test(x.status) && "text-tone-bad")}>{x.status}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(x.requests)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function CloudflareBody({ cf, zone, worker, days }: { cf?: CloudflareSummary; zone?: string; worker?: string; days: string[] }) {
  const z = zone ? cf?.zones.find((x) => x.zone === zone) : undefined;
  const w = worker ? cf?.workers.find((x) => x.script === worker) : undefined;
  if (z) return <ZoneBody z={z} days={days} />;
  if (w) return <WorkerBody w={w} days={days} />;
  return <EmptyState title="This isn't in the latest Cloudflare read" />;
}
