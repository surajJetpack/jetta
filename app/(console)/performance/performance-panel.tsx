"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Gauge, RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { useDataVersion } from "@/lib/use-data-version";
import { decodePerfDrill } from "@/lib/drill-code";
import { JETTA_LIVE_DATE, weekStart, type PerfRow, type PerformanceSummary, type PeriodStats } from "@/lib/performance";
import HandoffPanel from "./handoff-panel";
import { PerfDrillSheet, type OpenPerf, type PerfDrillRequest } from "./perf-drill";
import { InsightCard } from "@/components/jetta/insight-card";

interface SyncInfo {
  cursor: string;
  queued: number;
  lastRunAt: number | null;
  lastError: string | null;
}

const LIVE_WEEK = weekStart(`${JETTA_LIVE_DATE}T00:00:00Z`);

// Same tokens and meaning as Insights' "Decisions per day" — sent as-is /
// edited / not used read identically on both pages.
const useConfig = {
  asIs: { label: "Sent as-is", color: "var(--chart-2)" },
  edited: { label: "Edited", color: "var(--chart-3)" },
  notUsed: { label: "Not used", color: "var(--chart-5)" },
} satisfies ChartConfig;

const timeConfig = {
  firstReplyH: { label: "First reply", color: "var(--chart-1)" },
  draftWaitH: { label: "Draft waiting for an agent", color: "var(--chart-4)" },
} satisfies ChartConfig;

const volumeConfig = {
  answered: { label: "Answered tickets", color: "var(--chart-1)" },
} satisfies ChartConfig;

const chatConfig = {
  alone: { label: "Finished by Jetta", color: "var(--chart-2)" },
  handedOff: { label: "Handed to the team", color: "var(--chart-4)" },
} satisfies ChartConfig;

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const hrs = (v: number | null) => (v == null ? "—" : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);
/** "Sep 14" tick from a "2026-09-14" week key. */
const weekTick = (w: string) =>
  new Date(`${w}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** "+6 pts vs prior 28 days" — the delta a reader actually compares. */
function delta(now: number | null, before: number | null, kind: "pct" | "hrs"): string | undefined {
  if (now == null || before == null) return undefined;
  if (kind === "pct") {
    const d = Math.round((now - before) * 100);
    return `${d >= 0 ? "+" : ""}${d} pts vs prior 28 days`;
  }
  const d = now - before;
  return `${d >= 0 ? "+" : "−"}${hrs(Math.abs(d))} vs prior 28 days`;
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

function Headline({
  recent,
  previous,
  baseline,
  open,
}: {
  recent: PeriodStats;
  previous: PeriodStats;
  baseline: PeriodStats;
  open: OpenPerf;
}) {
  const metrics: MetricSpec[] = [
    {
      label: "Jetta drafted on",
      value: pct(recent.coverage),
      hint: `${recent.answered} answered tickets`,
      onClick: () =>
        open({
          title: "Jetta drafted on",
          description: "Tickets from the last 28 days an agent answered, the ones without a Jetta draft first.",
          drill: { kind: "coverage" },
        }),
    },
    {
      label: "Drafts used",
      value: pct(recent.usedRate),
      hint: delta(recent.usedRate, previous.usedRate, "pct") ?? "sent as-is or edited",
      onClick: () =>
        open({
          title: "Drafts used",
          description: "Tickets from the last 28 days with a draft an agent replied after, unused drafts first.",
          drill: { kind: "used" },
        }),
    },
    {
      label: "Median first reply",
      value: hrs(recent.firstReplyH),
      hint: `before Jetta: ${hrs(baseline.firstReplyH)}`,
      onClick: () =>
        open({
          title: "First reply times",
          description: "Answered tickets from the last 28 days, slowest first, with who sent the first reply.",
          drill: { kind: "firstReply" },
        }),
    },
    {
      label: "First reply links a doc",
      value: pct(recent.linkRate),
      hint: `before Jetta: ${pct(baseline.linkRate)}`,
      onClick: () =>
        open({
          title: "First reply links a doc",
          description: "Answered tickets from the last 28 days, the ones whose first reply linked a doc first.",
          drill: { kind: "link" },
        }),
    },
    {
      label: "Reopened",
      value: pct(recent.reopenRate),
      hint: `before Jetta: ${pct(baseline.reopenRate)}`,
      onClick: () =>
        open({
          title: "Reopened tickets",
          description: "Answered tickets from the last 28 days the customer came back on after they were resolved.",
          drill: { kind: "reopened" },
        }),
    },
  ];
  return <MetricRow metrics={metrics} />;
}

export default function PerformancePanel() {
  const [data, setData] = useState<{ summary: PerformanceSummary | null; sync: SyncInfo } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [drill, setDrill] = useState<PerfDrillRequest | null>(null);
  // The tickets behind the numbers: fetched on the first click, dropped when the numbers change.
  const [rows, setRows] = useState<PerfRow[] | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [rowsMissing, setRowsMissing] = useState(false);
  const rowsReq = useRef<Promise<void> | null>(null);
  const open = useCallback<OpenPerf>((req) => setDrill(req), []);

  // ?drill=<code> opens the ticket list behind a number — what a pasted link or
  // the voice assistant lands on. Applied once per code, then dropped from the
  // URL on close, so a background refresh never reopens a sheet someone shut.
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const drillParam = search.get("drill");
  const titleParam = search.get("title");
  // Adjusted during render rather than in an effect: the sheet follows the URL
  // the moment the numbers are there, with no extra render in between.
  const [appliedDrill, setAppliedDrill] = useState<string | null>(null);
  if (data && drillParam && drillParam !== appliedDrill) {
    setAppliedDrill(drillParam);
    const d = decodePerfDrill(drillParam);
    if (d) setDrill({ title: titleParam || "Tickets", description: "Opened from a link to this list.", drill: d });
  }
  if (!drillParam && appliedDrill) setAppliedDrill(null);
  const closeDrill = useCallback(() => {
    setDrill(null);
    if (drillParam) router.replace(pathname, { scroll: false });
  }, [drillParam, pathname, router]);

  const load = useCallback(() => {
    fetch("/api/admin/performance", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        setData(d);
        setErr(null);
        setRows(null);
        rowsReq.current = null;
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // The hourly sync bumps this marker; an open tab picks it up without polling the data.
  useDataVersion(["performance"], load);
  // Also re-runs when a refresh drops the rows under an open sheet.
  useEffect(() => {
    if (!drill || rows || rowsReq.current) return;
    setRowsErr(null);
    rowsReq.current = fetch("/api/admin/performance?rows=1", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        setRowsMissing(d.rows == null);
        setRows(d.rows ?? []);
      })
      .catch((e) => {
        setRowsErr(e instanceof Error ? e.message : String(e));
        rowsReq.current = null;
      });
  }, [drill, rows]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/admin/performance", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
      toast.success(`Read ${d.read} ticket${d.read === 1 ? "" : "s"} from Freshdesk${d.queued ? ` · ${d.queued} still queued` : ""}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

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
        <Skeleton className="h-20" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const { summary, sync } = data;
  const syncButton = (
    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
      <RotateCw className={syncing ? "animate-spin" : undefined} />
      {syncing ? "Reading Freshdesk…" : "Sync now"}
    </Button>
  );

  if (!summary || summary.tickets === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title="No Freshdesk data yet"
        hint="An hourly job reads tickets from Freshdesk slowly, so it never competes with live Jetta. The first fill takes most of a day. Sync now reads one batch immediately."
        action={syncButton}
      />
    );
  }

  // Pre-launch "drafts" were a handful of test runs — plotting their wait would
  // draw a line through weeks when no agent was working from Jetta at all.
  const weeks = summary.weeks.map((w) => (w.week >= LIVE_WEEK ? w : { ...w, draftWaitH: null }));
  const liveWeeks = weeks.filter((w) => w.week >= LIVE_WEEK);
  const chatWeeks = summary.chat?.weeks ?? [];

  /** A click anywhere in a weekly chart opens the week under the cursor. */
  const onWeek =
    (metric: "drafts" | "firstReply" | "answered", title: string, description: string) =>
    (state: { activeLabel?: string | number }) => {
      const week = state.activeLabel != null ? String(state.activeLabel) : null;
      if (!week) return;
      open({ title: `${title} · week of ${weekTick(week)}`, description, drill: { kind: "week", week, metric } });
    };

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <div id="ai-read" className="scroll-mt-16">
        <InsightCard
          endpoint="/api/admin/performance/insight"
          basedOn={summary.computedAt}
          open={open}
          description="Is Jetta helping? Written from the numbers on this page; each point links to the tickets behind it. It may name agents — read it as a question about the drafts, not a score."
        />
      </div>

      <Card id="last-28-days" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Last 28 days</CardTitle>
          <CardDescription className="text-xs">
            Tickets with at least one agent reply. Marketing and vendor mail nobody answers is left out. Click any
            number to see the tickets behind it.
          </CardDescription>
          <CardAction>{syncButton}</CardAction>
        </CardHeader>
        <CardContent className="px-4">
          <Headline recent={summary.recent} previous={summary.previous} baseline={summary.baseline} open={open} />
        </CardContent>
      </Card>

      {summary.handoffs && <HandoffPanel h={summary.handoffs} ticketUrlBase={summary.ticketUrlBase} open={open} />}

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <ChartCard
          title="What agents did with Jetta's drafts"
          description="Each suggestion against the reply the agent sent next, by the week the ticket arrived."
        >
          {liveWeeks.some((w) => w.judged > 0) ? (
            <ChartContainer config={useConfig} className="h-[200px] w-full cursor-pointer">
              <BarChart
                data={liveWeeks}
                margin={{ left: -24, right: 0, top: 4 }}
                onClick={onWeek("drafts", "Drafts", "This week's tickets with a draft an agent replied after, unused drafts first.")}
              >
                <CartesianGrid vertical={false} strokeOpacity={0.4} />
                <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="asIs" stackId="u" fill="var(--color-asIs)" stroke="var(--card)" strokeWidth={2} />
                <Bar dataKey="edited" stackId="u" fill="var(--color-edited)" stroke="var(--card)" strokeWidth={2} />
                <Bar dataKey="notUsed" stackId="u" fill="var(--color-notUsed)" stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <EmptyState title="No judged drafts yet" />
          )}
        </ChartCard>

        <ChartCard
          title="How long customers waited"
          description="Median hours to the first agent reply, and how long Jetta's draft sat before an agent sent a reply."
        >
          <ChartContainer config={timeConfig} className="h-[200px] w-full cursor-pointer">
            <LineChart
              data={weeks}
              margin={{ left: -24, right: 8, top: 4 }}
              onClick={onWeek("firstReply", "First replies", "This week's answered tickets, slowest first.")}
            >
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} unit="h" />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <ReferenceLine x={LIVE_WEEK} stroke="var(--muted-foreground)" strokeDasharray="3 3" label={{ value: "Jetta live", fontSize: 10, fill: "var(--muted-foreground)", position: "insideTopLeft" }} />
              <Line dataKey="firstReplyH" type="monotone" stroke="var(--color-firstReplyH)" strokeWidth={2} dot={false} connectNulls />
              <Line dataKey="draftWaitH" type="monotone" stroke="var(--color-draftWaitH)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard title="Answered tickets per week" description="The queue the team worked, before and after Jetta.">
          <ChartContainer config={volumeConfig} className="h-[200px] w-full cursor-pointer">
            <BarChart
              data={weeks}
              margin={{ left: -24, right: 0, top: 4 }}
              onClick={onWeek("answered", "Answered tickets", "Tickets that arrived this week and got at least one agent reply.")}
            >
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
              <ReferenceLine x={LIVE_WEEK} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
              <Bar dataKey="answered" fill="var(--color-answered)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Live chat"
          description="Real conversations only — greetings and tests left out. Finished means no ticket and no person."
        >
          {chatWeeks.length ? (
            <ChartContainer config={chatConfig} className="h-[200px] w-full">
              <BarChart data={chatWeeks} margin={{ left: -24, right: 0, top: 4 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.4} />
                <XAxis dataKey="week" tickFormatter={weekTick} tickLine={false} axisLine={false} fontSize={10} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${weekTick(String(w))}`} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="alone" stackId="c" fill="var(--color-alone)" stroke="var(--card)" strokeWidth={2} />
                <Bar dataKey="handedOff" stackId="c" fill="var(--color-handedOff)" stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : (
            <EmptyState title="No live chats yet" />
          )}
        </ChartCard>
      </div>

      <Card id="by-agent" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">By agent, last 28 days</CardTitle>
          <CardDescription className="text-xs">
            For coaching, not ranking. A low draft-use rate is a question to ask — which drafts don&apos;t help, and why — not a score.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {summary.agents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">First replies</TableHead>
                  <TableHead className="text-right">Median first reply</TableHead>
                  <TableHead className="text-right">Replies after a Jetta draft</TableHead>
                  <TableHead className="text-right">Built on her draft</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.agents.map((a) => (
                  <TableRow key={a.agent}>
                    <TableCell className="font-medium">{a.agent}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <CellLink
                        n={a.firstReplies}
                        onClick={() =>
                          open({
                            title: `${a.agent} · first replies`,
                            description: "Tickets from the last 28 days where this agent sent the first reply, slowest first.",
                            drill: { kind: "agent", agent: a.agent, metric: "firstReplies" },
                          })
                        }
                      >
                        {a.firstReplies}
                      </CellLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{hrs(a.firstReplyH)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <CellLink
                        n={a.afterSuggestion}
                        onClick={() =>
                          open({
                            title: `${a.agent} · replies after a Jetta draft`,
                            description: "Tickets from the last 28 days where this agent replied after a Jetta draft, unused drafts first.",
                            drill: { kind: "agent", agent: a.agent, metric: "afterSuggestion" },
                          })
                        }
                      >
                        {a.afterSuggestion}
                      </CellLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{pct(a.usedRate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No agent replies in the last 28 days" />
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {summary.tickets} tickets since {summary.since}, read from Freshdesk hourly.
        {sync.lastRunAt ? (
          <>
            {" "}Last sync <RelativeTime at={Math.floor(sync.lastRunAt / 1000)} />.
          </>
        ) : null}
        {sync.queued > 0 && ` ${sync.queued} tickets still waiting to be read — numbers fill in as they are.`}
        {sync.lastError && ` Last sync stopped early: ${sync.lastError}`}{" "}
        Draft use compares text, so an agent who sends the
        same answer in their own words counts as &ldquo;not used&rdquo;.
      </p>

      <PerfDrillSheet
        request={drill}
        rows={rows}
        error={rowsErr}
        notBuilt={rowsMissing}
        now={summary.computedAt}
        base={summary.ticketUrlBase ?? ""}
        onClose={closeDrill}
      />
    </div>
  );
}
