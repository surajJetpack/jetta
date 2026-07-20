"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw, Sparkles, TriangleAlert } from "lucide-react";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/jetta/status-chip";

interface Insight {
  headline: string;
  highlights: string[];
  watchouts: string[];
  generatedAt: number;
  model: string;
}
interface ModelStat {
  model: string;
  estCostUsd: number | null;
}
interface Rollup {
  date: string;
  computedAt: number;
  outcomes: {
    total: number;
    resolved: number;
    escalated: number;
    reopened: number;
    closed: number;
    deflectionRate: number | null;
  };
  byProduct: { product: string; count: number }[];
  models: ModelStat[];
  insight: Insight | null;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold">{children}</div>
    </div>
  );
}

const totalCost = (r: Rollup) => r.models.reduce((s, m) => s + (m.estCostUsd ?? 0), 0);

export default function DailyOverview() {
  const [rollups, setRollups] = useState<Rollup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/daily?days=7", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRollups((d.rollups ?? []) as Rollup[]);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Newest-first from the API; the most recent completed day leads the section.
  const day = rollups?.[0] ?? null;

  const regenerate = () => {
    setRegenerating(true);
    setErr(null);
    fetch("/api/admin/daily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(day ? { date: day.date } : {}),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      })
      .then(() => load())
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setRegenerating(false));
  };

  const o = day?.outcomes;
  const pct = o?.deflectionRate != null ? `${Math.round(o.deflectionRate * 100)}%` : "—";
  const cost = day ? totalCost(day) : 0;
  const costKnown = !!day?.models.some((m) => m.estCostUsd != null);
  const topProduct = day?.byProduct[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Daily overview{day ? <span className="ml-2 font-normal text-muted-foreground">{fmtDate(day.date)}</span> : null}
        </CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={regenerate} disabled={regenerating || loading}>
            <RotateCw className={regenerating ? "animate-spin" : undefined} /> Regenerate
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{err}</AlertTitle>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {loading && !rollups && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        {!loading && rollups && !day && (
          <p className="text-sm text-muted-foreground">
            No daily rollup yet. It&apos;s computed each morning for the previous day — or click{" "}
            <span className="font-medium">Regenerate</span> to build yesterday&apos;s now.
          </p>
        )}

        {day && o && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Tickets handled">{o.total}</Stat>
              <Stat label="Deflection rate">{pct}</Stat>
              <Stat label="Escalated">{o.escalated}</Stat>
              <Stat label="Est. cost">{costKnown ? `$${cost.toFixed(2)}` : "—"}</Stat>
              <Stat label="Top product">
                {topProduct ? (
                  <span className="truncate">
                    {topProduct.product} <span className="text-muted-foreground">· {topProduct.count}</span>
                  </span>
                ) : (
                  "—"
                )}
              </Stat>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  AI Insight
                </span>
              </div>
              {day.insight ? (
                <div className="space-y-3">
                  <p className="text-sm font-semibold">{day.insight.headline}</p>
                  {day.insight.highlights.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {day.insight.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  )}
                  {day.insight.watchouts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {day.insight.watchouts.map((w, i) => (
                        <StatusChip key={i} tone="draft">
                          {w}
                        </StatusChip>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Generated {fmtDateTime(Math.floor(day.insight.generatedAt / 1000))} · {day.insight.model}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No narrative yet for this day. Click <span className="font-medium">Regenerate</span> to produce one.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
