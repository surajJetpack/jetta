"use client";

import { useCallback, useEffect, useState } from "react";
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
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { useDataVersion } from "@/lib/use-data-version";
import { JETTA_LIVE_DATE, weekStart, type PerformanceSummary, type PeriodStats } from "@/lib/performance";

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

function Headline({ recent, previous, baseline }: { recent: PeriodStats; previous: PeriodStats; baseline: PeriodStats }) {
  const metrics: MetricSpec[] = [
    {
      label: "Jetta drafted on",
      value: pct(recent.coverage),
      hint: `${recent.answered} answered tickets`,
    },
    {
      label: "Drafts used",
      value: pct(recent.usedRate),
      hint: delta(recent.usedRate, previous.usedRate, "pct") ?? "sent as-is or edited",
    },
    {
      label: "Median first reply",
      value: hrs(recent.firstReplyH),
      hint: `before Jetta: ${hrs(baseline.firstReplyH)}`,
    },
    {
      label: "First reply links a doc",
      value: pct(recent.linkRate),
      hint: `before Jetta: ${pct(baseline.linkRate)}`,
    },
    {
      label: "Reopened",
      value: pct(recent.reopenRate),
      hint: `before Jetta: ${pct(baseline.reopenRate)}`,
    },
  ];
  return <MetricRow metrics={metrics} />;
}

export default function PerformancePanel() {
  const [data, setData] = useState<{ summary: PerformanceSummary | null; sync: SyncInfo } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/performance", { cache: "no-store" })
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

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Last 28 days</CardTitle>
          <CardDescription className="text-xs">
            Tickets with at least one agent reply. Marketing and vendor mail nobody answers is left out.
          </CardDescription>
          <CardAction>{syncButton}</CardAction>
        </CardHeader>
        <CardContent className="px-4">
          <Headline recent={summary.recent} previous={summary.previous} baseline={summary.baseline} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <ChartCard
          title="What agents did with Jetta's drafts"
          description="Each suggestion against the reply the agent sent next, by the week the ticket arrived."
        >
          {liveWeeks.some((w) => w.judged > 0) ? (
            <ChartContainer config={useConfig} className="h-[200px] w-full">
              <BarChart data={liveWeeks} margin={{ left: -24, right: 0, top: 4 }}>
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
          <ChartContainer config={timeConfig} className="h-[200px] w-full">
            <LineChart data={weeks} margin={{ left: -24, right: 8, top: 4 }}>
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
          <ChartContainer config={volumeConfig} className="h-[200px] w-full">
            <BarChart data={weeks} margin={{ left: -24, right: 0, top: 4 }}>
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

      <Card className="py-4">
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
                    <TableCell className="text-right tabular-nums">{a.firstReplies}</TableCell>
                    <TableCell className="text-right tabular-nums">{hrs(a.firstReplyH)}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.afterSuggestion}</TableCell>
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
    </div>
  );
}
