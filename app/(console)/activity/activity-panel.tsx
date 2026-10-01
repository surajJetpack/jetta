"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Activity as ActivityIcon, ExternalLink, RotateCw, TriangleAlert, X } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MetricRow, type MetricSpec } from "@/components/jetta/metric-row";
import { CellLink } from "@/components/jetta/cell-link";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { useDataVersion } from "@/lib/use-data-version";
import { useNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  COLUMNS,
  PLACES,
  type Activity,
  type ColumnId,
  type PersonRow,
  type Place,
  type Scorecard,
} from "@/lib/activity";

type Row = Activity & { person: { key: string; name: string } };

interface SourceReport {
  at: number;
  ok: boolean;
  added: number;
  problem?: string;
  mode?: "push" | "poll";
  pushAt?: number;
}

interface Payload {
  days: number;
  timeZone: string;
  scorecard: Scorecard;
  timeline: Row[];
  matching: number;
  nextBefore: number | null;
  sync: {
    lastRunAt: number | null;
    sources: Partial<Record<"kb" | "slack" | "monday", SourceReport>>;
    mondaySelf: { id: string; name: string } | null;
    push: Partial<Record<"slack" | "monday", number>>;
    mondayWebhooks: boolean;
    freshdesk: { lastRunAt: number | null; queued: number; lastError: string | null } | null;
  };
  aliasesConfigured: boolean;
}

interface Filter {
  person?: string;
  place?: Place;
  column?: ColumnId;
}

const WINDOWS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 28, label: "28 days" },
];

const PLACE_LABEL = Object.fromEntries(PLACES.map((p) => [p.id, p.label])) as Record<Place, string>;
const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label])) as Record<ColumnId, string>;

/** One quiet dot per place — colour is a cue only; the label is in the tooltip and the badge. */
const PLACE_DOT: Record<Place, string> = {
  freshdesk: "bg-[var(--chart-1)]",
  chat: "bg-[var(--chart-2)]",
  slack: "bg-[var(--chart-3)]",
  monday: "bg-[var(--chart-4)]",
  console: "bg-[var(--chart-5)]",
};

const mins = (v: number | null) =>
  v == null ? null : v < 60 ? `${Math.round(v)} min` : v < 48 * 60 ? `${(v / 60).toFixed(1)} h` : `${Math.round(v / 1440)} d`;

function query(days: number, f: Filter, before?: number | null): string {
  const p = new URLSearchParams({ days: String(days) });
  if (f.person) p.set("person", f.person);
  if (f.place) p.set("place", f.place);
  if (f.column) p.set("column", f.column);
  if (before) p.set("before", String(before));
  return `/api/admin/activity?${p}`;
}

export default function ActivityPanel() {
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState<Filter>({});
  const [data, setData] = useState<Payload | null>(null);
  const [more, setMore] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // The newest request wins: a slow 28-day load must not land over a 24-hour one.
  const reqId = useRef(0);

  const load = useCallback(() => {
    const id = ++reqId.current;
    fetch(query(days, filter), { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
        if (id !== reqId.current) return;
        setData(d);
        setMore([]);
        setNextBefore(d.nextBefore);
        setErr(null);
      })
      .catch((e) => id === reqId.current && setErr(e instanceof Error ? e.message : String(e)));
  }, [days, filter]);
  useEffect(() => {
    load();
  }, [load]);
  useDataVersion(["activity", "performance"], load);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(query(days, filter, nextBefore), { cache: "no-store" });
      const d = (await r.json()) as Payload;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setMore((m) => [...m, ...d.timeline]);
      setNextBefore(d.nextBefore);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/admin/activity", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? `HTTP ${r.status}`);
      if (d.status === "partial") toast.warning(`Read ${d.added} new actions — some sources aren't reporting (see below).`);
      else toast.success(`Read ${d.added} actions from Slack, monday and the KB`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  /** Filter the timeline and bring it into view — every number on the page lands here. */
  const show = (f: Filter) => {
    setFilter(f);
    requestAnimationFrame(() => timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  if (err && !data) {
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
        <Skeleton className="h-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const { scorecard } = data;
  const windowLabel = WINDOWS.find((w) => w.days === days)?.label ?? `${days} days`;
  const workers = scorecard.people.filter((p) => p.total > 0);
  const rows = [...data.timeline, ...more];
  const personName = (key: string) => scorecard.people.find((p) => p.key === key)?.name ?? key;

  const syncButton = (
    <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
      <RotateCw className={syncing ? "animate-spin" : undefined} />
      {syncing ? "Reading…" : "Sync now"}
    </Button>
  );

  const metrics: MetricSpec[] = [
    { label: "Actions", value: scorecard.total, hint: `last ${windowLabel}`, onClick: () => show({}) },
    { label: "People active", value: workers.length },
    ...PLACES.map((p) => ({
      label: p.label,
      value: scorecard.byPlace[p.id],
      onClick: scorecard.byPlace[p.id] ? () => show({ place: p.id }) : undefined,
    })),
  ];

  return (
    <div className="grid min-w-0 gap-6 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <Button
              key={w.days}
              size="sm"
              variant={w.days === days ? "secondary" : "ghost"}
              className="h-7"
              aria-pressed={w.days === days}
              onClick={() => setDays(w.days)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        {syncButton}
      </div>

      <MetricRow metrics={metrics} />

      <Card id="scorecard" className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Who did what, last {windowLabel}</CardTitle>
          <CardDescription className="text-xs">
            Every number opens the actions behind it. Pick-up is how long a visitor had waited when the person joined;
            Slack response is how long a Jetta post sat before their first reply. The hour strip is when they worked ({data.timeZone}).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          {scorecard.people.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  {COLUMNS.map((c) => (
                    <TableHead key={c.id} className="text-right">
                      {c.label}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Active days</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead className="text-right">Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scorecard.people.map((p) => (
                  <PersonLine key={p.key} p={p} show={show} />
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={ActivityIcon}
              title="No activity recorded in this window"
              hint="Freshdesk replies arrive with the hourly performance sync; Slack, monday and KB edits with the hourly activity sync. Console and chat actions are recorded as they happen."
              action={syncButton}
            />
          )}
        </CardContent>
      </Card>

      <Card id="timeline" ref={timelineRef} className="scroll-mt-16 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Timeline</CardTitle>
          <CardDescription className="text-xs">
            {data.matching} action{data.matching === 1 ? "" : "s"}, newest first.
          </CardDescription>
          {(filter.person || filter.place || filter.column) && (
            <CardAction className="flex flex-wrap gap-1.5">
              {filter.person && <Chip onClear={() => setFilter({ ...filter, person: undefined })}>{personName(filter.person)}</Chip>}
              {filter.place && <Chip onClear={() => setFilter({ ...filter, place: undefined })}>{PLACE_LABEL[filter.place]}</Chip>}
              {filter.column && <Chip onClear={() => setFilter({ ...filter, column: undefined })}>{COLUMN_LABEL[filter.column]}</Chip>}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="px-4">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PLACES.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={filter.place === p.id ? "secondary" : "outline"}
                className="h-7 gap-1.5"
                aria-pressed={filter.place === p.id}
                onClick={() => setFilter({ ...filter, place: filter.place === p.id ? undefined : p.id, column: undefined })}
              >
                <span className={cn("size-2 rounded-full", PLACE_DOT[p.id])} aria-hidden />
                {p.label}
              </Button>
            ))}
          </div>
          {rows.length ? (
            <ol className="max-h-[70vh] divide-y overflow-y-auto pr-1">
              {rows.map((a) => (
                <TimelineItem key={a.id} a={a} onPerson={(key) => setFilter({ ...filter, person: key })} />
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches these filters in the last {windowLabel}.</p>
          )}
          {nextBefore && (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show older"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <SourcesCard data={data} onChanged={load} />
    </div>
  );
}

function PersonLine({ p, show }: { p: PersonRow; show: (f: Filter) => void }) {
  const peak = Math.max(1, ...p.hours);
  return (
    <TableRow>
      <TableCell className="font-medium">
        <button
          type="button"
          className="flex items-center gap-2 text-left hover:underline"
          onClick={() => show({ person: p.key })}
        >
          {p.name}
          <span className="flex gap-0.5" aria-label={`Active in ${p.places.map((x) => PLACE_LABEL[x]).join(", ")}`}>
            {p.places.map((x) => (
              <span key={x} className={cn("size-1.5 rounded-full", PLACE_DOT[x])} />
            ))}
          </span>
        </button>
      </TableCell>
      {COLUMNS.map((c) => {
        const n = p.counts[c.id];
        const sub =
          c.id === "chats" ? mins(p.chatPickupMin) : c.id === "slack" ? mins(p.slackResponseMin) : null;
        return (
          <TableCell key={c.id} className="text-right tabular-nums">
            <CellLink n={n} onClick={() => show({ person: p.key, column: c.id })}>
              {n || <span className="text-muted-foreground">–</span>}
            </CellLink>
            {sub && n > 0 && (
              <div className="text-[11px] text-muted-foreground">
                {c.id === "chats" ? "pick-up " : "response "}
                {sub}
              </div>
            )}
          </TableCell>
        );
      })}
      <TableCell className="text-right tabular-nums">{p.activeDays}</TableCell>
      <TableCell>
        <div className="flex h-5 items-end gap-px" aria-label="Actions by hour of day">
          {p.hours.map((h, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className="w-1 rounded-sm bg-[var(--chart-1)]"
                  style={{ height: h ? `${Math.max(15, (h / peak) * 100)}%` : "2px", opacity: h ? 1 : 0.25 }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {String(i).padStart(2, "0")}:00 · {h} action{h === 1 ? "" : "s"}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {p.lastAt ? <RelativeTime at={Math.floor(p.lastAt / 1000)} /> : "—"}
      </TableCell>
    </TableRow>
  );
}

function TimelineItem({ a, onPerson }: { a: Row; onPerson: (key: string) => void }) {
  return (
    <li className="flex items-start gap-3 py-2 text-sm">
      <RelativeTime at={Math.floor(a.at / 1000)} className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums" />
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", PLACE_DOT[a.place])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div>
          <button type="button" className="font-medium hover:underline" onClick={() => onPerson(a.person.key)}>
            {a.person.name}
          </button>{" "}
          <span className="text-muted-foreground">{ACTION_LABEL[a.action]}</span>
          {a.waitMs != null && a.waitMs >= 0 && (
            <span className="text-muted-foreground"> · after {mins(a.waitMs / 60_000)}</span>
          )}
        </div>
        {a.detail && <div className="truncate text-xs text-muted-foreground">{a.detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline" className="hidden sm:inline-flex">
          {PLACE_LABEL[a.place]}
        </Badge>
        {a.ticketId && a.place !== "freshdesk" && <span className="text-xs text-muted-foreground tabular-nums">#{a.ticketId}</span>}
        {a.url && (
          <a
            href={a.url}
            target={a.url.startsWith("/") ? undefined : "_blank"}
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Open"
          >
            {a.place === "freshdesk" && a.ticketId ? `#${a.ticketId}` : null}
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}

function Chip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1">
      {children}
      <button type="button" onClick={onClear} aria-label="Clear filter" className="rounded-full hover:bg-muted">
        <X className="size-3" />
      </button>
    </Badge>
  );
}

function Mode({ isLive, pushAt }: { isLive: boolean; pushAt?: number }) {
  return isLive ? (
    <Badge variant="secondary" className="gap-1">
      <span className="size-1.5 rounded-full bg-[var(--chart-2)]" aria-hidden />
      Live
      {pushAt ? (
        <>
          {" "}
          · last event <RelativeTime at={Math.floor(pushAt / 1000)} />
        </>
      ) : null}
    </Badge>
  ) : (
    <Badge variant="outline">Checked hourly</Badge>
  );
}

/** A push source counts as live if it has delivered within this window. */
const LIVE_MS = 72 * 3600_000;

/** Where each place's rows come from, how fresh they are, and which ones aren't reporting. */
function SourcesCard({ data, onChanged }: { data: Payload; onChanged: () => void }) {
  const { sources, freshdesk, mondaySelf, lastRunAt, push, mondayWebhooks } = data.sync;
  const [registering, setRegistering] = useState(false);
  const now = useNow(60_000);
  const live = (s: "slack" | "monday") => push[s] != null && now - push[s]! < LIVE_MS;

  const connectMonday = async () => {
    setRegistering(true);
    try {
      const r = await fetch("/api/admin/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register-monday" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.problem ?? d.error ?? `HTTP ${r.status}`);
      toast.success(d.created ? `Subscribed to ${d.created} monday board events` : "monday was already connected");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRegistering(false);
    }
  };

  const lines: {
    place: string;
    mode: React.ReactNode;
    how: React.ReactNode;
    problem?: string | null;
  }[] = [
    {
      place: "Freshdesk",
      mode: <Badge variant="outline">Hourly, with /performance</Badge>,
      how: freshdesk?.queued
        ? `Replies and notes come from the threads the performance sync reads anyway — no extra Freshdesk calls. ${freshdesk.queued} ticket${freshdesk.queued === 1 ? "" : "s"} still queued, so the newest replies may not be in yet.`
        : "Replies and notes come from the threads the performance sync reads anyway — no extra Freshdesk calls. Status changes and assignments aren't available: Freshdesk's activity export is not on this plan.",
      problem: freshdesk?.lastError,
    },
    {
      place: "Chats",
      mode: <Badge variant="secondary">Live</Badge>,
      how: "Takeovers, messages, tickets, resolves and hand-backs, recorded as they happen.",
    },
    {
      place: "Slack",
      mode: <Mode isLive={live("slack")} pushAt={push.slack} />,
      how: live("slack") ? (
        "Messages in Jetta's channels arrive as they're posted; replies under her posts carry how long they waited. Read in full once a day as a safety net."
      ) : (
        <>
          Read hourly from channel history. To make it live (and stop the hourly reads), add the bot events{" "}
          <code className="text-foreground">message.channels</code> and <code className="text-foreground">message.groups</code> under
          Event Subscriptions in the Slack app settings.
        </>
      ),
      problem: sources.slack?.problem,
    },
    {
      place: "monday",
      mode: <Mode isLive={mondayWebhooks && live("monday")} pushAt={push.monday} />,
      how: (
        <>
          Comments, status and assignee changes, moves and new items on the dev boards.{" "}
          {mondayWebhooks
            ? live("monday")
              ? "Board webhooks deliver each change as it happens; a full read runs once a day as a safety net."
              : "Webhooks are registered but nothing has arrived yet — the boards are read hourly until something does."
            : "Read hourly from the board activity log."}
          {mondaySelf
            ? ` Jetta posts as ${mondaySelf.name}, so that account's new items and "Product:" context posts are left out; the rest of their activity counts.`
            : ""}
          {!mondayWebhooks && (
            <div className="mt-1.5">
              <Button size="sm" variant="outline" className="h-7" onClick={connectMonday} disabled={registering}>
                {registering ? "Connecting…" : "Connect live updates"}
              </Button>
            </div>
          )}
        </>
      ),
      problem: sources.monday?.problem,
    },
    {
      place: "Console",
      mode: <Badge variant="secondary">Live</Badge>,
      how: "Draft decisions, learnings, billing approvals, chat settings and KB edits, recorded as they happen.",
      problem: sources.kb?.problem,
    },
  ];
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Where this comes from</CardTitle>
        <CardDescription className="text-xs">
          {lastRunAt ? (
            <>
              Last check <RelativeTime at={Math.floor(lastRunAt / 1000)} />.
            </>
          ) : (
            "The activity sync hasn't run yet — Sync now reads Slack, monday and the KB."
          )}{" "}
          {data.aliasesConfigured
            ? "Names are merged using AGENT_ALIASES."
            : "Names are merged by first name. If one person shows up twice, set AGENT_ALIASES (e.g. Cherryl=Cherryl B,U07ABC)."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-4">
        {lines.map((l) => (
          <div key={l.place} className="grid gap-1 text-xs sm:grid-cols-[6rem_1fr]">
            <span className="font-medium">{l.place}</span>
            <div className="grid gap-1">
              <div>{l.mode}</div>
              <div className="text-muted-foreground">{l.how}</div>
              {l.problem && (
                <Alert variant="destructive" className="py-1.5">
                  <TriangleAlert />
                  <AlertDescription className="text-xs">{l.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
