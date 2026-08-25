"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CheckCircle2,
  ExternalLink,
  Flame,
  MessageSquare,
  ArrowRight,
  RotateCw,
  Rocket,
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
import { MetricRow } from "@/components/jetta/metric-row";
import { DataList, DataRow } from "@/components/jetta/data-row";
import { SectionHeader } from "@/components/jetta/page-header";

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
  /** The worklist in priority order. Ids are guaranteed real — see reconcileRanking. */
  ranking: { id: string; why: string | null }[];
  concerns: string[];
  recommendations: string[];
  generatedAt: number;
  model: string;
}
interface WorklistItem {
  id: string;
  signals: ("chat_waiting" | "reopened" | "escalated")[];
  label: string;
  url: string | null;
  external: boolean;
  subject: string;
  topic: string | null;
  app: string;
  at: number;
  ageHours: number;
  state: "active" | "stalled";
  quietHours: number;
  runs: number;
  status: string | null;
}
interface ReleaseMentionRow extends Ref {
  ticketId: string;
  subject: string;
  kind: string;
  quote: string;
  app: string | null;
  at: number;
}
interface ReleaseSection {
  id: string;
  name: string;
  since: string;
  releaseDate: string | null;
  total: number;
  byKind: Record<string, number>;
  lastMentionAt: number | null;
  mentions: ReleaseMentionRow[];
}
interface Brief {
  generatedAt: number;
  windowHours: number;
  releases: ReleaseSection[];
  summary: { arrived: number; answered: number; waiting: number; escalated: number; reopened: number };
  byApp: { app: string; count: number }[];
  worklist: WorklistItem[];
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


/**
 * One line of the worklist.
 *
 * The signals and the quiet time carry the urgency, so they sit in the meta
 * column where the eye runs down them. `why` is the model's one clause on why
 * this sits here; when it is absent the row is in deterministic order and says
 * nothing rather than inventing a justification.
 */
function WorklistRow({ item, why }: { item: WorklistItem; why: string | null }) {
  const waiting = item.signals.includes("chat_waiting");
  const reopened = item.signals.includes("reopened");
  const Icon = waiting ? MessageSquare : reopened ? Undo2 : Siren;
  return (
    <DataRow
      href={item.url ?? undefined}
      external={item.external}
      icon={
        <Icon
          className={waiting || item.state === "active" ? "text-tone-bad" : undefined}
          aria-hidden
        />
      }
      title={
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono text-xs">{item.label}</span>
          {waiting && <StatusChip tone="stale">waiting</StatusChip>}
          {reopened && <StatusChip tone="stale">reopened</StatusChip>}
          {!waiting && item.state === "active" && <StatusChip tone="in_review">active</StatusChip>}
        </span>
      }
      detail={
        <>
          {item.subject}
          {why && <span className="text-foreground"> — {why}</span>}
        </>
      }
      meta={
        <>
          {/* The live Freshdesk status, not the one Jetta last recorded — a
              ticket sitting on "waiting on customer" is not waiting on us. */}
          {item.status && (
            <StatusChip tone={item.status === "waiting on customer" ? "archived" : "in_review"}>
              {item.status}
            </StatusChip>
          )}
          {item.runs > 1 && <span>{item.runs}&nbsp;exchanges</span>}
          <span title={new Date(item.at * 1000).toLocaleString()}>
            quiet {item.quietHours}h
          </span>
        </>
      }
    />
  );
}


/**
 * Today is the agent's worklist. Approving learnings, reviewing articles and
 * deciding billing all left this page for their own — they are admin work on a
 * different clock, and mixing them in made the morning read a mixed pile with
 * no single spine.
 */
/** Chip colour per mention kind — bugs read as bad, praise as good. */
const KIND_TONE: Record<string, "draft" | "in_review" | "published" | "archived" | "stale"> = {
  bug: "stale",
  confusion: "draft",
  "how-to": "in_review",
  "feature-request": "archived",
  praise: "published",
  other: "archived",
};
const KIND_ORDER = ["bug", "confusion", "how-to", "feature-request", "praise", "other"];

/** Days since a unix-ms timestamp, floored. */
const daysSince = (ms: number) => Math.floor((Date.now() - ms) / 86_400_000);

/**
 * Customer voice on newly shipped features — written for the product manager,
 * not the support queue: what people ask, in their own words, split into
 * docs/UX findings (how-to, confusion), engineering (bug) and roadmap
 * (feature-request). Rolling since each watch started, never day-scoped.
 * A watch quiet for two weeks collapses instead of leaving the page.
 */
function ReleaseWatchCard({ releases }: { releases: ReleaseSection[] }) {
  const now = useNow();
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);

  /**
   * Wipe the mention store and resweep history through the classifier. The
   * escape hatch for a matching change: live tagging can only add entries, so
   * stricter rules need a rebuild to shed old false positives. Takes a minute
   * or two — the sweep reruns the light model over every ticket since the
   * watch start.
   */
  const rebuild = async () => {
    setRebuilding(true);
    setRebuildNote(null);
    try {
      const res = await fetch("/api/admin/release-watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (!res.ok) throw new Error(`rebuild failed (${res.status})`);
      const r = (await res.json()) as { ticketsScanned: number; ticketHits: number; chatHits: number };
      setRebuildNote(
        `Rescanned ${r.ticketsScanned} tickets — ${r.ticketHits + r.chatHits} genuine mentions. Refresh to see the list.`,
      );
    } catch (e) {
      setRebuildNote(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4 text-primary" aria-hidden />
          New releases — what customers are saying
        </CardTitle>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={rebuild} disabled={rebuilding}>
            <RotateCw className={rebuilding ? "size-3.5 animate-spin" : "size-3.5"} />
            {rebuilding ? "Rescanning history…" : "Rebuild from history"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Every ticket and chat is read for mentions of these at triage time. How-to and confusion
          are documentation findings; bugs and feature asks are product ones.
        </p>
        {rebuildNote && <p className="text-xs font-medium text-primary">{rebuildNote}</p>}
        {releases.map((r) => {
          const quietDays = r.lastMentionAt ? daysSince(r.lastMentionAt) : null;
          const dormant = r.total === 0 || (quietDays !== null && quietDays > 14);
          return (
            <StepCard
              key={r.id}
              collapsible
              defaultOpen={!dormant}
              title={r.name}
              meta={
                <>
                  {KIND_ORDER.filter((k) => (r.byKind[k] ?? 0) > 0).map((k) => (
                    <StatusChip key={k} tone={KIND_TONE[k] ?? "archived"}>
                      {k.replace("-", " ")} {r.byKind[k]}
                    </StatusChip>
                  ))}
                  <span>
                    {/* The ship date when we know it; the scan-window start when we don't. */}
                    {r.total === 0
                      ? `no mentions · ${r.releaseDate ? `released ${r.releaseDate}` : `watching since ${r.since}`}`
                      : `${r.total} mention${r.total === 1 ? "" : "s"} · ${r.releaseDate ? `released ${r.releaseDate}` : `watching since ${r.since}`}${quietDays !== null && quietDays > 14 ? ` · quiet ${quietDays}d` : ""}`}
                  </span>
                </>
              }
            >
              {r.total === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nobody has written in about this yet — either it&apos;s landing smoothly or nobody
                  has found it. Silence here is adoption signal, not a broken filter.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {r.mentions.map((m) => (
                    <li key={m.ticketId} className="space-y-0.5 text-sm">
                      <p>“{m.quote}”</p>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <StatusChip tone={KIND_TONE[m.kind] ?? "archived"}>
                          {m.kind.replace("-", " ")}
                        </StatusChip>
                        <TicketRef item={m} />
                        {m.app && <span>{appName(m.app)}</span>}
                        {/* Mentions timestamp in ms; fmtAgo speaks unix seconds. */}
                        <span>{fmtAgo(Math.floor(m.at / 1000), now)}</span>
                      </p>
                    </li>
                  ))}
                  {r.total > r.mentions.length && (
                    <li className="text-xs text-muted-foreground">
                      …and {r.total - r.mentions.length} more.
                    </li>
                  )}
                </ul>
              )}
            </StepCard>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function TodayBrief() {
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

  /*
   * The model's order when it produced one, the deterministic order otherwise.
   * reconcileRanking guarantees the ids are real and complete, so this is a
   * lookup rather than a filter — but the page still falls back cleanly on the
   * first load, before the insight has arrived.
   */
  const whyFor = new Map((insight?.ranking ?? []).map((r) => [r.id, r.why]));
  const byId = new Map((brief?.worklist ?? []).map((w) => [w.id, w]));
  const ranked: WorklistItem[] = insight?.ranking?.length
    ? insight.ranking.map((r) => byId.get(r.id)).filter((w): w is WorklistItem => !!w)
    : (brief?.worklist ?? []);

  const waitingChats = (brief?.worklist ?? []).filter((w) =>
    w.signals.includes("chat_waiting"),
  ).length;
  const longestQuiet = brief?.worklist.length
    ? Math.max(...brief.worklist.map((w) => w.quietHours))
    : null;

  const s = brief?.summary;
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
              {/* Every metric here is the same 24h window — the open-queue total
                  lives on the queue card, so the row never mixes timeframes.
                  Tone only where the number is itself a state: escalated and
                  reopened mean someone has work, answered and arrived don't. */}
              {/* Describes the worklist, not a 24h window. The old strip counted
                  arrivals, so on a quiet weekend it read four zeros directly
                  above nine people waiting — the top of the page contradicting
                  the rest of it. */}
              <MetricRow
                metrics={[
                  {
                    label: "Need you",
                    value: brief.worklist.length,
                    tone: brief.worklist.length ? "bad" : "good",
                  },
                  {
                    label: "Waiting in chat",
                    value: waitingChats,
                    tone: waitingChats ? "bad" : undefined,
                    hint: waitingChats ? "someone is sitting there" : undefined,
                  },
                  {
                    label: "Longest quiet",
                    value: longestQuiet == null ? "—" : `${longestQuiet}h`,
                    tone: longestQuiet != null && longestQuiet >= 48 ? "warn" : undefined,
                  },
                  { label: "Came in (24h)", value: s.arrived, hint: `${s.answered} answered` },
                ]}
              />

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

          {/* ── ① What needs you now ────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>
                What needs you now
                <span className="ml-2 font-mono text-sm font-semibold text-muted-foreground">
                  {brief.worklist.length}
                </span>
              </CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
                  <RotateCw className={loading ? "animate-spin" : undefined} /> Refresh
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {brief.worklist.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Queue's clear"
                  hint="Nobody is waiting on a person right now."
                />
              ) : (
                <DataList>
                  {ranked.map((w) => (
                    <WorklistRow key={w.id} item={w} why={whyFor.get(w.id) ?? null} />
                  ))}
                </DataList>
              )}
            </CardContent>
          </Card>

          {/* ── ② What's going wrong ────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>What&apos;s going wrong</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {insight?.concerns.length ? (
                <ul className="space-y-1.5">
                  {insight.concerns.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-tone-warn" aria-hidden />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing bigger than the individual tickets above.
                </p>
              )}

              {/* The evidence under the prose — spikes stay the source of truth. */}
              {brief.trends.partialHistory && (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>
                    Only {brief.trends.historyDaysCovered} days of labelled history — not enough to tell a
                    spike from a normal Tuesday yet.
                  </AlertTitle>
                </Alert>
              )}
              {emerging.length > 0 && (
                <div className="space-y-1.5">
                  <SectionHeader meta={emerging.length}>Topics above their normal rate</SectionHeader>
                  <DataList>
                    {emerging.map((t) => {
                      const chip = spikeChip(t);
                      return (
                        <DataRow
                          key={t.topic}
                          icon={<Flame aria-hidden />}
                          title={displayTopic(t.topic)}
                          detail={`${t.recent} in 24h${
                            t.apps.length ? ` · ${t.apps.map((a) => appName(a.app)).join(", ")}` : ""
                          }`}
                          meta={
                            <>
                              <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
                              <StatusChip tone={t.kbArticle ? "published" : "draft"}>
                                {t.kbArticle ? "in KB" : "no article"}
                              </StatusChip>
                            </>
                          }
                        />
                      );
                    })}
                  </DataList>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── New releases — customer voice, for product ──────── */}
          {brief.releases.length > 0 && <ReleaseWatchCard releases={brief.releases} />}

          {/* ── ③ What would help ───────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>What would help</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {insight?.recommendations.length ? (
                <ul className="space-y-1.5">
                  {insight.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <ArrowRight className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing to write up right now.</p>
              )}
            </CardContent>
          </Card>

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
