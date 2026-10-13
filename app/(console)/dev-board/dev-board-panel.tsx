"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { FilePlus2, KanbanSquare, RotateCw, TriangleAlert } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { StatusChip } from "@/components/jetta/status-chip";
import { InsightCard } from "@/components/jetta/insight-card";
import { useDataVersion } from "@/lib/use-data-version";
import { fmtDayKey, fmtHours } from "@/lib/format";
import {
  DORMANT_DAYS,
  drillRows,
  FRICTION_LABEL,
  KIND_LABEL,
  STALE_DAYS,
  type DevBoardSummary,
  type DevRow,
  type Friction,
  type MinedKind,
  type Move,
} from "@/lib/dev-board";
import { DevDrillSheet, fmtDays, type DevDrillRequest, type OpenDev } from "./dev-drill";

interface SyncInfo {
  lastRunAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

function requestFailed(r: Response): string {
  console.error(`${r.url} → HTTP ${r.status}`);
  if (r.status === 401) return "Your session has expired. Sign in again.";
  if (r.status === 403) return "You don't have access to this.";
  return "The server couldn't load this. Try again in a moment.";
}

const days = (v: number | null) => (v == null ? "—" : `${v}d`);

/** "−12.7h vs prior 28 days" — the delta a reader compares. */
function delta(now: number | null, before: number | null, unit: "h" | "d" | ""): string | undefined {
  if (now == null || before == null) return undefined;
  const d = +(now - before).toFixed(1);
  const v = unit === "h" ? fmtHours(Math.abs(d)) : `${Math.abs(d)}${unit}`;
  return `${d >= 0 ? "+" : "−"}${v} vs prior 28 days`;
}

const flowConfig = {
  filed: { label: "Filed", color: "var(--chart-1)" },
  resolved: { label: "Resolved", color: "var(--chart-2)" },
} satisfies ChartConfig;
const replyConfig = {
  firstEngH: { label: "First engineering response", color: "var(--chart-4)" },
} satisfies ChartConfig;

const MOVES: { move: Move; title: string; description: string }[] = [
  { move: "engineering", title: "Engineering's move", description: "Support or Jetta spoke last, or engineering is working it." },
  { move: "support", title: "Support's move", description: "Engineering asked support something or handed it back to check." },
  { move: "customer", title: "Waiting on the customer", description: "Waiting Customer or Need more info." },
];

function RightNow({ rows, now, open }: { rows: DevRow[] | null; now: number; open: OpenDev }) {
  if (!rows) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {MOVES.map((m) => (
          <Skeleton key={m.move} className="h-48" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-3 [&>*]:min-w-0">
      {MOVES.map((m) => {
        const list = drillRows(rows, { kind: "open", move: m.move }, now);
        const req = { title: m.title, description: `Open client issues — ${m.description} Longest waiting first.`, drill: { kind: "open" as const, move: m.move } };
        return (
          <div key={m.move} className="min-w-0 rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{m.title}</p>
              <CellLink n={list.length} onClick={() => open(req)}>
                <span className="text-sm">{list.length}</span>
              </CellLink>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{m.description}</p>
            {list.length ? (
              <ul className="grid gap-1.5">
                {list.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
                    <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline" title={`${r.app} — ${r.name}`}>
                      <span className="text-muted-foreground">{r.app}:</span> {r.name}
                    </a>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{fmtDays(now - (r.waitingSince ?? r.createdAt))}</span>
                  </li>
                ))}
                {list.length > 6 && (
                  <li>
                    <button type="button" onClick={() => open(req)} className="text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
                      {list.length - 6} more
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing waiting.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Lessons({ rows, now, onDrafted }: { rows: DevRow[] | null; now: number; onDrafted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows) return <Skeleton className="h-40" />;
  const list = drillRows(rows, { kind: "mined", mined: "lessons" }, now);
  if (!list.length) {
    return <EmptyState title="No lessons yet" hint="Lessons appear as the sync reads item conversations — a few each hour." />;
  }
  const draft = async (r: DevRow) => {
    setBusy(r.id);
    try {
      const res = await fetch("/api/admin/dev-board/kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: r.id }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.message ?? d.error ?? requestFailed(res));
      toast.success(d.existing ? "A draft already exists for this item" : "Draft added to the KB review queue", {
        action: { label: "Open", onClick: () => window.open(`/kb/${d.articleId}`, "_blank") },
      });
      onDrafted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="divide-y">
      {list.slice(0, 30).map((r) => (
        <li key={r.id} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{r.kbTitle ?? r.name}</p>
            <p className="text-sm text-pretty text-muted-foreground">{r.lesson}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {r.app}
              {r.area ? ` · ${r.area}` : ""} ·{" "}
              <a href={r.url} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-4 hover:decoration-solid">
                {r.name}
              </a>
            </p>
          </div>
          <div className="flex items-center gap-2 sm:justify-end">
            {r.kbDraftId ? (
              <a href={`/kb/${r.kbDraftId}`} className="text-xs underline underline-offset-4">
                <StatusChip tone="draft">Draft made</StatusChip>
              </a>
            ) : r.kb ? (
              <span className="text-xs text-muted-foreground" title={`Closest article: ${r.kb.title} (${r.kb.score})`}>
                <StatusChip tone="published">In KB</StatusChip> {r.kb.title}
              </span>
            ) : (
              <Button variant="outline" size="sm" onClick={() => draft(r)} disabled={busy === r.id}>
                <FilePlus2 />
                {busy === r.id ? "Drafting…" : "Draft KB article"}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function DevBoardPanel() {
  const [data, setData] = useState<{ summary: DevBoardSummary | null; sync: SyncInfo } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [drill, setDrill] = useState<DevDrillRequest | null>(null);
  const [rows, setRows] = useState<DevRow[] | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [rowsMissing, setRowsMissing] = useState(false);
  const rowsReq = useRef<Promise<void> | null>(null);
  const open = useCallback<OpenDev>((req) => setDrill(req), []);

  const load = useCallback(() => {
    fetch("/api/admin/dev-board", { cache: "no-store" })
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
  useEffect(() => {
    load();
  }, [load]);
  useDataVersion(["devboard"], load);

  // Unlike /performance, the rows are fetched with the page: "Right now" and the
  // lessons list render from them. ~0.5 KB an item, a few hundred items.
  useEffect(() => {
    if (!data?.summary || rows || rowsReq.current) return;
    setRowsErr(null);
    rowsReq.current = fetch("/api/admin/dev-board?rows=1", { cache: "no-store" })
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
  }, [data, rows]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/admin/dev-board", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
      toast.success(
        `Read ${d.items} items · ${d.mined} conversation${d.mined === 1 ? "" : "s"} analysed${d.minePending ? ` · ${d.minePending} still queued` : ""}`,
      );
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
        <Skeleton className="h-24" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const { summary, sync } = data;
  const syncButton = (
    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
      <RotateCw className={syncing ? "animate-spin" : undefined} />
      {syncing ? "Reading the boards…" : "Sync now"}
    </Button>
  );
  if (!summary) {
    return (
      <EmptyState
        icon={KanbanSquare}
        title="The dev boards haven't been read yet"
        hint="An hourly job reads both monday dev boards and analyses a few item conversations each run. Sync now reads them immediately (about a minute)."
        action={syncButton}
      />
    );
  }

  const now = summary.computedAt;
  const r = summary.recent, p = summary.previous, n = summary.now;
  const headline: MetricSpec[] = [
    {
      label: "Client issues filed",
      value: r.filed,
      hint: `${r.filedByJetta} by Jetta · prior ${p.filed}`,
      onClick: () => open({ title: "Client issues filed", description: "Filed by support or Jetta in the last 28 days, newest first.", drill: { kind: "filed" } }),
    },
    {
      label: "Resolved",
      value: r.resolved,
      hint: `prior ${p.resolved}`,
      onClick: () => open({ title: "Resolved", description: "Client issues engineering finished in the last 28 days.", drill: { kind: "resolved" } }),
    },
    {
      label: "First engineering response",
      value: fmtHours(r.firstEngH),
      hint: delta(r.firstEngH, p.firstEngH, "h") ?? "median",
      onClick: () => open({ title: "First engineering response", description: "Client issues filed in the last 28 days, slowest first response first.", drill: { kind: "firstEng" } }),
    },
    {
      label: "Filed to resolved",
      value: days(r.cycleDays),
      hint: delta(r.cycleDays, p.cycleDays, "d") ?? "median",
      onClick: () => open({ title: "Time to resolve", description: "Client issues resolved in the last 28 days, longest first.", drill: { kind: "cycle" } }),
    },
    {
      label: "Fixes that came back",
      value: r.bounced,
      hint: `failed testing or reopened · prior ${p.bounced}`,
      tone: r.bounced > p.bounced ? "warn" : undefined,
      onClick: () => open({ title: "Fixes that came back", description: "Client issues whose fix failed testing or was reopened in the last 28 days.", drill: { kind: "bounced" } }),
    },
  ];

  const onWeek = (metric: "filed" | "resolved") => (state: { activeLabel?: string | number }) => {
    const week = state.activeLabel != null ? String(state.activeLabel) : null;
    if (week) open({ title: `${metric === "filed" ? "Filed" : "Resolved"} · week of ${fmtDayKey(week)}`, description: "Client issues this week.", drill: { kind: "week", week, metric } });
  };

  const kinds = Object.entries(summary.mined.kinds).sort((a, b) => b[1] - a[1]) as [MinedKind, number][];
  const frictions = Object.entries(summary.mined.friction).sort((a, b) => b[1] - a[1]) as [Friction, number][];

  return (
    <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
      <div id="ai-read" className="scroll-mt-16">
        <InsightCard
          endpoint="/api/admin/dev-board/insight"
          basedOn={summary.computedAt}
          open={open}
          unit="item"
          description="How client issues move between support and engineering, and what keeps coming back. Each point links to the items behind it. It may name people — read it as a question about the items, not a score."
        />
      </div>

      <Card id="last-28-days" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Client issues, last 28 days</CardTitle>
          <CardDescription className="text-xs">
            Items filed on the dev boards by support or Jetta. Roadmap work filed by leads is left out of these numbers. Click any number to see the items.
          </CardDescription>
          <CardAction>{syncButton}</CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 px-4">
          <MetricRow metrics={headline} />
          <p className="text-xs text-muted-foreground">
            Support chased engineering for an update{" "}
            <CellLink n={r.nudges} onClick={() => open({ title: "Support chasing for updates", description: "Client issues where support asked engineering for an update in the last 28 days.", drill: { kind: "nudges" } })}>
              {r.nudges} times
            </CellLink>{" "}
            (prior {p.nudges}).
          </p>
        </CardContent>
      </Card>

      <Card id="right-now" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Right now — whose move</CardTitle>
          <CardDescription className="text-xs">
            {n.open} open client issues touched in the last {DORMANT_DAYS} days,{" "}
            <CellLink n={n.stale} onClick={() => open({ title: `Untouched ${STALE_DAYS}+ days`, description: "Open client issues nobody has commented on or moved in two weeks.", drill: { kind: "open", stale: true } })}>
              {n.stale} untouched for {STALE_DAYS}+ days
            </CellLink>
            . Another{" "}
            <CellLink n={n.dormant} onClick={() => open({ title: "Dormant client issues", description: `Open client issues untouched for ${DORMANT_DAYS}+ days — backlog to close or re-plan.`, drill: { kind: "dormant" } })}>
              {n.dormant} dormant
            </CellLink>{" "}
            ({DORMANT_DAYS}+ days untouched) are left out.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {rowsErr ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>{rowsErr}</AlertTitle>
            </Alert>
          ) : (
            <RightNow rows={rows} now={now} open={open} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle>Filed and resolved per week</CardTitle>
            <CardDescription className="text-xs">Client issues. Click a week to see them.</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <ChartContainer config={flowConfig} className="h-[200px] w-full cursor-pointer">
              <BarChart data={summary.weeks} margin={{ left: -24, right: 0, top: 4 }} onClick={onWeek("filed")}>
                <CartesianGrid vertical={false} strokeOpacity={0.4} />
                <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="filed" fill="var(--color-filed)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="resolved" fill="var(--color-resolved)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle>First engineering response</CardTitle>
            <CardDescription className="text-xs">Median hours from filing to the first engineering comment or status change, by the week it was filed.</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <ChartContainer config={replyConfig} className="h-[200px] w-full">
              <LineChart data={summary.weeks} margin={{ left: -24, right: 8, top: 4 }}>
                <CartesianGrid vertical={false} strokeOpacity={0.4} />
                <XAxis dataKey="week" tickFormatter={fmtDayKey} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} fontSize={10} unit="h" />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(w) => `Week of ${fmtDayKey(String(w))}`} />} />
                <Line dataKey="firstEngH" type="monotone" stroke="var(--color-firstEngH)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card id="engineering" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Engineering, last 28 days</CardTitle>
          <CardDescription className="text-xs">
            By the Developer column, all work; client issues in brackets. &ldquo;Reply to support&rdquo; is the median time from a support or
            Jetta post to this person&apos;s next comment or status change on the same item. For coaching, not ranking — a hard bug waits longer.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {summary.developers.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Developer</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Untouched {STALE_DAYS}d+</TableHead>
                  <TableHead className="text-right">Resolved</TableHead>
                  <TableHead className="text-right">Filed → resolved</TableHead>
                  <TableHead className="text-right">Reply to support</TableHead>
                  <TableHead className="text-right">Came back</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.developers.map((d) => {
                  const dd = (metric: "open" | "resolved" | "stale" | "replies" | "bounced", title: string, description: string) => () =>
                    open({ title: `${d.name} · ${title}`, description, drill: { kind: "dev", person: d.name, metric } });
                  return (
                    <TableRow key={d.name}>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={d.open} onClick={dd("open", "open items", "Open items assigned to this developer, longest waiting first.")}>
                          {d.open} <span className="text-muted-foreground">({d.openClient})</span>
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={d.stale} onClick={dd("stale", "untouched items", `Open items assigned to this developer nobody has touched in ${STALE_DAYS}+ days.`)}>
                          {d.stale}
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={d.resolved} onClick={dd("resolved", "resolved", "Items assigned to this developer resolved in the last 28 days.")}>
                          {d.resolved} <span className="text-muted-foreground">({d.resolvedClient})</span>
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{days(d.cycleDays)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={d.replies} onClick={dd("replies", "replies to support", "Items where this person answered support or Jetta in the last 28 days.")}>
                          {fmtHours(d.replyH)} <span className="text-muted-foreground">· {d.replies}</span>
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={d.bounced} onClick={dd("bounced", "fixes that came back", "Items assigned to this developer whose fix failed testing or was reopened in the last 28 days.")}>
                          {d.bounced}
                        </CellLink>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No engineering activity in the last 28 days" />
          )}
        </CardContent>
      </Card>

      <Card id="support" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Support on the boards, last 28 days</CardTitle>
          <CardDescription className="text-xs">
            What support does on the dev boards: filing, answering engineering&apos;s questions, chasing updates, and the items waiting on them now.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {summary.supportTeam.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="text-right">Filed</TableHead>
                  <TableHead className="text-right">Reply to engineering</TableHead>
                  <TableHead className="text-right">Nudges sent</TableHead>
                  <TableHead className="text-right">On their move</TableHead>
                  <TableHead className="text-right">With the customer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.supportTeam.map((s) => {
                  const sd = (metric: "filed" | "yourMove" | "customer" | "nudges" | "replies", title: string, description: string) => () =>
                    open({ title: `${s.name} · ${title}`, description, drill: { kind: "support", person: s.name, metric } });
                  return (
                    <TableRow key={s.name}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={s.filed} onClick={sd("filed", "filed", "Client issues this person filed in the last 28 days.")}>
                          {s.filed}
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={s.replies} onClick={sd("replies", "replies to engineering", "Items where this person answered engineering in the last 28 days.")}>
                          {fmtHours(s.replyH)} <span className="text-muted-foreground">· {s.replies}</span>
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={s.nudges} onClick={sd("nudges", "nudges", "Items this person is on where support asked engineering for an update in the last 28 days.")}>
                          {s.nudges}
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={s.yourMove} onClick={sd("yourMove", "on support's move", "Open client issues this person is on that wait for support.")}>
                          {s.yourMove}
                        </CellLink>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <CellLink n={s.customerWaiting} onClick={sd("customer", "waiting on the customer", "Open client issues this person is on that wait for the customer.")}>
                          {s.customerWaiting}
                        </CellLink>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No support activity on the boards yet" />
          )}
        </CardContent>
      </Card>

      <Card id="patterns" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Patterns from the conversations</CardTitle>
          <CardDescription className="text-xs">
            Each client issue&apos;s thread is read once it has a conversation, and again when it moves: what it turned out to be, the area of the
            app, the root cause engineering gave, and what slowed it down.
            {summary.mined.pending > 0 && ` ${summary.mined.pending} conversations are still queued — these fill in over the next runs.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 px-4">
          {summary.mined.total ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">What they turned out to be ({summary.mined.total} read)</p>
                  <ul className="grid gap-1 text-sm">
                    {kinds.map(([k, v]) => (
                      <li key={k} className="flex justify-between gap-2">
                        <span>{KIND_LABEL[k]}</span>
                        <CellLink n={v} onClick={() => open({ title: KIND_LABEL[k], description: "Client issues whose conversation ended this way.", drill: { kind: "mined", mined: k } })}>
                          {v}
                        </CellLink>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">What slowed them down</p>
                  {frictions.length ? (
                    <ul className="grid gap-1 text-sm">
                      {frictions.map(([f, v]) => (
                        <li key={f} className="flex justify-between gap-2">
                          <span>{FRICTION_LABEL[f]}</span>
                          <CellLink n={v} onClick={() => open({ title: FRICTION_LABEL[f], description: "Client issues whose conversation showed this.", drill: { kind: "friction", friction: f } })}>
                            {v}
                          </CellLink>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing repeated.</p>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Recurring areas — the same part of an app on more than one client issue</p>
                {summary.patterns.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>App · area</TableHead>
                        <TableHead className="text-right">Last 28d</TableHead>
                        <TableHead className="text-right">Prior 28d</TableHead>
                        <TableHead className="text-right">120d</TableHead>
                        <TableHead className="hidden md:table-cell">Latest root cause</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.patterns.slice(0, 10).map((pt) => (
                        <TableRow key={`${pt.app}/${pt.area}`}>
                          <TableCell className="font-medium">
                            <span className="text-muted-foreground">{pt.app} ·</span> {pt.area}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{pt.recent}</TableCell>
                          <TableCell className="text-right tabular-nums">{pt.prior}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            <CellLink n={pt.total} onClick={() => open({ title: `${pt.app} · ${pt.area}`, description: "Client issues in this area, newest first.", drill: { kind: "pattern", app: pt.app, area: pt.area } })}>
                              {pt.total}
                            </CellLink>
                          </TableCell>
                          <TableCell className="hidden max-w-md text-xs whitespace-normal text-muted-foreground md:table-cell" title={pt.causes.join("\n\n")}>
                            <span className="line-clamp-2">{pt.causes[0] ?? "—"}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">No area has come up twice yet.</p>
                )}
              </div>
            </>
          ) : (
            <EmptyState title="No conversations read yet" hint="The sync reads a few each hour; Sync now reads a batch immediately." />
          )}
        </CardContent>
      </Card>

      <Card id="knowledge" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle>Knowledge from the threads</CardTitle>
          <CardDescription className="text-xs">
            Answers engineering gave on an item that support or Jetta could give the next customer themselves.{" "}
            {summary.mined.lessonsNotInKb} of {summary.mined.lessons} aren&apos;t in the KB yet. Drafting one sends it to the KB review queue — nothing
            is published without a person.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <Lessons rows={rows} now={now} onDrafted={load} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {summary.clientItems} client issues of {summary.items} items on {Object.values(summary.boards).join(" and ")}, read hourly (read-only).
        {sync.lastRunAt ? (
          <>
            {" "}Last sync <RelativeTime at={Math.floor(sync.lastRunAt / 1000)} />.
          </>
        ) : null}
        {sync.lastError && ` Last sync failed: ${sync.lastError}`}
      </p>

      <DevDrillSheet request={drill} rows={rows} error={rowsErr} notBuilt={rowsMissing} now={now} onClose={() => setDrill(null)} />
    </div>
  );
}
