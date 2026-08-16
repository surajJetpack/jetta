"use client";

import { useEffect, useState, useCallback } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";
import { fmtDuration } from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard, TraceIO } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";

interface RunLog {
  id: string;
  at: number;
  source: string;
  ticketId: string;
  subject?: string;
  product: string;
  model: string;
  dryRun: boolean;
  blockedByAllowlist: boolean;
  replied: boolean;
  resolutionSent: boolean;
  escalated: boolean;
  durationMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  tasks?: { task: string; model: string; inputTokens: number; outputTokens: number }[];
  reply: string;
  kbHits: { title: string; source: string; score?: number }[];
  trace: { tool: string; input: unknown; result: string }[];
  error?: string;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>;
}

export default function ActivityLog() {
  const [logs, setLogs] = useState<RunLog[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // State updates live in promise callbacks (not the function body) so the
  // mount effect satisfies react-hooks/set-state-in-effect; initial
  // loading=true covers the first fetch.
  const load = useCallback(() => {
    fetch("/api/admin/logs", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setLogs(d.logs ?? []);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    void load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity log (detailed runs)</CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RotateCw className={loading ? "animate-spin" : undefined} /> Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {err && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{err}</AlertTitle>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}

        {logs === null && !err && (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-2/3" />
          </div>
        )}

        {logs && logs.length === 0 && (
          <EmptyState title="No runs logged yet" hint="Run a ticket above and it'll appear here." />
        )}

        {logs?.map((l) => (
          <StepCard
            key={l.id}
            collapsible
            defaultOpen={false}
            title={
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className="shrink-0">#{l.ticketId}</span>
                <span className="truncate font-normal text-foreground">{l.subject ?? "(no subject)"}</span>
                <StatusChip>{l.source}</StatusChip>
                {l.dryRun ? <StatusChip tone="draft">dry-run</StatusChip> : <StatusChip tone="published">live</StatusChip>}
                {l.blockedByAllowlist && <StatusChip tone="draft">not-allowlisted</StatusChip>}
                {l.escalated && <StatusChip tone="stale">escalated</StatusChip>}
                {l.resolutionSent && <StatusChip tone="published">resolved</StatusChip>}
                {l.error && <StatusChip tone="stale">error</StatusChip>}
              </span>
            }
            meta={
              <>
                {fmtDuration(l.durationMs)} · <RelativeTime at={l.at} />
              </>
            }
          >
            <TraceIO>
              model {l.model}
              {l.usage?.totalTokens != null
                ? ` · ${l.usage.totalTokens} tokens (${l.usage.inputTokens ?? "?"} in / ${l.usage.outputTokens ?? "?"} out${
                    l.usage.cacheReadTokens ? `, ${l.usage.cacheReadTokens} cached` : ""
                  })`
                : ""}
            </TraceIO>
            {l.tasks && l.tasks.length > 0 && (
              <TraceIO>
                {"tokens by task: "}
                {Object.entries(
                  l.tasks.reduce<Record<string, { calls: number; in_: number; out: number }>>((acc, t) => {
                    const a = (acc[t.task] ??= { calls: 0, in_: 0, out: 0 });
                    a.calls++;
                    a.in_ += t.inputTokens;
                    a.out += t.outputTokens;
                    return acc;
                  }, {}),
                )
                  .map(
                    ([task, a]) =>
                      `${task}${a.calls > 1 ? ` ×${a.calls}` : ""} ${a.in_ + a.out} (${a.in_} in / ${a.out} out)`,
                  )
                  .join(" · ")}
              </TraceIO>
            )}
            {l.error && <p className="text-xs font-medium text-destructive">error: {l.error}</p>}

            <SectionLabel>KB hits ({l.kbHits.length})</SectionLabel>
            {l.kbHits.length ? (
              l.kbHits.map((h, i) => (
                <TraceIO key={i}>
                  {h.score != null ? `${h.score.toFixed(3)} ` : ""}
                  {h.title} [{h.source}]
                </TraceIO>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">none</p>
            )}

            <SectionLabel>Tool trace ({l.trace.length})</SectionLabel>
            {l.trace.map((t, i) => (
              <TraceIO key={i}>
                <span className="text-primary">
                  {i + 1}. {t.tool}
                </span>{" "}
                → {JSON.stringify(t.input).slice(0, 120)}
                <div className="mt-1 whitespace-pre-wrap text-foreground/80">{t.result.slice(0, 240)}</div>
              </TraceIO>
            ))}

            {l.reply && (
              <>
                <SectionLabel>Reply</SectionLabel>
                <div className="rounded-md bg-background/60 p-2 text-sm whitespace-pre-wrap">{l.reply}</div>
              </>
            )}
          </StepCard>
        ))}
      </CardContent>
    </Card>
  );
}
