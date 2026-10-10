"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { HeartPulse, RotateCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { useDataVersion } from "@/lib/use-data-version";
import { decodeHealthDrill } from "@/lib/drill-code";
import { TARGETS, type HealthRow, type SupportHealth } from "@/lib/support-health";
import { DrillSheet, type DrillRequest } from "./drill-sheet";
import { InsightCard } from "@/components/jetta/insight-card";
import { fmtDayKey } from "@/lib/format";
import { pct, type Open } from "./health-shared";
import { Headline, Load, Secondary } from "./health-metrics";
import { RightNow } from "./right-now";
import { ByApp } from "./by-app-table";
import { Topics } from "./topics-card";
import { WeeklyCharts, type OnWeek } from "./health-charts";

/** The error a reader sees when a request fails; the raw status goes to the console. */
function requestFailed(r: Response): string {
  console.error(`${r.url} → HTTP ${r.status}`);
  if (r.status === 401) return "Your session has expired. Sign in again.";
  if (r.status === 403) return "You don't have access to this.";
  return "The server couldn't load this. Try again in a moment.";
}

interface Payload {
  health: SupportHealth | null;
  sync: { lastRunAt: number | null; queued: number; lastError: string | null };
  ticketUrlBase: string;
}

export default function HealthPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  // The tickets behind the numbers: fetched on the first click, dropped when the numbers change.
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  // The sync hasn't built the lists yet (first click after a deploy).
  const [rowsMissing, setRowsMissing] = useState(false);
  const rowsReq = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/support-health", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
        setData(d);
        setErr(null);
        setRows(null);
        rowsReq.current = null;
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const open = useCallback<Open>((req) => setDrill(req), []);

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
    const d = decodeHealthDrill(drillParam);
    if (d) setDrill({ title: titleParam || "Tickets", description: "Opened from a link to this list.", drill: d });
  }
  if (!drillParam && appliedDrill) setAppliedDrill(null);
  const closeDrill = useCallback(() => {
    setDrill(null);
    if (drillParam) router.replace(pathname, { scroll: false });
  }, [drillParam, pathname, router]);
  // Also re-runs when a refresh drops the rows under an open sheet.
  useEffect(() => {
    if (!drill || rows || rowsReq.current) return;
    setRowsErr(null);
    rowsReq.current = fetch("/api/admin/support-health?rows=1", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
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
      const r = await fetch("/api/admin/support-health", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
      toast.success(`Read ${d.read} ticket${d.read === 1 ? "" : "s"} from Freshdesk${d.queued ? ` · ${d.queued} still queued` : ""}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };
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
        action={
          <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
            <RotateCw className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Reading Freshdesk…" : "Sync now"}
          </Button>
        }
      />
    );
  }

  // Complete weeks only: a Monday-morning partial week reads as a collapse.
  const weeks = h.weeks.filter((w) => !w.partial);

  /** A click anywhere in a weekly chart opens the week under the cursor. */
  const onWeek: OnWeek = (metric, title, description) => (state) => {
    const week = state.activeLabel != null ? String(state.activeLabel) : null;
    if (!week) return;
    open({ title: `${title} · week of ${fmtDayKey(week)}`, description, drill: { kind: "week", week, metric } });
  };

  const syncButton = (
    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
      <RotateCw className={syncing ? "animate-spin" : undefined} />
      {syncing ? "Reading Freshdesk…" : "Sync now"}
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div id="ai-read" className="scroll-mt-16">
        <InsightCard endpoint="/api/admin/support-health/insight" basedOn={h.computedAt} open={open} />
      </div>

      <Card id="last-28-days" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Last 28 days</CardTitle>
          <CardDescription className="text-xs">
            Tickets a person answered or that are still open. Marketing and vendor mail closed without a reply is left
            out. Click any number to see the tickets behind it.
          </CardDescription>
          <CardAction>{syncButton}</CardAction>
        </CardHeader>
        <CardContent className="grid gap-6 px-4">
          <Headline recent={h.recent} previous={h.previous} backlog={h.backlog} open={open} />
          <div className="border-t pt-4">
            <Secondary recent={h.recent} previous={h.previous} chat={h.chat} open={open} />
          </div>
        </CardContent>
      </Card>

      <RightNow b={h.backlog} base={ticketUrlBase} open={open} />

      <WeeklyCharts weeks={weeks} onWeek={onWeek} />

      <ByApp apps={h.apps} open={open} />

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Topics h={h} open={open} />
        <Load h={h} open={open} />
      </div>

      <p className="text-xs text-muted-foreground">
        Read from Freshdesk hourly
        {sync.lastRunAt ? (
          <>
            , last <RelativeTime at={Math.floor(sync.lastRunAt / 1000)} />
          </>
        ) : null}
        .{sync.queued > 0 && ` ${sync.queued} recently changed tickets are still being read.`}
        {sync.lastError && ` Last sync stopped early: ${sync.lastError}.`} Hours are calendar hours,
        weekends included: that is how long the customer waited. Targets: a first reply within {TARGETS.firstReplyH}h for{" "}
        {pct(TARGETS.firstReplyShare.good)} of tickets, a median under {TARGETS.medianFirstReplyH.good}h, reopens under{" "}
        {pct(TARGETS.reopenRate.good)}. There is no satisfaction score — surveys aren&apos;t on this Freshdesk plan — so
        reopens and back-and-forth stand in for quality.
      </p>

      <DrillSheet
        request={drill}
        rows={rows}
        error={rowsErr}
        notBuilt={rowsMissing}
        now={h.computedAt}
        base={ticketUrlBase}
        onClose={closeDrill}
      />
    </div>
  );
}
