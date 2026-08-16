"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Flame,
  GraduationCap,
  ArrowRight,
  RotateCw,
  Siren,
  Sparkles,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { displayTopic } from "@/lib/topics";
import { appName } from "@/lib/types";
import { fmtAgo, fmtDateTime, useNow } from "@/lib/format";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { StepCard } from "@/components/jetta/step-card";
import { StatusChip } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";

/** Every clickable reference the API returns carries its own resolved link. */
interface Ref {
  label: string;
  url: string | null;
  external: boolean;
}
interface TopicTicket extends Ref {
  ticketId: string;
  subject: string;
  at: number;
  product: string;
  app: string;
  channel: string;
  escalated: boolean;
}
interface Trend {
  topic: string;
  recent: number;
  baselinePerDay: number | null;
  multiplier: number | null;
  isNew: boolean;
  kbArticle: string | null;
  apps: { app: string; count: number }[];
  tickets: TopicTicket[];
}
interface QueueItem extends Ref {
  ticketId: string;
  subject: string;
  topic: string | null;
  product: string;
  app: string;
  at: number;
}
interface LearningItem {
  id: string;
  text: string;
  category: string;
  product: string;
  createdAt: number;
}
interface Insight {
  headline: string;
  startHere: string;
  highlights: string[];
  generatedAt: number;
  model: string;
}
interface Brief {
  generatedAt: number;
  windowHours: number;
  summary: { arrived: number; answered: number; waiting: number; escalated: number; reopened: number };
  byApp: { app: string; count: number }[];
  narrative: { headline: string; highlights: string[]; watchouts: string[]; generatedAt: number } | null;
  narrativeDate: string | null;
  trends: {
    partialHistory: boolean;
    historyDaysCovered: number;
    baselineDays: number;
    unlabelled: number;
    emerging: Trend[];
    top: Trend[];
  };
  queue: {
    learnings: { count: number; items: LearningItem[] };
    escalations: { count: number; items: QueueItem[] };
    reopened: { count: number; items: QueueItem[] };
    kbReview: number;
    billingApprovals: number;
  };
  documentNext: {
    topic: string;
    count: number;
    reopened: number;
    kbArticle: string | null;
    apps: string[];
    tickets: (Ref & { ticketId: string; subject: string })[];
  }[];
}



function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-mono text-sm font-semibold">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>;
}

/**
 * How loud to be about a spike. The label always carries the number — colour
 * on its own would leave the severity unreadable to anyone who can't separate
 * the hues, and unreadable in print.
 */
function spikeChip(t: Trend) {
  if (t.isNew) return { tone: "stale" as const, text: "new issue" };
  if (t.multiplier == null) return { tone: "draft" as const, text: `${t.recent} in 24h` };
  if (t.multiplier >= 5) return { tone: "stale" as const, text: `${t.multiplier}× normal` };
  return { tone: "draft" as const, text: `${t.multiplier}× normal` };
}

/**
 * A ticket / conversation reference. Not everything is a Freshdesk ticket:
 * chat conversations have UUIDs, and a Freshchat one has nowhere to link at
 * all, so it renders as plain text rather than a dead link.
 */
function TicketRef({ item }: { item: { label: string; url: string | null; external: boolean } }) {
  const cls = "inline-flex items-center gap-1 font-mono text-xs";
  if (!item.url) return <span className={`${cls} text-muted-foreground`}>{item.label}</span>;
  if (!item.external)
    return (
      <Link href={item.url} className={`${cls} text-primary hover:underline`}>
        {item.label}
      </Link>
    );
  return (
    <a href={item.url} target="_blank" rel="noreferrer" className={`${cls} text-primary hover:underline`}>
      {item.label}
      <ExternalLink className="size-3 shrink-0 opacity-60" aria-hidden />
    </a>
  );
}

function QueueTile({
  href,
  icon: Icon,
  label,
  count,
  hint,
  urgent,
}: {
  /** Omitted when the reader has nowhere useful to go — the tile still counts. */
  href?: string;
  icon: typeof BookOpen;
  label: string;
  count: number;
  hint?: string;
  urgent?: boolean;
}) {
  const body = (
    <>
      <Icon className={`mt-0.5 size-4 shrink-0 ${count ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-semibold">{count}</span>
          <span className="truncate text-sm">{label}</span>
        </div>
        {hint && (
          <p className={`mt-0.5 text-xs ${urgent ? "font-medium text-tone-bad" : "text-muted-foreground"}`}>
            {hint}
          </p>
        )}
      </div>
    </>
  );
  const base = "flex items-start gap-3 rounded-lg border bg-muted/40 p-3";
  if (!href) return <div className={base}>{body}</div>;
  return (
    <Link
      href={href}
      className={`${base} transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
    >
      {body}
    </Link>
  );
}

/**
 * `isAdmin` gates the three approval tiles — learnings, KB review, billing.
 * Not a security measure: those actions are refused by their own API routes.
 * It stops a general user being pointed at three counters they will be told
 * "no" on, which reads as the page being broken rather than as the page being
 * someone else's job.
 */
export default function TodayBrief({ isAdmin = true }: { isAdmin?: boolean }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [insightState, setInsightState] = useState<"loading" | "ready" | "failed">("loading");
  const [insightStale, setInsightStale] = useState(false);
  const now = useNow();

  const load = useCallback(() => {
    fetch("/api/admin/today", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setBrief(d as Brief);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Fetched separately from the numbers: assembling the brief already takes a
  // couple of seconds and an LLM call on top would make the page feel stuck.
  //
  // State updates live in the promise callbacks, not the function body, so the
  // mount effect satisfies react-hooks/set-state-in-effect — the initial
  // "loading" covers the first fetch, same as the other console panels.
  const loadInsight = useCallback((force = false) => {
    fetch(`/api/admin/today/insight${force ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setInsight(d.insight ?? null);
        setInsightStale(!!d.stale);
        setInsightState(d.insight ? "ready" : "failed");
      })
      .catch(() => setInsightState("failed"));
  }, []);

  useEffect(() => {
    load();
    loadInsight();
  }, [load, loadInsight]);

  const refresh = () => {
    setLoading(true);
    setErr(null);
    void load();
  };

  const rewriteInsight = () => {
    setInsightState("loading");
    void loadInsight(true);
  };

  const s = brief?.summary;
  const q = brief?.queue;
  const emerging = brief?.trends.emerging ?? [];

  return (
    <div className="space-y-5">
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

      {loading && !brief && (
        <>
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
        </>
      )}

      {brief && s && (
        <>
          {/* ── Overnight ───────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Last {brief.windowHours} hours</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
                  <RotateCw className={loading ? "animate-spin" : undefined} /> Refresh
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Every tile here is the same 24h window — the open-queue total
                  lives on the queue card, so the row never mixes timeframes. */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Came in">{s.arrived}</Stat>
                <Stat label="Jetta answered">{s.answered}</Stat>
                <Stat label="Escalated">{s.escalated}</Stat>
                <Stat label="Reopened">{s.reopened}</Stat>
              </div>

              {brief.byApp.length > 0 && (
                <div className="space-y-2">
                  <SectionLabel>Which app</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {brief.byApp.map((a) => (
                      <StatusChip key={a.app} tone={a.app === "unknown" ? "archived" : "in_review"}>
                        {appName(a.app)} · {a.count}
                      </StatusChip>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2">
                    <Sparkles className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                      Your briefing
                    </span>
                    {insightStale && <StatusChip tone="draft">stale</StatusChip>}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={rewriteInsight}
                    disabled={insightState === "loading"}
                  >
                    <RotateCw className={insightState === "loading" ? "animate-spin" : undefined} /> Rewrite
                  </Button>
                </div>

                {insightState === "loading" && !insight && (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                )}

                {insightState === "failed" && !insight && (
                  <p className="text-sm text-muted-foreground">
                    Couldn&apos;t write the briefing just now — the numbers above are unaffected.
                  </p>
                )}

                {insight && (
                  <div className="space-y-3">
                    <p className="text-sm font-semibold">{insight.headline}</p>
                    <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                      <ArrowRight className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <p className="text-sm">
                        <span className="font-medium">Start here: </span>
                        {insight.startHere}
                      </p>
                    </div>
                    {insight.highlights.length > 0 && (
                      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                        {insight.highlights.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Written {fmtAgo(Math.floor(insight.generatedAt / 1000), now)} from the numbers on this page.
                      {brief.narrativeDate ? ` Yesterday's full digest is on Insights.` : ""}
                    </p>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-muted-foreground">
                Counts tickets Jetta handled — not all Freshdesk traffic. Updated{" "}
                {fmtDateTime(Math.floor(brief.generatedAt / 1000))}.
              </p>
            </CardContent>
          </Card>

          {/* ── Emerging issues ─────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Emerging issues</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {brief.trends.partialHistory && (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>
                    Only {brief.trends.historyDaysCovered} days of labelled history — not enough to tell a spike from a
                    normal Tuesday yet. Showing today&apos;s busiest themes instead.
                  </AlertTitle>
                </Alert>
              )}

              {emerging.length ? (
                emerging.map((t) => {
                  const chip = spikeChip(t);
                  return (
                    <StepCard
                      key={t.topic}
                      title={
                        <span className="inline-flex items-center gap-1.5">
                          <Flame className="size-4 shrink-0" aria-hidden />
                          {displayTopic(t.topic)}
                        </span>
                      }
                      meta={
                        <>
                          {t.apps
                            .filter((a) => a.app !== "unknown")
                            .slice(0, 2)
                            .map((a) => (
                              <StatusChip key={a.app} tone="in_review">
                                {appName(a.app)}
                              </StatusChip>
                            ))}
                          <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
                          <StatusChip tone={t.kbArticle ? "published" : "draft"}>
                            {t.kbArticle ? "in KB" : "no KB article"}
                          </StatusChip>
                        </>
                      }
                    >
                      <p className="text-xs text-muted-foreground">
                        {t.recent} {t.recent === 1 ? "ticket" : "tickets"} in the last {brief.windowHours}h
                        {t.baselinePerDay != null && (
                          <> · usually {t.baselinePerDay === 0 ? "none" : `~${t.baselinePerDay}/day`}</>
                        )}
                        {t.kbArticle && <> · covered by “{t.kbArticle}”</>}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {t.tickets.map((tk) => (
                          <TicketRef key={tk.ticketId} item={tk} />
                        ))}
                      </div>
                    </StepCard>
                  );
                })
              ) : (
                <EmptyState
                  icon={CheckCircle2}
                  title="Nothing spiking"
                  hint={`No topic is running meaningfully above its usual rate in the last ${brief.windowHours} hours.`}
                />
              )}

              {brief.trends.top.length > 0 && (
                <div className="space-y-2 pt-1">
                  <SectionLabel>Steady themes (last {brief.trends.baselineDays} days)</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {brief.trends.top.map((t) => (
                      <StatusChip key={t.topic}>
                        {displayTopic(t.topic)}
                        {t.baselinePerDay != null && t.baselinePerDay > 0 ? ` · ~${t.baselinePerDay}/day` : ""}
                      </StatusChip>
                    ))}
                  </div>
                </div>
              )}

              {brief.trends.unlabelled > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {brief.trends.unlabelled} ticket{brief.trends.unlabelled === 1 ? "" : "s"} in the window carry no topic
                  label and aren&apos;t counted above.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── The queue ───────────────────────────────────────── */}
          {q && (
            <Card>
              <CardHeader>
                <CardTitle>
                  Waiting on a human
                  <span className="ml-2 font-mono text-sm font-semibold text-muted-foreground">
                    {s.waiting} {s.waiting === 1 ? "ticket" : "tickets"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className={`grid gap-3 ${isAdmin ? "grid-cols-2 md:grid-cols-4" : "grid-cols-1"}`}>
                  {isAdmin && (
                    <>
                      <QueueTile
                        href="/evals"
                        icon={GraduationCap}
                        label="learnings"
                        count={q.learnings.count}
                        hint={q.learnings.count ? "approve to apply" : "none proposed"}
                      />
                      <QueueTile href="/kb/review" icon={BookOpen} label="KB to review" count={q.kbReview} />
                      <QueueTile
                        href="/billing"
                        icon={CreditCard}
                        label="billing approvals"
                        count={q.billingApprovals}
                      />
                    </>
                  )}
                  <QueueTile
                    href={isAdmin ? "/analytics" : undefined}
                    icon={Undo2}
                    label="reopened this week"
                    count={q.reopened.count}
                    hint="Jetta's answer didn't land"
                  />
                </div>

                {isAdmin && q.learnings.count > 0 && (
                  <div className="space-y-2">
                    <SectionLabel>Candidate learnings — approve to change how Jetta writes</SectionLabel>
                    {q.learnings.items.map((l) => (
                      <StepCard
                        key={l.id}
                        title={
                          <span className="inline-flex items-center gap-1.5">
                            <GraduationCap className="size-4 shrink-0" aria-hidden />
                            {l.category}
                          </span>
                        }
                        meta={<StatusChip tone="in_review">{l.product}</StatusChip>}
                      >
                        <p className="text-xs text-muted-foreground">{l.text}</p>
                      </StepCard>
                    ))}
                  </div>
                )}

                {q.escalations.count > 0 && (
                  <div className="space-y-2">
                    <SectionLabel>Escalated to the team (last 72h)</SectionLabel>
                    {q.escalations.items.map((e) => (
                      <StepCard
                        key={e.ticketId}
                        title={
                          <span className="inline-flex items-center gap-1.5">
                            <Siren className="size-4 shrink-0" aria-hidden />
                            <TicketRef item={e} />
                          </span>
                        }
                        meta={
                          <>
                            {e.topic && <StatusChip>{displayTopic(e.topic)}</StatusChip>}
                            <span title={new Date(e.at * 1000).toLocaleString()}>{fmtAgo(e.at, now)}</span>
                          </>
                        }
                      >
                        <p className="text-xs text-muted-foreground">{e.subject}</p>
                      </StepCard>
                    ))}
                  </div>
                )}

                {q.reopened.count > 0 && (
                  <div className="space-y-2">
                    <SectionLabel>Reopened — the customer came back</SectionLabel>
                    {q.reopened.items.map((r) => (
                      <StepCard
                        key={r.ticketId}
                        title={
                          <span className="inline-flex items-center gap-1.5">
                            <Undo2 className="size-4 shrink-0" aria-hidden />
                            <TicketRef item={r} />
                          </span>
                        }
                        meta={
                          <>
                            {r.topic && <StatusChip>{displayTopic(r.topic)}</StatusChip>}
                            <span title={new Date(r.at * 1000).toLocaleString()}>{fmtAgo(r.at, now)}</span>
                          </>
                        }
                      >
                        <p className="text-xs text-muted-foreground">{r.subject}</p>
                      </StepCard>
                    ))}
                  </div>
                )}

                {/* Only count what this reader can act on, or the page claims
                    work is outstanding and then shows them none of it. */}
                {q.escalations.count === 0 &&
                  q.reopened.count === 0 &&
                  (!isAdmin ||
                    (q.learnings.count === 0 && q.kbReview === 0 && q.billingApprovals === 0)) && (
                    <EmptyState
                      icon={CheckCircle2}
                      title="Queue's clear"
                      hint="Nothing is waiting on a human right now."
                    />
                  )}
              </CardContent>
            </Card>
          )}

          {/* ── Document next ───────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Worth documenting</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {brief.documentNext.length ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Themes Jetta couldn&apos;t close herself this week, grouped so one article closes the whole
                    group. Uncovered themes first.
                  </p>
                  {brief.documentNext.map((g) => (
                    <StepCard
                      key={g.topic}
                      title={
                        <span className="inline-flex items-center gap-1.5">
                          <BookOpen className="size-4 shrink-0" aria-hidden />
                          {g.topic === "unlabelled" ? "Unlabelled" : displayTopic(g.topic)}
                        </span>
                      }
                      meta={
                        <>
                          {g.apps.slice(0, 2).map((a) => (
                            <StatusChip key={a} tone="in_review">
                              {appName(a)}
                            </StatusChip>
                          ))}
                          <StatusChip tone={g.kbArticle ? "published" : "stale"}>
                            {g.kbArticle ? "in KB" : "nothing written"}
                          </StatusChip>
                        </>
                      }
                    >
                      <p className="text-xs text-muted-foreground">
                        {g.count} {g.count === 1 ? "ticket" : "tickets"}
                        {g.reopened > 0 && `, ${g.reopened} reopened`}
                        {g.kbArticle && <> · covered by “{g.kbArticle}”</>}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {g.tickets.map((t) => (
                          <TicketRef key={t.ticketId} item={t} />
                        ))}
                      </div>
                    </StepCard>
                  ))}
                </>
              ) : (
                <EmptyState
                  icon={CheckCircle2}
                  title="No gaps this week"
                  hint="Jetta closed everything she picked up — nothing escalated or reopened."
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
