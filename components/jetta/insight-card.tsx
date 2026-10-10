"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw, Sparkles } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/jetta/status-chip";
import { RelativeTime } from "@/components/jetta/relative-time";
import { cn } from "@/lib/utils";
import type { Insight, InsightPoint } from "@/lib/grounded-insight";

/** What a cited point opens — the page's own drill request shape. */
export interface InsightDrill<D> {
  title: string;
  description: string;
  drill: D;
}

type State = "loading" | "ready" | "not_built" | "failed";

function Points<D>({
  title,
  points,
  tone,
  open,
}: {
  title: string;
  points: InsightPoint<D>[];
  tone: string;
  open: (r: InsightDrill<D>) => void;
}) {
  if (!points.length) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-2xs font-medium tracking-wider text-muted-foreground uppercase">{title}</p>
      <ul className="grid gap-2">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2 text-sm leading-snug">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone)} aria-hidden />
            <span className="min-w-0">
              {p.text}
              {p.evidence && (
                <button
                  type="button"
                  onClick={() => open({ title: p.evidence!.title, description: p.evidence!.description, drill: p.evidence!.drill })}
                  className="ml-1.5 text-xs whitespace-nowrap text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground hover:decoration-solid"
                >
                  {p.evidence.count} ticket{p.evidence.count === 1 ? "" : "s"}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The AI read, above a page's numbers (/health, /performance). Fetched after
 * them — the page never waits on the model — and again whenever the numbers
 * change (`basedOn`). Each cited point opens the page's own drill sheet.
 */
export function InsightCard<D>({
  endpoint,
  basedOn,
  open,
  description = "Written from the numbers on this page. Each point links to the tickets behind it.",
}: {
  /** GET returns { insight, stale?, reason? }; `?refresh=1` rewrites. */
  endpoint: string;
  basedOn: number;
  open: (r: InsightDrill<D>) => void;
  description?: string;
}) {
  const [insight, setInsight] = useState<Insight<D> | null>(null);
  const [state, setState] = useState<State>("loading");
  const [stale, setStale] = useState(false);

  // No "loading" here: on a refresh the previous read stays up until the new one lands.
  const load = useCallback((force = false) => {
    fetch(`${endpoint}${force ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        setInsight(d.insight ?? null);
        setStale(!!d.stale);
        setState(d.insight ? "ready" : d.reason === "not_built" ? "not_built" : "failed");
      })
      .catch(() => setState("failed"));
  }, [endpoint]);
  useEffect(() => {
    load();
  }, [load, basedOn]);

  const busy = state === "loading";
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Sparkles className="size-3.5 text-muted-foreground" aria-hidden /> AI read
          {stale && <StatusChip tone="draft">stale</StatusChip>}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setState("loading");
              load(true);
            }}
            disabled={busy}
          >
            <RotateCw className={busy ? "animate-spin" : undefined} /> Rewrite
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        {busy && !insight ? (
          <div className="grid gap-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : state === "not_built" && !insight ? (
          <p className="text-sm text-muted-foreground">
            The analysis needs the ticket lists, which the next sync builds. Press Sync now below, then Rewrite.
          </p>
        ) : !insight ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t write the analysis just now. The numbers below are unaffected — try Rewrite.</p>
        ) : (
          <>
            {insight.headline && <p className="text-sm font-semibold">{insight.headline}</p>}
            <div className="grid gap-4 md:grid-cols-3">
              <Points title="Going well" points={insight.goingWell} tone="bg-tone-good" open={open} />
              <Points title="Worth watching" points={insight.watch} tone="bg-tone-warn" open={open} />
              <Points title="To do" points={insight.actions} tone="bg-tone-info" open={open} />
            </div>
            <p className="text-xs text-muted-foreground">
              Written <RelativeTime at={Math.floor(insight.generatedAt / 1000)} />. It can be wrong — the numbers below are the
              record.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
