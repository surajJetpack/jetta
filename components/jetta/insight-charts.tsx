"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { bucketByDay, rollingRate } from "@/lib/series";

interface EvalRow {
  at: number;
  rating: "good" | "partial" | "bad";
}
interface DailyTokens {
  day: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

const decisionsConfig = {
  good: { label: "Sent as-is", color: "var(--chart-2)" },
  partial: { label: "Edited", color: "var(--chart-3)" },
  bad: { label: "Discarded", color: "var(--chart-5)" },
} satisfies ChartConfig;

const editRateConfig = {
  rate: { label: "Edit + discard rate", color: "var(--chart-1)" },
} satisfies ChartConfig;

const spendConfig = {
  costUsd: { label: "Est. cost (USD)", color: "var(--chart-4)" },
} satisfies ChartConfig;

/** "07-13" tick from a "2026-07-13" day key. */
const tick = (day: string) => day.slice(5);

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

function NotEnoughData() {
  return (
    <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
      Not enough data yet
    </div>
  );
}

export default function InsightCharts() {
  const [evals, setEvals] = useState<EvalRow[] | null>(null);
  const [daily, setDaily] = useState<DailyTokens[] | null>(null);

  useEffect(() => {
    (async () => {
      const [e, s] = await Promise.all([
        fetch("/api/admin/evals", { cache: "no-store" }).then((x) => x.json()),
        fetch("/api/admin/stats", { cache: "no-store" }).then((x) => x.json()),
      ]);
      setEvals((e.evaluations ?? []).map((x: { at: number; rating: EvalRow["rating"] }) => ({ at: x.at, rating: x.rating })));
      setDaily(s.daily ?? []);
    })();
  }, []);

  if (evals === null || daily === null) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  const decisionDays = bucketByDay(evals, (e) => e.at, 14).map(({ day, items }) => ({
    day,
    good: items.filter((e) => e.rating === "good").length,
    partial: items.filter((e) => e.rating === "partial").length,
    bad: items.filter((e) => e.rating === "bad").length,
  }));
  const anyDecisions = decisionDays.some((d) => d.good + d.partial + d.bad > 0);

  const editRateDays = rollingRate(
    bucketByDay(evals, (e) => e.at, 30).map(({ day, items }) => ({
      day,
      num: items.filter((e) => e.rating !== "good").length,
      den: items.length,
    })),
    7,
  ).map((d) => ({ day: d.day, rate: d.rate === null ? null : Math.round(d.rate * 100) }));
  const ratePoints = editRateDays.filter((d) => d.rate !== null).length;

  const spendDays = daily.map((d) => ({ day: d.day, costUsd: Number(d.costUsd.toFixed(3)) }));
  const anySpend = spendDays.some((d) => d.costUsd > 0);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ChartCard title="Decisions per day (14d)">
        {anyDecisions ? (
          <ChartContainer config={decisionsConfig} className="h-[160px] w-full">
            <BarChart data={decisionDays} margin={{ left: -28, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="day" tickFormatter={tick} tickLine={false} axisLine={false} fontSize={10} interval={3} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => d} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="good" stackId="d" fill="var(--color-good)" stroke="var(--card)" strokeWidth={1} />
              <Bar dataKey="partial" stackId="d" fill="var(--color-partial)" stroke="var(--card)" strokeWidth={1} />
              <Bar dataKey="bad" stackId="d" fill="var(--color-bad)" stroke="var(--card)" strokeWidth={1} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <NotEnoughData />
        )}
      </ChartCard>

      <ChartCard title="Edit + discard rate, 7d rolling (%)">
        {ratePoints >= 2 ? (
          <ChartContainer config={editRateConfig} className="h-[160px] w-full">
            <LineChart data={editRateDays} margin={{ left: -28, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="day" tickFormatter={tick} tickLine={false} axisLine={false} fontSize={10} interval={6} />
              <YAxis domain={[0, 100]} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => d} />} />
              <Line dataKey="rate" stroke="var(--color-rate)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        ) : (
          <NotEnoughData />
        )}
      </ChartCard>

      <ChartCard title="Token spend per day, est. USD (30d)">
        {anySpend ? (
          <ChartContainer config={spendConfig} className="h-[160px] w-full">
            <AreaChart data={spendDays} margin={{ left: -22, right: 0, top: 4 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="day" tickFormatter={tick} tickLine={false} axisLine={false} fontSize={10} interval={6} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => d} />} />
              <Area
                dataKey="costUsd"
                stroke="var(--color-costUsd)"
                strokeWidth={2}
                fill="var(--color-costUsd)"
                fillOpacity={0.15}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <NotEnoughData />
        )}
      </ChartCard>
    </div>
  );
}
