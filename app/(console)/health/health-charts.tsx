"use client";

/** The four weekly charts on /health. A click anywhere in one opens the week under the cursor. */
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtDayKey, fmtHours } from "@/lib/format";
import { TARGETS, type SupportHealth } from "@/lib/support-health";
import { pct } from "./health-shared";

const volumeConfig = { tickets: { label: "Tickets", color: "var(--chart-1)" } } satisfies ChartConfig;
const speedConfig = { firstReplyH: { label: "Median first reply", color: "var(--chart-1)" } } satisfies ChartConfig;
const withinConfig = { withinTarget: { label: `Answered within ${TARGETS.firstReplyH}h`, color: "var(--chart-2)" } } satisfies ChartConfig;
const reopenConfig = { reopenRate: { label: "Reopened", color: "var(--chart-4)" } } satisfies ChartConfig;

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

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

type WeekMetric = "tickets" | "within" | "firstReply" | "reopened";
export type OnWeek = (
  metric: WeekMetric,
  title: string,
  description: string,
) => (state: { activeLabel?: string | number }) => void;

export function WeeklyCharts({ weeks, onWeek }: { weeks: SupportHealth["weeks"]; onWeek: OnWeek }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
      <ChartCard title="Tickets per week" description="By the week they arrived. Click a week for its tickets.">
        <ChartContainer config={volumeConfig} className="h-[180px] w-full cursor-pointer">
          <BarChart
            data={weeks}
            margin={{ left: -24, right: 0, top: 4 }}
            onClick={onWeek("tickets", "Tickets", "Tickets that arrived this week and that a person answered or is still open.")}
          >
            <CartesianGrid vertical={false} strokeOpacity={0.4} />
            <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`} />} />
            <Bar dataKey="tickets" fill="var(--color-tickets)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </ChartCard>

      <ChartCard
        title={`Answered within ${TARGETS.firstReplyH} hours`}
        description={`Share of each week's tickets. The dashed line is the ${pct(TARGETS.firstReplyShare.good)} target.`}
      >
        <ChartContainer config={withinConfig} className="h-[180px] w-full cursor-pointer">
          <LineChart
            data={weeks}
            margin={{ left: -16, right: 8, top: 4 }}
            onClick={onWeek("within", `Answered within ${TARGETS.firstReplyH}h`, "This week's tickets, misses first.")}
          >
            <CartesianGrid vertical={false} strokeOpacity={0.4} />
            <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
            <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} fontSize={10} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`}
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
        <ChartContainer config={speedConfig} className="h-[180px] w-full cursor-pointer">
          <LineChart
            data={weeks}
            margin={{ left: -24, right: 8, top: 4 }}
            onClick={onWeek("firstReply", "First replies", "This week's answered tickets, slowest first.")}
          >
            <CartesianGrid vertical={false} strokeOpacity={0.4} />
            <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} fontSize={10} unit="h" />
            <ChartTooltip
              content={
                <ChartTooltipContent labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`} formatter={tipRow("Median first reply", fmtHours)} />
              }
            />
            <Line dataKey="firstReplyH" type="monotone" stroke="var(--color-firstReplyH)" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartContainer>
      </ChartCard>

      <ChartCard title="Reopened" description="Share of each week's answered tickets the customer came back on after it was resolved.">
        <ChartContainer config={reopenConfig} className="h-[180px] w-full cursor-pointer">
          <LineChart
            data={weeks}
            margin={{ left: -16, right: 8, top: 4 }}
            onClick={onWeek("reopened", "Reopens", "This week's answered tickets, reopened ones first.")}
          >
            <CartesianGrid vertical={false} strokeOpacity={0.4} />
            <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
            <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tickLine={false} axisLine={false} fontSize={10} />
            <ChartTooltip
              content={
                <ChartTooltipContent labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`} formatter={tipRow("Reopened", pct)} />
              }
            />
            <Line dataKey="reopenRate" type="monotone" stroke="var(--color-reopenRate)" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ChartContainer>
      </ChartCard>
    </div>
  );
}
