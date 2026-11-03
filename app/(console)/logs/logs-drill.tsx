"use client";

import { ExternalLink } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { StatusChip } from "@/components/jetta/status-chip";
import { SectionHeader } from "@/components/jetta/page-header";
import { fmtDayKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ErrorWatchSummary, WatchDrill, WatchFlag, WatchIssue } from "@/lib/error-watch";

export interface LogsDrillRequest {
  title: string;
  description: string;
  drill: WatchDrill;
}
export type OpenLogs = (r: LogsDrillRequest) => void;

/** Unix seconds from an ISO time, for RelativeTime. */
export const isoSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The drill request for one issue: the same wording wherever it is opened from. */
export function issueRequest(i: WatchIssue): LogsDrillRequest {
  return {
    title: `${i.shortId}: ${i.title}`,
    description: i.where ? `${i.appLabel} · ${i.where}` : i.appLabel,
    drill: { kind: "issue", id: i.id },
  };
}

export function FlagChips({ flags, noise }: { flags: WatchFlag[]; noise?: string }) {
  if (!flags.length && !noise) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.includes("new") && <StatusChip tone="in_review">new</StatusChip>}
      {flags.includes("spike") && <StatusChip tone="stale">spike</StatusChip>}
      {noise && (
        <span title={`Never flagged: ${noise}`}>
          <StatusChip tone="archived">noise</StatusChip>
        </span>
      )}
    </span>
  );
}

/**
 * Fourteen days as a row of tiny bars, for a table cell. A day Sentry stored
 * nothing is a faint full-height bar: missing, not quiet.
 */
export function DailySpark({
  daily,
  days,
  gapDays,
  color,
  label,
}: {
  daily: number[];
  days: string[];
  gapDays?: string[];
  color: string;
  label: string;
}) {
  const W = 4, G = 1, H = 20;
  const gaps = new Set(gapDays ?? []);
  const max = Math.max(1, ...daily.filter((_, i) => !gaps.has(days[i])));
  const title = daily.map((n, i) => `${days[i] ? fmtDayKey(days[i]) : ""}: ${gaps.has(days[i]) ? "no data" : n}`).join("\n");
  return (
    <svg
      width={daily.length * (W + G) - G}
      height={H}
      viewBox={`0 0 ${daily.length * (W + G) - G} ${H}`}
      role="img"
      aria-label={label}
      className="inline-block align-middle"
    >
      <title>{title}</title>
      {daily.map((n, i) => {
        const gap = gaps.has(days[i]);
        const h = gap ? H : n ? Math.max(1.5, (n / max) * H) : 0.75;
        return (
          <rect
            key={i}
            x={i * (W + G)}
            y={H - h}
            width={W}
            height={h}
            rx={0.75}
            fill={gap || !n ? "var(--muted-foreground)" : color}
            fillOpacity={gap ? 0.15 : n ? 1 : 0.35}
          />
        );
      })}
    </svg>
  );
}

const dailyConfig = {
  value: { label: "Count", color: "var(--chart-1)" },
  noData: { label: "No data", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

/** A 14-day bar chart. Gap days get a faint full bar labelled "no data" instead of a zero. */
function DailyChart({ daily, days, gapDays, unit, color }: { daily: number[]; days: string[]; gapDays: string[]; unit: string; color: string }) {
  const gaps = new Set(gapDays);
  const max = Math.max(1, ...daily.filter((_, i) => !gaps.has(days[i])));
  const data = days.map((day, i) => ({
    day,
    value: gaps.has(day) ? null : (daily[i] ?? 0),
    noData: gaps.has(day) ? max : null,
  }));
  return (
    <ChartContainer config={{ ...dailyConfig, value: { label: unit, color } }} className="h-[160px] w-full">
      <BarChart data={data} margin={{ left: -24, right: 0, top: 4 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.4} />
        <XAxis dataKey="day" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={16} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(d) => fmtDayKey(String(d))}
              formatter={(v, name) => (
                <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                  <span className="text-muted-foreground">{name === "noData" ? "Sentry stored nothing" : unit}</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">{name === "noData" ? "no data" : String(v)}</span>
                </div>
              )}
            />
          }
        />
        <Bar dataKey="value" stackId="d" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="noData" stackId="d" fill="var(--color-noData)" fillOpacity={0.15} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function IssueBody({ issue: i, summary }: { issue: WatchIssue; summary: ErrorWatchSummary }) {
  const resolved = i.status === "resolved";
  return (
    <div className="grid gap-5 pt-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <a href={i.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-4">
          Open {i.shortId} in Sentry <ExternalLink className="size-3" aria-hidden />
        </a>
        <FlagChips flags={i.flags} noise={i.noise} />
        {i.frontend && <StatusChip tone="archived">browser</StatusChip>}
      </div>
      {i.noise && <p className="text-xs text-muted-foreground">Known noise, never flagged: {i.noise}.</p>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Last 24h">{i.events24h}</Fact>
        <Fact label="Usual day">{i.baseline}</Fact>
        <Fact label="Last 7 days">{i.events7d}</Fact>
        <Fact label="Users">{i.users}</Fact>
        <Fact label="First seen">
          <RelativeTime at={isoSec(i.firstSeen)} />
        </Fact>
        <Fact label="Last seen">
          <RelativeTime at={isoSec(i.lastSeen)} />
        </Fact>
        <Fact label="Sentry status">{i.status ?? "—"}</Fact>
        <Fact label="Accounts hit">{i.accountsDistinct ?? "—"}</Fact>
      </dl>
      {resolved && (
        <p className="text-xs text-muted-foreground">
          Sentry &ldquo;resolved&rdquo; does not mean fixed: issues auto-resolve while they still fire. Check the last-seen time.
        </p>
      )}

      <div>
        <SectionHeader className="mb-1.5" meta="UTC days; the last is today so far">
          Events per day
        </SectionHeader>
        <DailyChart daily={i.daily} days={summary.days} gapDays={summary.sentry.gapDays} unit="Events" color="var(--chart-1)" />
        {summary.sentry.gapDays.length > 0 && (
          <p className="text-xs text-muted-foreground">Faint bars are days Sentry stored nothing (over its quota): missing, not quiet.</p>
        )}
      </div>

      <div>
        <SectionHeader className="mb-1.5" meta={i.accountsDistinct != null ? plural(i.accountsDistinct, "account") : undefined}>
          Accounts it hit
        </SectionHeader>
        {i.accounts?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Account id</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {i.accounts.map((a, k) => (
                <TableRow key={`${a.id ?? ""}|${a.slug ?? ""}|${k}`}>
                  <TableCell className="font-medium">{a.slug ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{a.id ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.events}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{a.lastSeen ? <RelativeTime at={isoSec(a.lastSeen)} /> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">
            {i.accounts ? "No account tags on this error." : "Accounts are looked up for flagged errors only."}
          </p>
        )}
      </div>

      <div>
        <SectionHeader className="mb-1.5">Tickets from those accounts</SectionHeader>
        {i.tickets?.length ? (
          <ul className="grid gap-1 text-sm">
            {i.tickets.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2">
                <a href={t.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                  #{t.id}
                </a>
                {t.status && <StatusChip tone="archived">{t.status}</StatusChip>}
                <span className="text-xs text-muted-foreground">{t.slug}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </div>

      <div>
        <SectionHeader className="mb-1.5">Dev item</SectionHeader>
        <DevItemLine item={i.devItem} />
      </div>
    </div>
  );
}

export function DevItemLine({ item, compact }: { item: WatchIssue["devItem"]; compact?: boolean }) {
  if (!item) return <span className="text-sm text-muted-foreground">none</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", compact ? "text-xs" : "text-sm")}>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn("min-w-0 underline decoration-dotted underline-offset-4 hover:decoration-solid", compact && "max-w-48 truncate")}
        title={item.name}
      >
        {item.name}
      </a>
      {item.status && <StatusChip tone={item.open ? "draft" : "published"}>{item.status}</StatusChip>}
    </span>
  );
}

function SentryAppBody({ app, summary, open }: { app: string; summary: ErrorWatchSummary; open: OpenLogs }) {
  const row = summary.sentry.apps.find((a) => a.app === app);
  const list = summary.issues.filter((i) => i.app === app).sort((a, b) => b.events7d - a.events7d);
  return (
    <div className="grid gap-5 pt-4">
      {row && (
        <div>
          <SectionHeader className="mb-1.5" meta="UTC days; the last is today so far">
            Errors per day, the app&apos;s watched issues
          </SectionHeader>
          <DailyChart daily={row.daily} days={summary.days} gapDays={summary.sentry.gapDays} unit="Errors" color="var(--chart-1)" />
          {row.failed.length > 0 && (
            <p className="text-xs text-tone-warn">Couldn&apos;t read: {row.failed.join(", ")}. These numbers are incomplete.</p>
          )}
        </div>
      )}
      {list.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead className="text-right">24h</TableHead>
              <TableHead className="text-right">7d</TableHead>
              <TableHead className="text-right">Usual day</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="max-w-md whitespace-normal">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a href={i.link} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-4">
                      {i.shortId}
                    </a>
                    <FlagChips flags={i.flags} noise={i.noise} />
                  </div>
                  <button
                    type="button"
                    onClick={() => open(issueRequest(i))}
                    className="mt-0.5 text-left text-sm break-words underline decoration-dotted underline-offset-4 hover:decoration-solid"
                  >
                    {i.title}
                  </button>
                  {i.where && <p className="text-xs break-words text-muted-foreground">{i.where}</p>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{i.events24h}</TableCell>
                <TableCell className="text-right tabular-nums">{i.events7d}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{i.baseline}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title="No Sentry issues watched for this app" />
      )}
    </div>
  );
}

function LogsAppBody({ app, summary }: { app: string; summary: ErrorWatchSummary }) {
  const row = summary.logs.apps.find((a) => a.app === app);
  if (!row) return <EmptyState title="This app has no server logs in CloudWatch" />;
  return (
    <div className="grid gap-5 pt-4">
      {row.error && <p className="text-xs text-tone-warn">The last read failed: {row.error}</p>}
      <div>
        <SectionHeader className="mb-1.5" meta="UTC days; the last is today so far">
          Failure lines per day
        </SectionHeader>
        <DailyChart daily={row.daily} days={summary.days} gapDays={[]} unit="Failure lines" color="var(--chart-4)" />
      </div>
      <div>
        <SectionHeader className="mb-1.5" meta="last 24h, grouped, newest first">
          Failures
        </SectionHeader>
        {row.top.length ? (
          <ul className="divide-y">
            {row.top.map((t, k) => (
              <li key={k} className="grid gap-1 py-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">{t.count}×</span>
                  <span>
                    newest <RelativeTime at={isoSec(t.at)} />
                  </span>
                  <span className="font-mono break-all">{t.group}</span>
                  {t.link && (
                    <a href={t.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
                      Open in CloudWatch <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </div>
                <pre className="rounded bg-muted px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap">{t.message}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No failure lines in the last 24h.</p>
        )}
      </div>
    </div>
  );
}

/** What a number on /logs is made of: one Sentry issue, or one app's Sentry issues or log failures. */
export function LogsDrillSheet({
  request,
  summary,
  open,
  onClose,
}: {
  request: LogsDrillRequest | null;
  summary: ErrorWatchSummary;
  open: OpenLogs;
  onClose: () => void;
}) {
  const d = request?.drill;
  const issue = d?.kind === "issue" ? (summary.attention.find((i) => i.id === d.id) ?? summary.issues.find((i) => i.id === d.id)) : undefined;
  return (
    <Sheet open={!!request} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 sm:max-w-3xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="border-b">
          <SheetTitle className="break-words">{request?.title}</SheetTitle>
          <SheetDescription className="text-xs break-words">{request?.description}</SheetDescription>
          <p className="text-xs text-muted-foreground">
            As of the run <RelativeTime at={Math.floor(summary.computedAt / 1000)} />.
          </p>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {!d ? null : d.kind === "issue" ? (
            issue ? (
              <IssueBody issue={issue} summary={summary} />
            ) : (
              <EmptyState title="This issue isn't in the latest run" hint="It dropped out of each app's most active issues. Open it in Sentry instead." />
            )
          ) : d.source === "sentry" ? (
            <SentryAppBody app={d.app} summary={summary} open={open} />
          ) : (
            <LogsAppBody app={d.app} summary={summary} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
