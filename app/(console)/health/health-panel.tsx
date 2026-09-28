"use client";

import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { HeartPulse, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { useDataVersion } from "@/lib/use-data-version";
import { appName } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  TARGETS,
  toneAbove,
  toneBelow,
  type AppHealth,
  type Backlog,
  type HealthPeriod,
  type SupportHealth,
} from "@/lib/support-health";

interface Payload {
  health: SupportHealth | null;
  sync: { lastRunAt: number | null; queued: number };
  ticketUrlBase: string;
}

const volumeConfig = { tickets: { label: "Tickets", color: "var(--chart-1)" } } satisfies ChartConfig;
const speedConfig = { firstReplyH: { label: "Median first reply", color: "var(--chart-1)" } } satisfies ChartConfig;
const withinConfig = { withinTarget: { label: `Answered within ${TARGETS.firstReplyH}h`, color: "var(--chart-2)" } } satisfies ChartConfig;
const reopenConfig = { reopenRate: { label: "Reopened", color: "var(--chart-4)" } } satisfies ChartConfig;

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) =>
  v == null ? "—" : v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} days`;
const weekTick = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** Tooltip row with a formatted value — the default prints raw 0.912 and 13.84. */
const tipRow = (label: string, f: (v: number) => string) =>
  function TipRow(v: unknown) {
    return (
      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium text-foreground tabular-nums">{f(Number(v))}</span>
      </div>
    );
  };

const PRIOR = "vs prior 28 days";
function countDelta(now: number, before: number): string {
  const d = now - before;
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} ${PRIOR}`;
}
function pctDelta(now: number | null, before: number | null): string | undefined {
  if (now == null || before == null) return undefined;
  const d = Math.round((now - before) * 100);
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} pts ${PRIOR}`;
}
function hrsDelta(now: number | null, before: number | null): string | undefined {
  if (now == null || before == null) return undefined;
  const d = now - before;
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${hrs(Math.abs(d))} ${PRIOR}`;
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

function Headline({ recent, previous, backlog }: { recent: HealthPeriod; previous: HealthPeriod; backlog: Backlog }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets",
      value: recent.tickets,
      hint: countDelta(recent.tickets, previous.tickets),
    },
    {
      label: `Answered within ${TARGETS.firstReplyH}h`,
      value: pct(recent.withinTarget),
      tone: toneAbove(recent.withinTarget, TARGETS.firstReplyShare) ?? undefined,
      hint: pctDelta(recent.withinTarget, previous.withinTarget),
    },
    {
      label: "Median first reply",
      value: hrs(recent.firstReplyH),
      tone: toneBelow(recent.firstReplyH, TARGETS.medianFirstReplyH) ?? undefined,
      hint: `slowest 10%: over ${hrs(recent.firstReplyP90H)}`,
    },
    {
      label: "Reopened",
      value: pct(recent.reopenRate),
      tone: toneBelow(recent.reopenRate, TARGETS.reopenRate) ?? undefined,
      hint: pctDelta(recent.reopenRate, previous.reopenRate),
    },
    {
      label: "Waiting on us now",
      value: backlog.owesReply,
      tone: toneBelow(backlog.overdue, TARGETS.overdueNow) ?? undefined,
      hint: backlog.overdue
        ? `${backlog.overdue} over ${TARGETS.firstReplyH}h · longest ${hrs(backlog.oldestOwedH)}`
        : backlog.owesReply
          ? `none over ${TARGETS.firstReplyH}h`
          : "nobody waiting",
    },
  ];
  return <MetricRow metrics={metrics} />;
}

function Secondary({ recent, previous, chat }: { recent: HealthPeriod; previous: HealthPeriod; chat: SupportHealth["chat"] }) {
  const metrics: MetricSpec[] = [
    {
      label: `Answered within ${TARGETS.fastReplyH}h`,
      value: pct(recent.withinFast),
      hint: pctDelta(recent.withinFast, previous.withinFast),
    },
    {
      label: "Median time to resolve",
      value: hrs(recent.resolvedH),
      hint: hrsDelta(recent.resolvedH, previous.resolvedH),
    },
    {
      label: "Customer messages per ticket",
      value: recent.customerMsgsPerTicket?.toFixed(1) ?? "—",
      hint:
        previous.customerMsgsPerTicket != null
          ? `${previous.customerMsgsPerTicket.toFixed(1)} in the prior 28 days`
          : undefined,
    },
    {
      label: "Sent to engineering",
      value: pct(recent.engineeringRate),
      hint: pctDelta(recent.engineeringRate, previous.engineeringRate),
    },
    {
      label: "Live chats",
      value: chat ? chat.recent.real : "—",
      hint: chat ? countDelta(chat.recent.real, chat.previous.real) : undefined,
    },
  ];
  return <MetricRow metrics={metrics} />;
}

/** One bar, four segments — where the ball is on every open ticket. */
function BallBar({ b }: { b: Backlog }) {
  const parts = [
    { key: "owes", label: "Waiting on us", n: b.owesReply, cls: "bg-tone-bad" },
    { key: "eng", label: "With engineering", n: b.engineering, cls: "bg-tone-warn" },
    { key: "prog", label: "We're working on it", n: b.inProgress, cls: "bg-tone-info" },
    { key: "cust", label: "Waiting on the customer", n: b.customer, cls: "bg-muted-foreground/40" },
  ];
  if (!b.open) return null;
  return (
    <div className="grid gap-2">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(", ")}>
        {parts.filter((p) => p.n).map((p) => (
          <div key={p.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.cls)} style={{ flexGrow: p.n }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", p.cls)} aria-hidden />
            {p.label} <span className="font-medium text-foreground tabular-nums">{p.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RightNow({ b, base }: { b: Backlog; base: string }) {
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Right now · {b.open} open</CardTitle>
        <CardDescription className="text-xs">
          Whose turn it is, read from the conversation itself: a customer is waiting on us when theirs is the newest
          message, whatever the ticket&apos;s status says.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        <BallBar b={b} />
        {b.waiting.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer waiting on us</TableHead>
                <TableHead>App</TableHead>
                <TableHead className="hidden sm:table-cell">Status in Freshdesk</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.waiting.map((w) => (
                <TableRow key={w.ticketId}>
                  <TableCell className="max-w-[28rem] truncate">
                    <a href={`${base}${w.ticketId}`} target="_blank" rel="noreferrer" className="hover:underline">
                      <span className="text-muted-foreground tabular-nums">#{w.ticketId}</span> {w.subject}
                    </a>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{appName(w.app)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{w.status}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right whitespace-nowrap tabular-nums",
                      w.waitingH > TARGETS.firstReplyH && "font-medium text-tone-bad",
                    )}
                  >
                    {hrs(w.waitingH)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No customer is waiting on a reply" />
        )}
      </CardContent>
    </Card>
  );
}

function Delta({ now, before }: { now: number; before: number }) {
  if (!before && !now) return null;
  const d = now - before;
  if (!d) return <span className="text-muted-foreground">±0</span>;
  return <span className="text-muted-foreground">{d > 0 ? `+${d}` : `−${-d}`}</span>;
}

function ByApp({ apps }: { apps: AppHealth[] }) {
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">By app, last 28 days</CardTitle>
        <CardDescription className="text-xs">
          Bugs and knowledge gaps come from reviewing each ticket Jetta handed to people: did it need a developer, or
          just an answer she didn&apos;t have?
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {apps.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="text-right">Tickets</TableHead>
                <TableHead className="text-right">Median first reply</TableHead>
                <TableHead className="text-right">Reopened</TableHead>
                <TableHead className="text-right">Open · waiting on us</TableHead>
                <TableHead className="text-right">Real bugs</TableHead>
                <TableHead className="text-right">Knowledge gaps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((a) => (
                <TableRow key={a.app}>
                  <TableCell className={cn("font-medium", a.app === "unknown" && "text-muted-foreground")}>
                    {appName(a.app)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.tickets} <Delta now={a.tickets} before={a.previous} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{hrs(a.firstReplyH)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(a.reopenRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.open}
                    {a.owesReply ? <span className="text-tone-bad"> · {a.owesReply}</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{a.bugs || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.gaps || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No tickets in the last 28 days" />
        )}
      </CardContent>
    </Card>
  );
}

function Topics({ h }: { h: SupportHealth }) {
  const max = Math.max(1, ...h.topics.map((t) => t.count));
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">What customers asked about</CardTitle>
        <CardDescription className="text-xs">
          Last 28 days, by theme. {h.topicCoverage != null && `${pct(h.topicCoverage)} of tickets carry a theme.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {h.topics.length ? (
          <ul className="grid gap-2">
            {h.topics.map((t) => (
              <li key={t.topic} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="truncate text-sm first-letter:uppercase">{t.topic}</p>
                  {t.apps.length > 0 && (
                    <p className="truncate text-xs text-muted-foreground">{t.apps.map(appName).join(", ")}</p>
                  )}
                </div>
                <span className="text-sm tabular-nums">
                  {t.count}
                  {t.previous !== t.count && (
                    <span className="ml-1 text-xs text-muted-foreground">(was {t.previous})</span>
                  )}
                </span>
                <div className="col-span-2 h-1 rounded-full bg-muted">
                  <div className="h-1 rounded-full bg-chart-1" style={{ width: `${(t.count / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No themes yet" />
        )}
      </CardContent>
    </Card>
  );
}

function Load({ h }: { h: SupportHealth }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets with a Jetta draft",
      value: pct(h.recent.tickets ? h.load.ticketsDrafted / h.recent.tickets : null),
      hint: `${h.load.ticketsDrafted} of ${h.recent.tickets} · an agent reviews and sends each reply`,
    },
    {
      label: "Chats finished by Jetta",
      value: h.chat ? pct(h.chat.recent.real ? h.chat.recent.alone / h.chat.recent.real : null) : "—",
      hint: h.chat ? `${h.chat.recent.alone} of ${h.chat.recent.real} with no ticket and no person` : undefined,
    },
  ];
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Who carried the load</CardTitle>
        <CardDescription className="text-xs">Last 28 days. Every email reply is still sent by a person.</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <MetricRow metrics={metrics} className="sm:grid-cols-2" />
      </CardContent>
    </Card>
  );
}

export default function HealthPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/support-health", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // The hourly sync bumps this marker; an open tab picks it up without polling the data.
  useDataVersion(["performance"], load);

  if (err) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{err}</AlertTitle>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );
  }

  const { health: h, sync, ticketUrlBase } = data;
  if (!h) {
    return (
      <EmptyState
        icon={HeartPulse}
        title="No numbers yet"
        hint="These are computed by the hourly Freshdesk sync. The first ones appear after its next run."
      />
    );
  }

  // Complete weeks only: a Monday-morning partial week reads as a collapse.
  const weeks = h.weeks.filter((w) => !w.partial);

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Last 28 days</CardTitle>
          <CardDescription className="text-xs">
            Tickets a person answered or that are still open. Marketing and vendor mail closed without a reply is left
            out.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 px-4">
          <Headline recent={h.recent} previous={h.previous} backlog={h.backlog} />
          <div className="border-t pt-4">
            <Secondary recent={h.recent} previous={h.previous} chat={h.chat} />
          </div>
        </CardContent>
      </Card>

      <RightNow b={h.backlog} base={ticketUrlBase} />

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Tickets per week" description="By the week they arrived.">
          <ChartContainer config={volumeConfig} className="h-[180px] w-full">
            <BarChart data={weeks} margin={{ left: -24, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
              <Bar dataKey="tickets" fill="var(--color-tickets)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title={`Answered within ${TARGETS.firstReplyH} hours`}
          description={`Share of each week's tickets. The dashed line is the ${pct(TARGETS.firstReplyShare.good)} target.`}
        >
          <ChartContainer config={withinConfig} className="h-[180px] w-full">
            <LineChart data={weeks} margin={{ left: -16, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(w) => `Week of ${weekTick(String(w))}`}
                    formatter={tipRow(withinConfig.withinTarget.label, pct)}
                  />
                }
              />
              <ReferenceLine y={TARGETS.firstReplyShare.good} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
              <Line dataKey="withinTarget" type="monotone" stroke="var(--color-withinTarget)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard title="Median first reply" description="Hours from the customer writing in to the first human reply.">
          <ChartContainer config={speedConfig} className="h-[180px] w-full">
            <LineChart data={weeks} margin={{ left: -24, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} unit="h" />
              <ChartTooltip
                content={
                  <ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} formatter={tipRow("Median first reply", hrs)} />
                }
              />
              <Line dataKey="firstReplyH" type="monotone" stroke="var(--color-firstReplyH)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard title="Reopened" description="Share of each week's answered tickets the customer came back on after it was resolved.">
          <ChartContainer config={reopenConfig} className="h-[180px] w-full">
            <LineChart data={weeks} margin={{ left: -16, right: 8, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip
                content={
                  <ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} formatter={tipRow("Reopened", pct)} />
                }
              />
              <Line dataKey="reopenRate" type="monotone" stroke="var(--color-reopenRate)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        </ChartCard>
      </div>

      <ByApp apps={h.apps} />

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Topics h={h} />
        <Load h={h} />
      </div>

      <p className="text-xs text-muted-foreground">
        Read from Freshdesk hourly
        {sync.lastRunAt ? (
          <>
            , last <RelativeTime at={Math.floor(sync.lastRunAt / 1000)} />
          </>
        ) : null}
        .{sync.queued > 0 && ` ${sync.queued} recently changed tickets are still being read.`} Hours are calendar hours,
        weekends included: that is how long the customer waited. Targets: a first reply within {TARGETS.firstReplyH}h for{" "}
        {pct(TARGETS.firstReplyShare.good)} of tickets, a median under {TARGETS.medianFirstReplyH.good}h, reopens under{" "}
        {pct(TARGETS.reopenRate.good)}. There is no satisfaction score — surveys aren&apos;t on this Freshdesk plan — so
        reopens and back-and-forth stand in for quality.
      </p>
    </div>
  );
}
