"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { HeartPulse, RotateCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { CellLink } from "@/components/jetta/cell-link";
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
  type BacklogBucket,
  type HealthRow,
  type HealthPeriod,
  type SupportHealth,
} from "@/lib/support-health";
import { DrillSheet, type DrillRequest } from "./drill-sheet";

interface Payload {
  health: SupportHealth | null;
  sync: { lastRunAt: number | null; queued: number; lastError: string | null };
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

/** Opens the tickets behind a number. */
type Open = (r: DrillRequest) => void;

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

function Headline({ recent, previous, backlog, open }: { recent: HealthPeriod; previous: HealthPeriod; backlog: Backlog; open: Open }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets",
      value: recent.tickets,
      hint: countDelta(recent.tickets, previous.tickets),
      onClick: () =>
        open({
          title: "Tickets, last 28 days",
          description: "Every ticket that arrived in the last 28 days and that a person answered or is still open.",
          drill: { kind: "tickets" },
        }),
    },
    {
      label: `Answered within ${TARGETS.firstReplyH}h`,
      value: pct(recent.withinTarget),
      tone: toneAbove(recent.withinTarget, TARGETS.firstReplyShare) ?? undefined,
      hint: pctDelta(recent.withinTarget, previous.withinTarget),
      onClick: () =>
        open({
          title: `Answered within ${TARGETS.firstReplyH}h`,
          description: `Tickets from the last 28 days, misses first. A ticket still unanswered after ${TARGETS.firstReplyH}h counts as a miss; one younger than that isn't counted yet.`,
          drill: { kind: "within", hours: TARGETS.firstReplyH },
        }),
    },
    {
      label: "Median first reply",
      value: hrs(recent.firstReplyH),
      tone: toneBelow(recent.firstReplyH, TARGETS.medianFirstReplyH) ?? undefined,
      hint: `slowest 10%: over ${hrs(recent.firstReplyP90H)}`,
      onClick: () =>
        open({
          title: "First reply times",
          description: "Answered tickets from the last 28 days, slowest first. The median is the middle of this list.",
          drill: { kind: "firstReply" },
        }),
    },
    {
      label: "Reopened",
      value: pct(recent.reopenRate),
      tone: toneBelow(recent.reopenRate, TARGETS.reopenRate) ?? undefined,
      hint: pctDelta(recent.reopenRate, previous.reopenRate),
      onClick: () =>
        open({
          title: "Reopened tickets",
          description: "Answered tickets from the last 28 days the customer came back on after they were resolved.",
          drill: { kind: "reopened" },
        }),
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
      onClick: () =>
        open({
          title: "Customers waiting on us",
          description: "Open tickets where the customer wrote the newest message, longest wait first.",
          drill: { kind: "bucket", bucket: "owes_reply" },
        }),
    },
  ];
  return <MetricRow metrics={metrics} />;
}

function Secondary({
  recent,
  previous,
  chat,
  open,
}: {
  recent: HealthPeriod;
  previous: HealthPeriod;
  chat: SupportHealth["chat"];
  open: Open;
}) {
  const metrics: MetricSpec[] = [
    {
      label: `Answered within ${TARGETS.fastReplyH}h`,
      value: pct(recent.withinFast),
      hint: pctDelta(recent.withinFast, previous.withinFast),
      onClick: () =>
        open({
          title: `Answered within ${TARGETS.fastReplyH}h`,
          description: `Tickets from the last 28 days, misses first. A ticket still unanswered after ${TARGETS.fastReplyH}h counts as a miss.`,
          drill: { kind: "within", hours: TARGETS.fastReplyH },
        }),
    },
    {
      label: "Median time to resolve",
      value: hrs(recent.resolvedH),
      hint: hrsDelta(recent.resolvedH, previous.resolvedH),
      onClick: () =>
        open({
          title: "Time to resolve",
          description: "Answered tickets from the last 28 days that have been resolved, longest first.",
          drill: { kind: "resolved" },
        }),
    },
    {
      label: "Customer messages per ticket",
      value: recent.customerMsgsPerTicket?.toFixed(1) ?? "—",
      hint:
        previous.customerMsgsPerTicket != null
          ? `${previous.customerMsgsPerTicket.toFixed(1)} in the prior 28 days`
          : undefined,
      onClick: () =>
        open({
          title: "Back-and-forth",
          description: "Answered tickets from the last 28 days, most customer messages first.",
          drill: { kind: "backAndForth" },
        }),
    },
    {
      label: "Sent to engineering",
      value: pct(recent.engineeringRate),
      hint: pctDelta(recent.engineeringRate, previous.engineeringRate),
      onClick: () =>
        open({
          title: "Sent to engineering",
          description: "Tickets from the last 28 days that got a dev-board item or a Slack escalation.",
          drill: { kind: "engineering" },
        }),
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
function BallBar({ b, open }: { b: Backlog; open: Open }) {
  const parts: { key: BacklogBucket; label: string; n: number; cls: string; why: string }[] = [
    { key: "owes_reply", label: "Waiting on us", n: b.owesReply, cls: "bg-tone-bad", why: "the customer wrote the newest message" },
    { key: "engineering", label: "With engineering", n: b.engineering, cls: "bg-tone-warn", why: "status is Escalated to dev" },
    { key: "in_progress", label: "We're working on it", n: b.inProgress, cls: "bg-tone-info", why: "status is Working on it, Validating or Hold" },
    { key: "customer", label: "Waiting on the customer", n: b.customer, cls: "bg-muted-foreground/40", why: "we wrote the newest message" },
  ];
  const show = (p: (typeof parts)[number]) =>
    open({ title: p.label, description: `Open tickets where ${p.why}.`, drill: { kind: "bucket", bucket: p.key } });
  if (!b.open) return null;
  return (
    <div className="grid gap-2">
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(", ")}>
        {parts.filter((p) => p.n).map((p) => (
          <button
            key={p.key}
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => show(p)}
            className={cn("h-full cursor-pointer first:rounded-l-full last:rounded-r-full hover:opacity-80", p.cls)}
            style={{ flexGrow: p.n }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              onClick={() => show(p)}
              disabled={!p.n}
              className="flex items-center gap-1.5 rounded-sm hover:text-foreground hover:underline disabled:pointer-events-none"
            >
              <span className={cn("size-2 rounded-full", p.cls)} aria-hidden />
              {p.label} <span className="font-medium text-foreground tabular-nums">{p.n}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RightNow({ b, base, open }: { b: Backlog; base: string; open: Open }) {
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
        <BallBar b={b} open={open} />
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
        {b.owesReply > b.waiting.length && (
          <Button
            variant="link"
            size="sm"
            className="justify-self-start px-0"
            onClick={() =>
              open({
                title: "Customers waiting on us",
                description: "Open tickets where the customer wrote the newest message, longest wait first.",
                drill: { kind: "bucket", bucket: "owes_reply" },
              })
            }
          >
            Show all {b.owesReply}
          </Button>
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

function ByApp({ apps, open }: { apps: AppHealth[]; open: Open }) {
  const show = (a: AppHealth, metric: Extract<DrillRequest["drill"], { kind: "app" }>["metric"], title: string, description: string) =>
    open({ title: `${appName(a.app)} · ${title}`, description, drill: { kind: "app", app: a.app, metric } });
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
                    <CellLink n={a.tickets} onClick={() => show(a, "tickets", "tickets", "Tickets from the last 28 days.")}>
                      {a.tickets}
                    </CellLink>{" "}
                    <Delta now={a.tickets} before={a.previous} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink
                      n={a.firstReplyH == null ? 0 : 1}
                      onClick={() => show(a, "firstReply", "first replies", "Answered tickets from the last 28 days, slowest first.")}
                    >
                      {hrs(a.firstReplyH)}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink
                      n={a.reopenRate ? 1 : 0}
                      onClick={() => show(a, "reopened", "reopens", "Answered tickets from the last 28 days, reopened ones first.")}
                    >
                      {pct(a.reopenRate)}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.open} onClick={() => show(a, "open", "open now", "Every open ticket for this app, whoever's turn it is.")}>
                      {a.open}
                    </CellLink>
                    {a.owesReply ? (
                      <span className="text-tone-bad">
                        {" · "}
                        <CellLink
                          n={a.owesReply}
                          onClick={() => show(a, "owesReply", "waiting on us", "Open tickets where the customer wrote the newest message.")}
                        >
                          {a.owesReply}
                        </CellLink>
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.bugs} onClick={() => show(a, "bugs", "real bugs", "Handoffs in the last 28 days the review judged a real product bug.")}>
                      {a.bugs || "—"}
                    </CellLink>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <CellLink n={a.gaps} onClick={() => show(a, "gaps", "knowledge gaps", "Handoffs in the last 28 days that only needed an answer Jetta didn't have.")}>
                      {a.gaps || "—"}
                    </CellLink>
                  </TableCell>
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

function Topics({ h, open }: { h: SupportHealth; open: Open }) {
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
              <li
                key={t.topic}
                className="relative -mx-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-1.5 py-1 hover:bg-muted/60"
              >
                <button
                  type="button"
                  aria-label={`Show tickets about ${t.topic}`}
                  className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() =>
                    open({
                      title: t.topic.charAt(0).toUpperCase() + t.topic.slice(1),
                      description: "Tickets from the last 28 days Jetta labelled with this theme.",
                      drill: { kind: "topic", topic: t.topic },
                    })
                  }
                />
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

function Load({ h, open }: { h: SupportHealth; open: Open }) {
  const metrics: MetricSpec[] = [
    {
      label: "Tickets with a Jetta draft",
      value: pct(h.recent.tickets ? h.load.ticketsDrafted / h.recent.tickets : null),
      hint: `${h.load.ticketsDrafted} of ${h.recent.tickets} · an agent reviews and sends each reply`,
      onClick: () =>
        open({
          title: "Tickets with a Jetta draft",
          description: "Tickets from the last 28 days where Jetta suggested at least one reply for an agent to review.",
          drill: { kind: "drafted" },
        }),
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
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        setData(d);
        setErr(null);
        setRows(null);
        rowsReq.current = null;
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const open = useCallback<Open>((req) => setDrill(req), []);
  // Also re-runs when a refresh drops the rows under an open sheet.
  useEffect(() => {
    if (!drill || rows || rowsReq.current) return;
    setRowsErr(null);
    rowsReq.current = fetch("/api/admin/support-health?rows=1", { cache: "no-store" })
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
      const r = await fetch("/api/admin/support-health", { method: "POST" });
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
  const onWeek =
    (metric: "tickets" | "within" | "firstReply" | "reopened", title: string, description: string) =>
    (state: { activeLabel?: string | number }) => {
      const week = state.activeLabel != null ? String(state.activeLabel) : null;
      if (!week) return;
      open({ title: `${title} · week of ${weekTick(week)}`, description, drill: { kind: "week", week, metric } });
    };

  const syncButton = (
    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
      <RotateCw className={syncing ? "animate-spin" : undefined} />
      {syncing ? "Reading Freshdesk…" : "Sync now"}
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Last 28 days</CardTitle>
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

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Tickets per week" description="By the week they arrived. Click a week for its tickets.">
          <ChartContainer config={volumeConfig} className="h-[180px] w-full cursor-pointer">
            <BarChart
              data={weeks}
              margin={{ left: -24, right: 0, top: 4 }}
              onClick={onWeek("tickets", "Tickets", "Tickets that arrived this week and that a person answered or is still open.")}
            >
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
          <ChartContainer config={withinConfig} className="h-[180px] w-full cursor-pointer">
            <LineChart
              data={weeks}
              margin={{ left: -16, right: 8, top: 4 }}
              onClick={onWeek("within", `Answered within ${TARGETS.firstReplyH}h`, "This week's tickets, misses first.")}
            >
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
          <ChartContainer config={speedConfig} className="h-[180px] w-full cursor-pointer">
            <LineChart
              data={weeks}
              margin={{ left: -24, right: 8, top: 4 }}
              onClick={onWeek("firstReply", "First replies", "This week's answered tickets, slowest first.")}
            >
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
          <ChartContainer config={reopenConfig} className="h-[180px] w-full cursor-pointer">
            <LineChart
              data={weeks}
              margin={{ left: -16, right: 8, top: 4 }}
              onClick={onWeek("reopened", "Reopens", "This week's answered tickets, reopened ones first.")}
            >
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
        onClose={() => setDrill(null)}
      />
    </div>
  );
}
