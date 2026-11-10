"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bug, ExternalLink, RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/jetta/page-header";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { StatusChip } from "@/components/jetta/status-chip";
import { InsightCard } from "@/components/jetta/insight-card";
import { CHIP_BASE, TONE_SOFT, type Tone } from "@/components/jetta/tone";
import { useDataVersion } from "@/lib/use-data-version";
import { fmtDayKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ErrorWatchSummary, LogsApp, SentryAppRow, WatchAlert, WatchDevItem } from "@/lib/error-watch";
import { CloudflareCard } from "./cloudflare-section";
import { DailySpark, DevItemLine, FlagChips, LogsDrillSheet, issueRequest, type LogsDrillRequest, type OpenLogs } from "./logs-drill";

function requestFailed(r: Response): string {
  console.error(`${r.url} → HTTP ${r.status}`);
  if (r.status === 401) return "Your session has expired. Sign in again.";
  if (r.status === 403) return "You don't have access to this.";
  return "The server couldn't load this. Try again in a moment.";
}

const DESCRIPTION = "What the apps' errors are doing and who they hit: Sentry, the server logs and Cloudflare, checked hourly.";

/** A status chip with a dot, in any of the shared tones (Signal has no "bad"). */
function StateChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn(CHIP_BASE, "tracking-wide uppercase", TONE_SOFT[tone])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

function StatusStrip({ s }: { s: ErrorWatchSummary }) {
  const gap = s.sentry.gapDays;
  const dev = s.settings.devItems;
  return (
    <Card id="status" className="scroll-mt-16 gap-2 py-3">
      <CardContent className="grid gap-2 px-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Sentry</span>
            {!s.sentry.enabled ? (
              <StateChip tone="neutral">off</StateChip>
            ) : s.sentry.notStoringSince ? (
              <StateChip tone="bad">not storing since {fmtDayKey(s.sentry.notStoringSince)}</StateChip>
            ) : (
              <StateChip tone="good">storing</StateChip>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">CloudWatch logs</span>
            <StateChip tone={s.logs.enabled ? "info" : "neutral"}>{s.logs.enabled ? "on" : "off"}</StateChip>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Cloudflare</span>
            <StateChip tone={s.cloudflare?.enabled ? (s.cloudflare.error ? "warn" : "info") : "neutral"}>
              {s.cloudflare?.enabled ? (s.cloudflare.error ? "partial" : "on") : "off"}
            </StateChip>
          </span>
          <span className="flex items-center gap-1.5" title={s.settings.alerts && s.settings.channel ? `Channel ${s.settings.channel}` : undefined}>
            <span className="text-muted-foreground">Slack alerts</span>
            <StateChip tone={s.settings.alerts ? "info" : "neutral"}>{s.settings.alerts ? "on" : "off"}</StateChip>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Dev items</span>
            <StateChip tone={dev === "on" ? "info" : dev === "shadow" ? "warn" : "neutral"}>{dev}</StateChip>
            <span className="text-muted-foreground">
              {dev === "on" ? "files them, max 2 a day" : dev === "shadow" ? "lists what it would file" : "nothing filed or listed"}
            </span>
          </span>
        </div>
        {s.sentry.notStoringSince && (
          <p className="text-xs text-tone-bad">
            Sentry is over its quota and stores no new errors: its counts since {fmtDayKey(s.sentry.notStoringSince)} are missing, so the server logs
            are the record.
          </p>
        )}
        {gap.length > 0 && (
          <p className="text-xs text-tone-warn">
            Sentry stored nothing on {gap.length} day{gap.length === 1 ? "" : "s"} ({fmtDayKey(gap[0])}
            {gap.length > 1 ? `–${fmtDayKey(gap[gap.length - 1])}` : ""}): trends that include them are incomplete.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Attention({ s, open }: { s: ErrorWatchSummary; open: OpenLogs }) {
  return (
    <Card id="attention" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle>Needs attention</CardTitle>
        <CardDescription className="text-xs">
          Errors Sentry first saw in the last 24h (new) or running far above their usual day (spike), most serious first. Known noise is never
          flagged. Click a row for the accounts it hit, their tickets and the daily trend.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {s.attention.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="text-right">24h · usual day</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead>Dev item</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.attention.map((i) => (
                <TableRow
                  key={i.id}
                  tabIndex={0}
                  onClick={() => open(issueRequest(i))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open(issueRequest(i));
                  }}
                  className="cursor-pointer align-top outline-none focus-visible:bg-muted/50"
                >
                  <TableCell className="font-medium">{i.appLabel}</TableCell>
                  <TableCell className="max-w-lg min-w-64 whitespace-normal">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <a
                        href={i.link}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-xs underline underline-offset-4"
                      >
                        {i.shortId}
                      </a>
                      <FlagChips flags={i.flags} />
                    </div>
                    <p className="mt-0.5 text-sm break-words">{i.title}</p>
                    {i.where && <p className="text-xs break-words text-muted-foreground">{i.where}</p>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {i.events24h} <span className="text-muted-foreground">· {i.baseline}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{i.accountsDistinct ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{i.tickets?.length ?? 0}</TableCell>
                  <TableCell>
                    <DevItemLine item={i.devItem} compact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="Nothing new or spiking that hits customers." />
        )}
      </CardContent>
    </Card>
  );
}

interface AppRow {
  app: string;
  label: string;
  sentry?: SentryAppRow;
  logs?: LogsApp;
}

/** Sentry's apps and the logs' apps by key, Sentry's order first (busiest first). */
function mergeApps(s: ErrorWatchSummary): AppRow[] {
  const rows = new Map<string, AppRow>();
  for (const a of s.sentry.apps) rows.set(a.app, { app: a.app, label: a.label, sentry: a });
  for (const a of s.logs.apps) {
    const r = rows.get(a.app);
    if (r) r.logs = a;
    else rows.set(a.app, { app: a.app, label: a.label, logs: a });
  }
  return [...rows.values()];
}

function ByApp({ s, open }: { s: ErrorWatchSummary; open: OpenLogs }) {
  const rows = mergeApps(s);
  const sentry = (r: AppRow) => () =>
    open({ title: `${r.label} · Sentry errors`, description: "The app's most active Sentry issues, busiest first over 7 days.", drill: { kind: "app", app: r.app, source: "sentry" } });
  const logs = (r: AppRow) => () =>
    open({ title: `${r.label} · log failures`, description: "Failure lines from the app's server logs, last 24h, grouped.", drill: { kind: "app", app: r.app, source: "logs" } });
  return (
    <Card id="by-app" className="scroll-mt-16 py-4">
      <CardHeader className="px-4">
        <CardTitle>By app</CardTitle>
        <CardDescription className="text-xs">
          Sentry errors from each app&apos;s most active issues, and failure lines from its server logs. Click a number for what is behind it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="text-right">Sentry 24h</TableHead>
                <TableHead className="text-right">7d</TableHead>
                <TableHead className="text-right">Active issues</TableHead>
                <TableHead className="text-right">Flagged</TableHead>
                <TableHead>14 days</TableHead>
                <TableHead className="text-right">Log failures 24h · usual day</TableHead>
                <TableHead>14 days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const se = r.sentry, lg = r.logs;
                return (
                  <TableRow key={r.app}>
                    <TableCell className="font-medium">
                      {r.label}
                      {se && se.failed.length > 0 && (
                        <span title={`Couldn't read: ${se.failed.join(", ")}`}>
                          <TriangleAlert className="ml-1.5 inline size-3.5 text-tone-warn" aria-label="Sentry read incomplete" />
                        </span>
                      )}
                    </TableCell>
                    {se ? (
                      <>
                        <TableCell className="text-right tabular-nums">
                          <CellLink n={se.errors24h} onClick={sentry(r)}>
                            {se.errors24h}
                          </CellLink>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <CellLink n={se.errors7d} onClick={sentry(r)}>
                            {se.errors7d}
                          </CellLink>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <CellLink n={se.issues} onClick={sentry(r)}>
                            {se.issues}
                          </CellLink>
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums", se.flagged > 0 && "font-medium text-tone-bad")}>
                          <CellLink n={se.flagged} onClick={sentry(r)}>
                            {se.flagged}
                          </CellLink>
                        </TableCell>
                        <TableCell>
                          <button type="button" onClick={sentry(r)} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`${r.label} Sentry errors per day`}>
                            <DailySpark daily={se.daily} days={s.days} gapDays={s.sentry.gapDays} color="var(--chart-1)" label={`${r.label} Sentry errors per day`} />
                          </button>
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={5} className="text-xs text-muted-foreground">
                        Not in Sentry
                      </TableCell>
                    )}
                    {lg ? (
                      <>
                        <TableCell className="text-right tabular-nums">
                          {lg.error && lg.errors24h == null ? (
                            <span className="text-xs text-tone-warn" title={lg.error}>
                              couldn&apos;t read
                            </span>
                          ) : (
                            <>
                              <CellLink n={lg.errors24h ?? 0} onClick={logs(r)}>
                                {lg.errors24h ?? "—"}
                              </CellLink>{" "}
                              <span className="text-muted-foreground">· {lg.priorDailyAvg ?? "—"}</span>
                              {lg.spike && (
                                <>
                                  {" "}
                                  <StatusChip tone="stale">spike</StatusChip>
                                </>
                              )}
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <button type="button" onClick={logs(r)} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`${r.label} log failures per day`}>
                            <DailySpark daily={lg.daily} days={s.days} color="var(--chart-4)" label={`${r.label} log failures per day`} />
                          </button>
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={2} className="text-xs text-muted-foreground">
                        {s.logs.enabled ? "No server logs" : "Logs off"}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="Neither Sentry nor the logs returned any apps" />
        )}
        <p className="text-xs text-muted-foreground">
          Log volume differs by how each app logs, so compare an app with its own usual day, not with another app. Days are UTC; the last bar is today
          so far{s.sentry.gapDays.length ? ", and a faint full bar is a day Sentry stored nothing" : ""}.
        </p>
      </CardContent>
    </Card>
  );
}

/** The error itself, outside Jetta: the Sentry issue or the CloudWatch log line. */
function ErrorLink({ href, logs, cloudflare }: { href?: string; logs?: boolean; cloudflare?: boolean }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
    >
      {cloudflare ? "Cloudflare" : logs ? "CloudWatch" : "Sentry"} <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

const ALERT_KIND: Record<WatchAlert["kind"], { label: string; tone: "in_review" | "stale" }> = {
  new: { label: "new", tone: "in_review" },
  spike: { label: "spike", tone: "stale" },
  logs_spike: { label: "logs spike", tone: "stale" },
  cf_edge: { label: "cloudflare 5xx", tone: "stale" },
  cf_worker: { label: "worker errors", tone: "stale" },
  cf_down: { label: "down", tone: "stale" },
};

const isCloudflare = (k: WatchAlert["kind"]) => k === "cf_edge" || k === "cf_worker" || k === "cf_down";

function devItemState(d: WatchDevItem): React.ReactNode {
  if (d.item) {
    return (
      <a href={d.item.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
        <StatusChip tone="published">filed</StatusChip>
      </a>
    );
  }
  if (d.skipped && !d.skipped.startsWith("shadow")) {
    return <span className="text-muted-foreground">skipped: {d.skipped}</span>;
  }
  return <StatusChip tone="draft">would file</StatusChip>;
}

function Activity({ s, open }: { s: ErrorWatchSummary; open: OpenLogs }) {
  const label = (app: string) =>
    s.sentry.apps.find((a) => a.app === app)?.label ?? s.logs.apps.find((a) => a.app === app)?.label ?? app;
  const openAlert = (a: WatchAlert) => {
    if (isCloudflare(a.kind)) {
      const worker = a.kind === "cf_worker" ? a.issueId.slice(4) : undefined;
      open({
        title: worker ? `${a.title.split(":")[0]} · Worker` : `${a.app} · Cloudflare`,
        description: worker ? "The Worker's errors per day and how its invocations ended." : "Edge 5xx on production hosts, the hosts and paths behind them, and what the firewall blocked.",
        drill: worker ? { kind: "cloudflare", worker } : { kind: "cloudflare", zone: a.app },
      });
      return;
    }
    if (a.kind === "logs_spike") {
      open({ title: `${label(a.app)} · log failures`, description: "Failure lines from the app's server logs, last 24h, grouped.", drill: { kind: "app", app: a.app, source: "logs" } });
      return;
    }
    const i = s.attention.find((x) => x.id === a.issueId) ?? s.issues.find((x) => x.id === a.issueId);
    if (i) open(issueRequest(i));
    else open({ title: `${a.shortId}: ${a.title}`, description: label(a.app), drill: { kind: "issue", id: a.issueId } });
  };
  // Alerts and dev items saved before they carried a link: find it on the issue.
  const linkOf = (issueId: string) => (s.attention.find((x) => x.id === issueId) ?? s.issues.find((x) => x.id === issueId))?.link;
  const alerts = [...s.alerts].sort((a, b) => b.at - a.at);
  const devItems = [...s.devItems].sort((a, b) => b.at - a.at);
  return (
    <div id="activity" className="grid scroll-mt-16 gap-4 md:grid-cols-2 [&>*]:min-w-0">
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>Recent alerts</CardTitle>
          <CardDescription className="text-xs">
            One per newly flagged error that hits customers (deduped for 3 days), Cloudflare site or Worker flagged (once a day), or host down for an hour. {s.settings.alerts ? "Posted to Slack." : "Slack alerts are off, so these were only recorded."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {alerts.length ? (
            <ul className="divide-y">
              {alerts.map((a) => (
                <li key={`${a.issueId}|${a.at}`} className="grid gap-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <RelativeTime at={Math.floor(a.at / 1000)} />
                    <span>{label(a.app)}</span>
                    <StatusChip tone={ALERT_KIND[a.kind].tone}>{ALERT_KIND[a.kind].label}</StatusChip>
                    <span>{a.ts ? "posted to Slack" : "not posted"}</span>
                    <ErrorLink href={a.link ?? linkOf(a.issueId)} logs={a.kind === "logs_spike"} cloudflare={isCloudflare(a.kind)} />
                  </div>
                  <button
                    type="button"
                    onClick={() => openAlert(a)}
                    className="min-w-0 truncate text-left text-sm underline decoration-dotted underline-offset-4 hover:decoration-solid"
                    title={a.title}
                  >
                    {a.kind === "logs_spike" || isCloudflare(a.kind) ? (isCloudflare(a.kind) && a.kind !== "cf_worker" ? `${a.app}: ` : "") : `${a.shortId}: `}
                    {a.title || "(no message)"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No alerts yet" />
          )}
        </CardContent>
      </Card>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>Dev items</CardTitle>
          <CardDescription className="text-xs">
            For a flagged error with no dev item that hit more than one account, or whose customer already wrote in.{" "}
            {s.settings.devItems === "on"
              ? "Filed on the dev board, at most 2 a day."
              : s.settings.devItems === "shadow"
                ? "Shadow mode: listed here, nothing filed."
                : "Switched off."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {devItems.length ? (
            <ul className="divide-y">
              {devItems.map((d) => (
                <li key={`${d.issueId}|${d.at}`} className="grid gap-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <RelativeTime at={Math.floor(d.at / 1000)} className="text-muted-foreground" />
                    <span className="text-muted-foreground">{label(d.app)}</span>
                    {devItemState(d)}
                    <ErrorLink href={d.link ?? linkOf(d.issueId)} />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const i = s.attention.find((x) => x.id === d.issueId) ?? s.issues.find((x) => x.id === d.issueId);
                      open(i ? issueRequest(i) : { title: `${d.shortId}: ${d.title}`, description: label(d.app), drill: { kind: "issue", id: d.issueId } });
                    }}
                    className="min-w-0 truncate text-left text-sm underline decoration-dotted underline-offset-4 hover:decoration-solid"
                    title={d.title}
                  >
                    {d.shortId}: {d.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No dev items yet" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function LogsPanel() {
  const [summary, setSummary] = useState<ErrorWatchSummary | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [drill, setDrill] = useState<LogsDrillRequest | null>(null);
  const open = useCallback<OpenLogs>((req) => setDrill(req), []);

  const load = useCallback(() => {
    fetch("/api/admin/error-watch", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
        setSummary(d.summary ?? null);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useDataVersion(["errorwatch"], load);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/admin/error-watch", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
      toast.success(
        `Checked · ${d.flagged ?? 0} flagged · ${d.alerts ?? 0} new alert${d.alerts === 1 ? "" : "s"} · ${d.devItems ?? 0} dev item${d.devItems === 1 ? "" : "s"}`,
      );
      if (d.summary !== undefined) setSummary(d.summary);
      else load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const runButton = (
    <Button variant="outline" size="sm" onClick={runNow} disabled={running}>
      <RotateCw className={running ? "animate-spin" : undefined} />
      {running ? "Reading Sentry, the logs and Cloudflare…" : "Run now"}
    </Button>
  );

  const header = (
    <PageHeader
      title="Logs & errors"
      description={DESCRIPTION}
      actions={
        summary ? (
          <>
            <span className="text-xs text-muted-foreground">
              Last run <RelativeTime at={Math.floor(summary.computedAt / 1000)} />
            </span>
            {runButton}
          </>
        ) : undefined
      }
    />
  );

  if (err) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{err}</AlertTitle>
        </Alert>
      </>
    );
  }
  if (summary === undefined) {
    return (
      <>
        {header}
        <div className="grid gap-4">
          <Skeleton className="h-12" />
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }
  if (!summary) {
    return (
      <>
        {header}
        <EmptyState
          icon={Bug}
          title="The error watch hasn't run yet"
          hint="An hourly job reads Sentry and the apps' server logs. Run now reads them immediately (30 to 60 seconds)."
          action={runButton}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
        <StatusStrip s={summary} />
        <div id="ai-read" className="scroll-mt-16">
          <InsightCard
            endpoint="/api/admin/error-watch/insight"
            basedOn={summary.computedAt}
            open={open}
            unit="event"
            description="Written from the numbers on this page: what is healthy, what is worth watching, and what to do. Each point links to the error or app behind it."
          />
        </div>
        <Attention s={summary} open={open} />
        <ByApp s={summary} open={open} />
        <CloudflareCard s={summary} open={open} />
        <Activity s={summary} open={open} />
      </div>
      <LogsDrillSheet request={drill} summary={summary} open={open} onClose={() => setDrill(null)} />
    </>
  );
}
