"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { CircleCheck, RotateCw, Stethoscope, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { PageHeader } from "@/components/jetta/page-header";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { MetricRow } from "@/components/jetta/metric-row";
import { CHIP_BASE, TONE_SOFT, TONE_TEXT, type Tone } from "@/components/jetta/tone";
import { useDataVersion } from "@/lib/use-data-version";
import { fmtDayKey, fmtDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionFinding, CronHealth, JudgedReply, ReplyKind, SelfReviewSummary, Verdict } from "@/lib/self-review/types";

const DESCRIPTION = "Jetta checking her own work every hour: are her jobs and runs healthy, and how good were her replies, graded by an independent model.";

function requestFailed(r: Response): string {
  console.error(`${r.url} → HTTP ${r.status}`);
  if (r.status === 401) return "Your session has expired. Sign in again.";
  if (r.status === 403) return "You don't have access to this.";
  return "The server couldn't load this. Try again in a moment.";
}

function Chip({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn(CHIP_BASE, "tracking-wide uppercase", TONE_SOFT[tone], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

const VERDICT_TONE: Record<Verdict, Tone> = { good: "good", weak: "warn", bad: "bad" };
const KIND_LABEL: Record<ReplyKind, string> = { chat: "Chat", email: "Email", dev_bridge: "Dev bridge" };
const CRON_TONE: Record<CronHealth["state"], Tone> = { ok: "good", late: "bad", failing: "bad", unknown: "neutral" };
const words = (s: string) => s.replace(/_/g, " ");
const modelName = (id: string) => id.split("/").pop() ?? id;

function scoreTone(score: number): Tone {
  if (!score) return "neutral";
  return score >= 4 ? "good" : score >= 3 ? "warn" : "bad";
}

// ── headline ────────────────────────────────────────────────────────

function Headline({ s }: { s: SelfReviewSummary }) {
  const days = s.quality.days;
  const week = days.slice(-7);
  const prior = days.slice(0, 7);
  const sum = (xs: typeof days, f: (d: (typeof days)[number]) => number) => xs.reduce((a, d) => a + f(d), 0);
  const judged = sum(week, (d) => d.judged);
  const avg = judged ? sum(week, (d) => d.avgScore * d.judged) / judged : 0;
  const priorJudged = sum(prior, (d) => d.judged);
  const priorAvg = priorJudged ? sum(prior, (d) => d.avgScore * d.judged) / priorJudged : 0;
  const good = sum(week, (d) => d.good);
  const bad = sum(week, (d) => d.bad);
  const r = s.reliability;
  const cronsOk = r ? r.crons.filter((c) => c.state === "ok").length : 0;
  const cronsKnown = r ? r.crons.filter((c) => c.state !== "unknown").length : 0;
  const cronsBad = r ? r.crons.filter((c) => c.state === "late" || c.state === "failing").length : 0;
  const delta = priorJudged && judged ? avg - priorAvg : null;
  return (
    <MetricRow
      className="sm:grid-cols-5"
      metrics={[
        {
          label: "Reply score, last 7 days",
          value: judged ? `${avg.toFixed(1)}/5` : "–",
          tone: judged ? scoreTone(Math.round(avg)) : undefined,
          hint: delta == null ? `${judged} replies judged` : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} on the week before · ${judged} judged`,
        },
        {
          label: "Good replies",
          value: judged ? `${Math.round((good / judged) * 100)}%` : "–",
          hint: judged ? `${good} of ${judged} scored 4 or 5` : "Nothing judged yet",
        },
        {
          label: "Bad replies, 7 days",
          value: bad,
          tone: bad ? "bad" : undefined,
          hint: bad ? "Wrong, unsupported or against policy" : "None judged bad",
        },
        {
          label: "Scheduled jobs healthy",
          value: r && cronsKnown ? `${cronsOk}/${cronsKnown}` : "–",
          tone: cronsBad ? "bad" : cronsKnown ? "good" : undefined,
          hint: cronsBad
            ? `${cronsBad} late or failing`
            : !cronsKnown
              ? "Waiting for the first heartbeats"
              : cronsKnown < (r?.crons.length ?? 0)
                ? `${cronsOk} on schedule, ${(r?.crons.length ?? 0) - cronsKnown} not seen yet`
                : "All on schedule",
        },
        {
          label: "Runs, last 24h",
          value: r?.runs.runs ?? "–",
          tone: r?.runs.errors ? "warn" : undefined,
          hint: r ? `${r.runs.errors} failed · p95 ${fmtDuration(r.runs.p95Ms)}` : undefined,
        },
      ]}
    />
  );
}

function Flags({ s }: { s: SelfReviewSummary }) {
  const flags = s.reliability?.flags ?? [];
  return (
    <Card id="attention" className="scroll-mt-16 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>Needs a look</CardTitle>
        <CardDescription className="text-xs">
          What the reliability check found this hour, each compared with Jetta&apos;s own recent normal. Each new one is posted to Slack once.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {flags.length ? (
          <ul className="grid gap-2">
            {flags.map((f) => (
              <li key={f.key} className="flex items-start gap-2.5 rounded-md border bg-card px-3 py-2.5">
                <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[f.severity === "bad" ? "bad" : "warn"])} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.title}</p>
                  <p className="text-xs text-pretty text-muted-foreground">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck className={cn("size-4", TONE_TEXT.good)} aria-hidden />
            Nothing unusual: jobs on schedule, run errors and latency at their normal level.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── actions ─────────────────────────────────────────────────────────

const RULE_LABEL: Record<ActionFinding["rule"], string> = {
  duplicate_dev_item: "Duplicate dev item",
  repeated_dev_post: "Repeated dev post",
  closed_while_escalated: "Closed while escalated",
  thin_dev_item: "No repro steps",
  dev_write_failed: "Board write failed",
  cancelled_subscription: "Subscription cancelled",
};

function Actions({ s }: { s: SelfReviewSummary }) {
  const a = s.actions;
  if (!a) return null;
  const c = a.counts;
  const tiles: [string, number][] = [
    ["Dev items filed", c.devItemsFiled],
    ["Questions to devs", c.devQuestions],
    ["Added to an existing item", c.dedupedOntoExisting],
    ["Posts to developers", c.devPosts],
    ["Escalations", c.escalations],
    ["Tickets closed", c.closes],
    ["Compliance requests", c.compliance],
    ["Billing actions", c.billing],
  ];
  return (
    <Card id="actions" className="scroll-mt-16 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>What she did, last {a.days} days</CardTitle>
        <CardDescription className="text-xs">
          Her unsupervised writes, from the tool calls in every run: the dev board, escalations, closes and billing. Rule checks name each time a
          guard was bypassed (a second item for one ticket, the same post to developers twice, a close after an escalation, an item with no repro
          steps, a write that did not land, a cancellation). New ones go to Slack once.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
          {tiles.map(([label, n]) => (
            <div key={label} className="bg-card px-3 py-2">
              <dt className="text-2xs text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
        {a.findings.length ? (
          <ul className="grid gap-2">
            {a.findings.map((f) => (
              <li key={f.key} className="flex items-start gap-2.5 rounded-md border bg-card px-3 py-2.5">
                <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[f.severity === "bad" ? "bad" : "warn"])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={f.severity === "bad" ? "bad" : "warn"}>{RULE_LABEL[f.rule]}</Chip>
                    <span className="text-sm font-medium">{f.title}</span>
                    <span className="text-xs text-muted-foreground">
                      <RelativeTime at={Math.floor(f.at / 1000)} />
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleCheck className={cn("size-4", TONE_TEXT.good)} aria-hidden />
            No rule broken: no duplicate items, post bursts, closes after escalation, thin items, failed writes or cancellations.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── quality ─────────────────────────────────────────────────────────

const trendConfig = {
  good: { label: "Good", color: "var(--chart-2)" },
  weak: { label: "Weak", color: "var(--chart-3)" },
  bad: { label: "Bad", color: "var(--chart-5)" },
  avgScore: { label: "Avg score", color: "var(--chart-1)" },
} satisfies ChartConfig;

function Trend({ s }: { s: SelfReviewSummary }) {
  const data = s.quality.days.map((d) => ({ ...d, avgScore: d.judged ? d.avgScore : null }));
  const any = data.some((d) => d.judged);
  return (
    <Card id="trend" className="scroll-mt-16 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>Reply quality, 14 days</CardTitle>
        <CardDescription className="text-xs">
          Replies judged per day by verdict, and the day&apos;s average score (right axis, 1 to 5). A falling line after a deploy or a model change is
          the thing to catch.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        {any ? (
          <ChartContainer config={trendConfig} className="h-[220px] w-full">
            <ComposedChart data={data} margin={{ left: -20, right: -10, top: 6 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="day" tickFormatter={(d: string) => fmtDayKey(d)} tickLine={false} axisLine={false} fontSize={10} interval={1} />
              <YAxis yAxisId="n" allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} />
              <YAxis yAxisId="s" orientation="right" domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} tickLine={false} axisLine={false} fontSize={10} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => fmtDayKey(String(d))} />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar yAxisId="n" dataKey="good" stackId="v" fill="var(--color-good)" stroke="var(--card)" strokeWidth={1} />
              <Bar yAxisId="n" dataKey="weak" stackId="v" fill="var(--color-weak)" stroke="var(--card)" strokeWidth={1} />
              <Bar yAxisId="n" dataKey="bad" stackId="v" fill="var(--color-bad)" stroke="var(--card)" strokeWidth={1} radius={[3, 3, 0, 0]} />
              <Line yAxisId="s" dataKey="avgScore" stroke="var(--color-avgScore)" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <EmptyState icon={Stethoscope} title="No replies judged yet" hint="Each hourly run judges a few of Jetta's recent replies; the chart fills in from the first run." />
        )}
      </CardContent>
    </Card>
  );
}

const FIX_LABEL: Record<string, { title: string; hint: string }> = {
  kb_gap: { title: "Missing from the knowledge base", hint: "Add the fact as a KB article and she will use it." },
  prompt: { title: "How Jetta behaves", hint: "An instruction or habit to change." },
  tool_or_bug: { title: "A tool or a bug", hint: "Something she called failed or came back empty." },
  policy: { title: "A rule was broken", hint: "Disclosure, promises, internal details." },
};

function Fixes({ s, open }: { s: SelfReviewSummary; open: (runId: string) => void }) {
  const { fixes, issues } = s.quality;
  return (
    <Card id="fixes" className="scroll-mt-16 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>What would make her better</CardTitle>
        <CardDescription className="text-xs">
          From the weak and bad replies of the last 7 days: the judge&apos;s suggested fix, grouped by where it belongs. Suggestions only, nothing is changed
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        {issues.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {issues.map((i) => (
              <span key={i.category} className={cn(CHIP_BASE, TONE_SOFT.neutral)}>
                {words(i.category)} <span className="tabular-nums text-foreground">{i.count}</span>
              </span>
            ))}
          </div>
        )}
        {fixes.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {fixes.map((f) => (
              <div key={f.type} className="rounded-md border bg-card p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{FIX_LABEL[f.type]?.title ?? words(f.type)}</p>
                  <span className="text-xs text-muted-foreground tabular-nums">{f.count}</span>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">{FIX_LABEL[f.type]?.hint}</p>
                <ul className="grid gap-1.5">
                  {f.examples.slice(0, 4).map((e) => (
                    <li key={e.runId}>
                      <button type="button" onClick={() => open(e.runId)} className="line-clamp-3 text-left text-xs text-pretty hover:underline" title={e.fix}>
                        {e.fix}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No weak or bad replies in the last 7 days, so nothing to fix.</p>
        )}
      </CardContent>
    </Card>
  );
}

type Filter = "all" | "problems" | ReplyKind;

function Replies({ s, open }: { s: SelfReviewSummary; open: (runId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = s.quality.recent.filter((j) =>
    filter === "all" ? true : filter === "problems" ? j.verdict !== "good" : j.kind === filter,
  );
  const tabs: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: s.quality.recent.length },
    { id: "problems", label: "Weak & bad", n: s.quality.recent.filter((j) => j.verdict !== "good").length },
    { id: "chat", label: "Chat", n: s.quality.recent.filter((j) => j.kind === "chat").length },
    { id: "email", label: "Email", n: s.quality.recent.filter((j) => j.kind === "email").length },
    { id: "dev_bridge", label: "Dev bridge", n: s.quality.recent.filter((j) => j.kind === "dev_bridge").length },
  ];
  return (
    <Card id="replies" className="scroll-mt-16 gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>Judged replies</CardTitle>
        <CardDescription className="text-xs">
          The last 7 days, newest first. Judged by {modelName(s.quality.judge)}, never the model that wrote them. {s.quality.judgedToday} of{" "}
          {s.quality.dailyCap} judged today. Click a row for the conversation, the reply and why.
        </CardDescription>
        <div className="flex flex-wrap gap-1 pt-1" role="tablist">
          {tabs.map((t) => (
            <Button
              key={t.id}
              role="tab"
              aria-selected={filter === t.id}
              size="sm"
              variant={filter === t.id ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setFilter(t.id)}
            >
              {t.label} <span className="text-muted-foreground tabular-nums">{t.n}</span>
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-4">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">When</TableHead>
                <TableHead className="w-24">Channel</TableHead>
                <TableHead className="w-20">Score</TableHead>
                <TableHead>What the judge said</TableHead>
                <TableHead className="w-28">App</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((j) => (
                <TableRow
                  key={j.runId}
                  tabIndex={0}
                  onClick={() => open(j.runId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open(j.runId);
                  }}
                  className="cursor-pointer align-top outline-none focus-visible:bg-muted/50"
                >
                  <TableCell className="text-xs text-muted-foreground">
                    <RelativeTime at={Math.floor(j.at / 1000)} />
                  </TableCell>
                  <TableCell className="text-xs">{KIND_LABEL[j.kind]}</TableCell>
                  <TableCell>
                    <Chip tone={VERDICT_TONE[j.verdict]}>{j.score}/5</Chip>
                  </TableCell>
                  <TableCell className="max-w-xl min-w-64 text-xs whitespace-normal text-pretty">
                    {j.summary}
                    {j.checks.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {j.checks.map((c) => (
                          <span key={c} className={cn(CHIP_BASE, TONE_SOFT[c.startsWith("long") || c.startsWith("link_not") ? "warn" : "bad"])}>
                            {words(c.split(":")[0])}
                          </span>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.app && j.app !== "unknown" ? j.app : "–"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">Nothing here yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReplySheet({ reply, onClose }: { reply: JudgedReply | null; onClose: () => void }) {
  return (
    <Sheet open={!!reply} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {reply && (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <Chip tone={VERDICT_TONE[reply.verdict]}>
                  {reply.verdict} · {reply.score}/5
                </Chip>
                <span>{KIND_LABEL[reply.kind]}</span>
                <span className="font-mono text-xs text-muted-foreground">{reply.ticketId.slice(0, 12)}</span>
              </SheetTitle>
              <SheetDescription>{reply.subject ?? reply.summary}</SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 px-4 pb-8 text-sm">
              <p className="text-pretty">{reply.summary}</p>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Answered</dt>
                  <dd className="font-medium">{reply.answered}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Grounded in evidence</dt>
                  <dd className="font-medium">{reply.grounded}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Escalated</dt>
                  <dd className="font-medium">{reply.escalated ? "yes" : "no"}</dd>
                </div>
              </dl>
              {reply.issues.length > 0 && (
                <section>
                  <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Problems</h3>
                  <ul className="grid gap-1.5">
                    {reply.issues.map((i, n) => (
                      <li key={n} className="text-xs text-pretty">
                        <span className="font-medium">{words(i.category)}:</span>
                        {" "}
                        {i.detail}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {reply.fix && (
                <section className="rounded-md border bg-muted/40 p-3">
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">Suggested fix · {words(reply.fixType)}</h3>
                  <p className="text-xs text-pretty">{reply.fix}</p>
                </section>
              )}
              <section>
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Conversation before the reply</h3>
                <pre className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 font-sans text-xs whitespace-pre-wrap">{reply.customerAsk || "(not available)"}</pre>
              </section>
              <section>
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Jetta&apos;s reply</h3>
                <pre className="max-h-80 overflow-y-auto rounded-md border p-3 font-sans text-xs whitespace-pre-wrap">{reply.reply}</pre>
              </section>
              <p className="text-2xs text-muted-foreground">
                Written by {modelName(reply.writer)} · judged by {modelName(reply.judge)} · run {reply.runId.slice(0, 8)}
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── reliability ─────────────────────────────────────────────────────

function every(min: number): string {
  if (min >= 1440) return "daily";
  if (min >= 60) return min === 60 ? "hourly" : `every ${min / 60}h`;
  return min === 1 ? "every minute" : `every ${min} min`;
}

function Reliability({ s }: { s: SelfReviewSummary }) {
  const r = s.reliability;
  if (!r) return null;
  const crons = [...r.crons].sort((a, b) => {
    const rank = { failing: 0, late: 1, unknown: 3, ok: 2 } as const;
    return rank[a.state] - rank[b.state] || a.name.localeCompare(b.name);
  });
  return (
    <div className="grid gap-5 lg:grid-cols-5 [&>*]:min-w-0">
      <Card id="jobs" className="scroll-mt-16 gap-3 py-4 lg:col-span-3">
        <CardHeader className="px-4">
          <CardTitle>Scheduled jobs</CardTitle>
          <CardDescription className="text-xs">
            Every cron&apos;s last run against its schedule. Late means it should have run by now and hasn&apos;t; failing means its last runs ended in
            an error. &quot;Not seen yet&quot; clears once each job runs after this deploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="text-right">Took</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crons.map((c) => (
                <TableRow key={c.name} className="align-top">
                  <TableCell className="font-mono text-xs">{c.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{every(c.everyMin)}</TableCell>
                  <TableCell className="text-xs">{c.lastAt ? <RelativeTime at={Math.floor(c.lastAt / 1000)} /> : "–"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{c.ms != null ? fmtDuration(c.ms) : "–"}</TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    <Chip tone={CRON_TONE[c.state]}>{c.state === "unknown" ? "not seen yet" : c.state}</Chip>
                    {c.lastError && <p className="mt-1 max-w-56 truncate text-2xs text-tone-bad" title={c.lastError}>{c.lastError}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="grid content-start gap-5 lg:col-span-2">
        <Card id="runs" className="scroll-mt-16 gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle>Runs, last 24h</CardTitle>
            <CardDescription className="text-xs">
              Against the {r.runs.baseline.days} days before: about {r.runs.baseline.runsPerDay} runs a day, {Math.round(r.runs.baseline.errorRate * 100)}%
              failed, p95 {fmtDuration(r.runs.baseline.p95Ms)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.runs.bySource.map((x) => (
                  <TableRow key={x.source}>
                    <TableCell className="text-xs">{x.source}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{x.runs}</TableCell>
                    <TableCell className={cn("text-right text-xs tabular-nums", x.errors && TONE_TEXT.bad)}>{x.errors}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtDuration(x.p95Ms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground">
              {r.runs.missedReplies} ended with no reply and no hand-off · {r.runs.escalated} escalated · {r.runs.slow} over 4 min
            </p>
          </CardContent>
        </Card>
        <Card id="events" className="scroll-mt-16 gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle>Warnings and errors, last 24h</CardTitle>
            <CardDescription className="text-xs">
              {r.events.errors24h} errors, {r.events.warns24h} warnings in Jetta&apos;s event log (it reaches back {r.events.spanHours}h).
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            {r.events.top.length ? (
              <ul className="grid gap-1">
                {r.events.top.slice(0, 10).map((e) => (
                  <li key={e.event} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("size-1.5 shrink-0 rounded-full", e.level === "error" ? "bg-tone-bad" : "bg-tone-warn")} aria-hidden />
                      <span className="truncate font-mono">{e.event}</span>
                      {e.isNew && <Chip tone="warn">new</Chip>}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {e.count24h}
                      {e.perDayBefore != null ? ` · usual ${e.perDayBefore}/day` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusStrip({ s }: { s: SelfReviewSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Judge</span>
        <Chip tone="info">{modelName(s.settings.judge)}</Chip>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Judged today</span>
        <span className="tabular-nums">
          {s.quality.judgedToday} / {s.settings.dailyCap}
        </span>
      </span>
      <span className="flex items-center gap-1.5" title={s.settings.channel ? `Channel ${s.settings.channel}` : undefined}>
        <span className="text-muted-foreground">Slack</span>
        <Chip tone={s.settings.alerts ? "info" : "neutral"}>{s.settings.alerts ? "on" : "off"}</Chip>
      </span>
      {!s.settings.enabled && <Chip tone="warn">switched off · showing the last run</Chip>}
    </div>
  );
}

export default function SelfReviewPanel() {
  const [summary, setSummary] = useState<SelfReviewSummary | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/self-review", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
        setSummary(d.summary ?? null);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useDataVersion(["selfreview"], load);

  const opened = useMemo(() => summary?.quality.recent.find((j) => j.runId === openId) ?? null, [summary, openId]);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await fetch("/api/admin/self-review", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? d.error ?? requestFailed(r));
      toast.success(
        `Checked · ${d.judged ?? 0} repl${d.judged === 1 ? "y" : "ies"} judged · ${d.flags ?? 0} flag${d.flags === 1 ? "" : "s"} · ${d.actionFindings ?? 0} action finding${d.actionFindings === 1 ? "" : "s"}`,
      );
      if (d.summary !== undefined) setSummary(d.summary);
      else load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const runButton = (
    <Button variant="outline" size="sm" onClick={runNow} disabled={running}>
      <RotateCw className={running ? "animate-spin" : undefined} />
      {running ? "Reviewing… (up to 3 min)" : "Run now"}
    </Button>
  );

  const header = (
    <PageHeader
      title="Self-review"
      description={DESCRIPTION}
      actions={
        summary ? (
          <>
            <span className="text-xs text-muted-foreground">
              Last run <RelativeTime at={Math.floor(summary.computedAt / 1000)} />
            </span>
            {runButton}
          </>
        ) : undefined
      }
    />
  );

  if (err) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{err}</AlertTitle>
        </Alert>
      </>
    );
  }
  if (summary === undefined) {
    return (
      <>
        {header}
        <div className="grid gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-56" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }
  if (!summary) {
    return (
      <>
        {header}
        <EmptyState
          icon={Stethoscope}
          title="The self-review hasn't run yet"
          hint="An hourly job checks Jetta's jobs and runs and has an independent model judge a few of her replies. Run now does it immediately (1 to 3 minutes)."
          action={runButton}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
        <StatusStrip s={summary} />
        <Headline s={summary} />
        <Flags s={summary} />
        <Actions s={summary} />
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <Trend s={summary} />
          <Fixes s={summary} open={setOpenId} />
        </div>
        <Replies s={summary} open={setOpenId} />
        <Reliability s={summary} />
      </div>
      <ReplySheet reply={opened} onClose={() => setOpenId(null)} />
    </>
  );
}
