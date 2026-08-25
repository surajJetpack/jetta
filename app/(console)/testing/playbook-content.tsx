/**
 * The interactive half of /testing — a one-scenario-at-a-time wizard.
 *
 * The playbook used to render as one long scroll of fourteen cards, which read
 * as an exam. Now there is an overview (pick any scenario, see everyone's
 * progress) and a focused view showing exactly one scenario, with prev/next,
 * arrow-key navigation, and the cleanup as the final stop of the walk.
 *
 * Everything a tester ticks is saved immediately under their own login (the
 * API takes the username from the session, so nobody can tick for a teammate)
 * and optimistically in the UI — running scenarios in a coffee break must
 * never feel like filling in a form. Failure notes are the one text field,
 * and only appear once a scenario is marked failed.
 *
 * The cleanup stop carries the auto-cleanup: scan first (GET, read-only, shows
 * the exact list), then clean (POST). The tester always sees what will be
 * touched before anything irreversible happens.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Info,
  ListChecks,
  Loader2,
  PartyPopper,
  Play,
  RotateCw,
  Sparkles,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { StepCard } from "@/components/jetta/step-card";
import { SectionHeader } from "@/components/jetta/page-header";
import { cn } from "@/lib/utils";
import {
  PLAYBOOK,
  PLAYBOOK_CLEANUP,
  PLAYBOOK_RULES,
  totalScenarios,
  type PlaybookLink,
  type PlaybookProgress,
  type PlaybookScenario,
  type PlaybookTrack,
  type ScenarioProgress,
} from "@/lib/test-playbook";

/**
 * One screen of the wizard: the intro (rules, what you'll test, team results),
 * a scenario, or the final cleanup stop. The overview outside the wizard is
 * deliberately just a scoreboard and a Start button — everything else lives
 * inside the flow so there is exactly one thing to click.
 */
type Stop =
  | { kind: "intro" }
  | { kind: "scenario"; track: PlaybookTrack; scenario: PlaybookScenario; nthInTrack: number }
  | { kind: "cleanup" };

const STOPS: Stop[] = [
  { kind: "intro" },
  ...PLAYBOOK.flatMap((track) =>
    track.scenarios.map((scenario, i): Stop => ({ kind: "scenario", track, scenario, nthInTrack: i + 1 })),
  ),
  { kind: "cleanup" },
];

/** Copy-to-clipboard block for the exact texts a tester sends. */
function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-background p-2">
      <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{text}</p>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: total ? `${Math.round((100 * done) / total)}%` : "0%" }}
      />
    </div>
  );
}

/** A "have this open" link — always a new tab, so the run in progress survives. */
function LinkButton({ link }: { link: PlaybookLink }) {
  const external = link.href.startsWith("http");
  return (
    <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
      <Link href={link.href} target="_blank" rel={external ? "noreferrer" : undefined}>
        {link.label} <ExternalLink className="size-3" />
      </Link>
    </Button>
  );
}

export default function PlaybookContent({
  user,
  initialMine,
  team,
  isAdmin,
}: {
  user: string;
  initialMine: PlaybookProgress;
  /**
   * Progress keyed by console username — includes the viewer. For general
   * users the server sends ONLY their own entry (teammates' detail is
   * admin-only); the isAdmin flag just keeps the section from rendering as
   * an empty shell for them.
   */
  team: Record<string, PlaybookProgress>;
  isAdmin: boolean;
}) {
  const [mine, setMine] = useState<PlaybookProgress>(initialMine);
  /** null = overview, otherwise an index into STOPS. */
  const [at, setAt] = useState<number | null>(null);
  const total = totalScenarios();
  const done = Object.entries(mine).filter(([id, s]) => id !== "cleanup" && s.outcome).length;

  /** Optimistic save: update state now, persist in the background. */
  const save = (
    scenarioId: string,
    patch: { checks?: string[]; note?: string; outcome?: "pass" | "fail" | null },
  ) => {
    setMine((m) => {
      const prev = m[scenarioId] ?? { checks: [], updatedAt: "" };
      const entry: ScenarioProgress = {
        ...prev,
        ...("checks" in patch ? { checks: patch.checks ?? [] } : {}),
        ...("note" in patch ? { note: patch.note } : {}),
        updatedAt: new Date().toISOString(),
      };
      if ("outcome" in patch) {
        if (patch.outcome) entry.outcome = patch.outcome;
        else delete entry.outcome;
      }
      return { ...m, [scenarioId]: entry };
    });
    void fetch("/api/playbook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId, ...patch }),
    }).catch(() => {});
  };

  const toggleCheck = (scenario: string, check: string) => {
    const checks = new Set(mine[scenario]?.checks ?? []);
    if (checks.has(check)) checks.delete(check);
    else checks.add(check);
    save(scenario, { checks: [...checks] });
  };

  /**
   * Where the big button goes: the intro on a fresh start, otherwise the first
   * scenario without an outcome, else cleanup.
   */
  const nextUndone = useMemo(() => {
    if (done === 0) return 0;
    const i = STOPS.findIndex((s) => s.kind === "scenario" && !mine[s.scenario.id]?.outcome);
    return i === -1 ? STOPS.length - 1 : i;
  }, [mine, done]);

  // Arrow keys move between stops — but never while someone is typing a note.
  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (e.key === "ArrowRight" && at < STOPS.length - 1) setAt(at + 1);
      if (e.key === "ArrowLeft") setAt(at === 0 ? null : at - 1);
      if (e.key === "Escape") setAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at]);

  // A new stop starts at the top of the page, like turning a page.
  useEffect(() => {
    if (at !== null) window.scrollTo({ top: 0 });
  }, [at]);

  if (at === null) {
    return (
      <Overview
        user={user}
        team={team}
        done={done}
        total={total}
        nextUndone={nextUndone}
        onGo={setAt}
      />
    );
  }

  const stop = STOPS[at];
  return (
    <div className="space-y-4">
      <WizardHeader at={at} mine={mine} onGo={setAt} />
      {stop.kind === "intro" ? (
        <IntroView user={user} mine={mine} team={team} isAdmin={isAdmin} onGo={setAt} />
      ) : stop.kind === "scenario" ? (
        <ScenarioView
          key={stop.scenario.id}
          stop={stop}
          progress={mine[stop.scenario.id]}
          onCheck={(c) => toggleCheck(stop.scenario.id, c)}
          onOutcome={(o) => save(stop.scenario.id, { outcome: o })}
          onNote={(note) => save(stop.scenario.id, { note })}
        />
      ) : (
        <CleanupView
          mine={mine}
          done={done}
          total={total}
          onCheck={(c) => toggleCheck("cleanup", c)}
          onTickAll={(ids) => {
            const merged = new Set([...(mine["cleanup"]?.checks ?? []), ...ids]);
            save("cleanup", { checks: [...merged] });
          }}
        />
      )}
      <WizardFooter at={at} stop={stop} mine={mine} onGo={setAt} />
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────

function outcomeIcon(progress?: ScenarioProgress) {
  if (progress?.outcome === "pass") return <CircleCheck className="size-4 shrink-0 text-primary" />;
  if (progress?.outcome === "fail") return <CircleX className="size-4 shrink-0 text-destructive" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground/40" />;
}

function Overview({
  user,
  team,
  done,
  total,
  nextUndone,
  onGo,
}: {
  user: string;
  team: Record<string, PlaybookProgress>;
  done: number;
  total: number;
  nextUndone: number;
  onGo: (i: number) => void;
}) {
  const nextStop = STOPS[nextUndone];
  const others = Object.entries(team)
    .filter(([name]) => name !== user)
    .map(([name, progress]) => ({
      name,
      done: Object.entries(progress).filter(([id, s]) => id !== "cleanup" && s.outcome).length,
    }));
  return (
    <div className="space-y-6">
      {/* Scoreboard */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              <b>{user}</b> — {done} of {total} scenarios done
              {done === total && total > 0 && (
                <span className="ml-2 inline-flex items-center gap-1 font-semibold text-primary">
                  <PartyPopper className="size-4" /> all of them!
                </span>
              )}
            </p>
            {others.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                {others.map((o) => `${o.name} · ${o.done}/${total}`).join("   ")}
              </p>
            )}
          </div>
          <ProgressBar done={done} total={total} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => onGo(nextUndone)}>
              <Play className="size-4" />
              {nextStop.kind === "intro"
                ? "Start testing"
                : nextStop.kind === "cleanup"
                  ? "Finish up — cleanup"
                  : `Continue — ${nextStop.scenario.title}`}
            </Button>
            <p className="text-xs text-muted-foreground">
              One scenario at a time. Everything you tick is saved as you go — stop anytime and
              pick up later.
            </p>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

// ── Intro stop ─────────────────────────────────────────────────────

/** First page of the wizard: the rules, what you'll be testing, and how the team is doing. */
function IntroView({
  user,
  mine,
  team,
  isAdmin,
  onGo,
}: {
  user: string;
  mine: PlaybookProgress;
  team: Record<string, PlaybookProgress>;
  isAdmin: boolean;
  onGo: (i: number) => void;
}) {
  const cleanupTicked = (mine["cleanup"]?.checks ?? []).length;
  return (
    <div className="space-y-6">
      {/* Rules of the game */}
      <Alert>
        <Info className="size-4" />
        <AlertTitle>Before you start — the rules of the game</AlertTitle>
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
            {PLAYBOOK_RULES.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>

      {PLAYBOOK.map((track) => {
        const trackDone = track.scenarios.filter((s) => mine[s.id]?.outcome).length;
        return (
          <section key={track.id} className="space-y-3">
            <SectionHeader
              meta={`${trackDone}/${track.scenarios.length} · ~${track.scenarios.reduce((n, s) => n + s.minutes, 0)} min`}
            >
              {track.label}
            </SectionHeader>
            <p className="max-w-prose text-sm text-muted-foreground">{track.intro}</p>
            <Card>
              <CardContent className="divide-y p-0">
                {track.scenarios.map((s, i) => {
                  const stopIndex = STOPS.findIndex(
                    (st) => st.kind === "scenario" && st.scenario.id === s.id,
                  );
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => onGo(stopIndex)}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50"
                    >
                      {outcomeIcon(mine[s.id])}
                      <span className="w-4 shrink-0 text-xs font-semibold text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                      {s.pair && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          <Users className="size-3" /> both of you
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">~{s.minutes} min</span>
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          </section>
        );
      })}

      {/* Cleanup entry */}
      <section className="space-y-3">
        <SectionHeader meta={`${cleanupTicked}/${PLAYBOOK_CLEANUP.length}`}>
          Cleanup — leave no trace
        </SectionHeader>
        <Card>
          <CardContent className="p-0">
            <button
              type="button"
              onClick={() => onGo(STOPS.length - 1)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
            >
              <ListChecks className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                The tests touched real systems on purpose — this puts them back. Jetta can now do
                most of it for you.
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-primary">
                <Sparkles className="size-3" /> auto-cleanup
              </span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          </CardContent>
        </Card>
      </section>

      {isAdmin && <TeamResults user={user} mine={mine} team={team} onGo={onGo} />}
    </div>
  );
}

// ── Team results ───────────────────────────────────────────────────

/** Short label a teammate would say out loud: "A3", "B1". */
function scenarioCode(track: PlaybookTrack, nth: number): string {
  return `${track.id === "chat" ? "A" : "B"}${nth}`;
}

/**
 * Everyone's per-scenario outcomes side by side, failure notes included.
 * Admin-only since 2026-08-25 (and the server withholds teammates' detail
 * from general users regardless of what renders): testers see their own run;
 * whoever runs the team reads the room.
 */
function TeamResults({
  user,
  mine,
  team,
  onGo,
}: {
  user: string;
  mine: PlaybookProgress;
  team: Record<string, PlaybookProgress>;
  onGo: (i: number) => void;
}) {
  // The viewer's column reads from live state, so ticking outcomes updates
  // the grid without a reload; teammates' columns are the server snapshot.
  const progressFor = (name: string): PlaybookProgress => (name === user ? mine : (team[name] ?? {}));
  const users = [user, ...Object.keys(team).filter((n) => n !== user).sort()];
  const scenarioStops = STOPS.filter((s): s is Extract<Stop, { kind: "scenario" }> => s.kind === "scenario");

  const failures = users.flatMap((name) =>
    scenarioStops
      .filter((s) => progressFor(name)[s.scenario.id]?.outcome === "fail")
      .map((s) => ({
        name,
        code: scenarioCode(s.track, s.nthInTrack),
        title: s.scenario.title,
        note: progressFor(name)[s.scenario.id]?.note,
        stopIndex: STOPS.indexOf(s),
      })),
  );

  return (
    <section className="space-y-3">
      <SectionHeader meta={users.length === 1 ? "only you so far" : `${users.length} testers`}>
        Team results
      </SectionHeader>
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Scenario</th>
                  {users.map((name) => (
                    <th key={name} className="pb-2 pr-3 text-center font-medium whitespace-nowrap">
                      {name}
                      {name === user && <span className="text-muted-foreground/60"> (you)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scenarioStops.map((s) => (
                  <tr key={s.scenario.id} className="border-t">
                    <td className="py-1.5 pr-3">
                      <button
                        type="button"
                        onClick={() => onGo(STOPS.indexOf(s))}
                        className="flex cursor-pointer items-baseline gap-2 text-left hover:underline"
                      >
                        <span className="w-6 shrink-0 text-xs font-semibold text-muted-foreground">
                          {scenarioCode(s.track, s.nthInTrack)}
                        </span>
                        <span className="truncate">{s.scenario.title}</span>
                      </button>
                    </td>
                    {users.map((name) => {
                      const outcome = progressFor(name)[s.scenario.id]?.outcome;
                      return (
                        <td key={name} className="py-1.5 pr-3 text-center">
                          {outcome === "pass" ? (
                            <CircleCheck className="inline size-4 text-primary" aria-label="passed" />
                          ) : outcome === "fail" ? (
                            <CircleX className="inline size-4 text-destructive" aria-label="failed" />
                          ) : (
                            <Circle className="inline size-3 text-muted-foreground/30" aria-label="not run" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t text-xs text-muted-foreground">
                  <td className="py-1.5 pr-3">Cleanup ticked</td>
                  {users.map((name) => (
                    <td key={name} className="py-1.5 pr-3 text-center">
                      {(progressFor(name)["cleanup"]?.checks ?? []).length}/{PLAYBOOK_CLEANUP.length}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {failures.length > 0 && (
            <div className="space-y-1.5 border-t pt-3">
              <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                What failed, in the tester&apos;s words
              </p>
              {failures.map((f, i) => (
                <p key={i} className="text-sm">
                  <CircleX className="mr-1.5 inline size-3.5 text-destructive" />
                  <b>{f.name}</b> ·{" "}
                  <button
                    type="button"
                    onClick={() => onGo(f.stopIndex)}
                    className="cursor-pointer font-medium hover:underline"
                  >
                    {f.code} {f.title}
                  </button>
                  {f.note ? (
                    <span className="text-muted-foreground"> — “{f.note}”</span>
                  ) : (
                    <span className="text-muted-foreground/70"> — no note yet</span>
                  )}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ── Wizard chrome ──────────────────────────────────────────────────

function WizardHeader({
  at,
  mine,
  onGo,
}: {
  at: number;
  mine: PlaybookProgress;
  onGo: (i: number | null) => void;
}) {
  const stop = STOPS[at];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs" onClick={() => onGo(null)}>
          <ArrowLeft className="size-3.5" /> Overview
        </Button>
        <p className="text-xs text-muted-foreground">
          {stop.kind === "intro" ? (
            <span className="font-medium text-foreground">Before you start</span>
          ) : stop.kind === "scenario" ? (
            <>
              <span className="font-medium text-foreground">{stop.track.label}</span> · scenario {at}{" "}
              of {STOPS.length - 2}
            </>
          ) : (
            <span className="font-medium text-foreground">Last stop — cleanup</span>
          )}
        </p>
      </div>
      {/* One dot per stop: where you are, what passed, what failed. */}
      <div className="flex items-center gap-1">
        {STOPS.map((s, i) => {
          const progress = s.kind === "scenario" ? mine[s.scenario.id] : undefined;
          const label =
            s.kind === "intro"
              ? "Before you start"
              : s.kind === "scenario"
                ? `${i}. ${s.scenario.title}`
                : "Cleanup — leave no trace";
          return (
            <button
              key={i}
              type="button"
              title={label}
              aria-label={label}
              aria-current={i === at ? "step" : undefined}
              onClick={() => onGo(i)}
              className={cn(
                "h-1.5 flex-1 cursor-pointer rounded-full transition-all",
                progress?.outcome === "pass" && "bg-primary",
                progress?.outcome === "fail" && "bg-destructive",
                !progress?.outcome && "bg-muted",
                s.kind !== "scenario" && "max-w-8 bg-muted",
                i === at && "ring-2 ring-ring/50",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

function WizardFooter({
  at,
  stop,
  mine,
  onGo,
}: {
  at: number;
  stop: Stop;
  mine: PlaybookProgress;
  onGo: (i: number | null) => void;
}) {
  const hasOutcome =
    stop.kind === "intro" || (stop.kind === "scenario" && !!mine[stop.scenario.id]?.outcome);
  const last = at === STOPS.length - 1;
  const nextIsCleanup = !last && STOPS[at + 1].kind === "cleanup";
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-3">
      <Button variant="outline" size="sm" onClick={() => onGo(at === 0 ? null : at - 1)}>
        <ArrowLeft className="size-4" /> Previous
      </Button>
      <p className="hidden text-xs text-muted-foreground sm:block">← → keys work too</p>
      {last ? (
        <Button variant="outline" size="sm" onClick={() => onGo(null)}>
          Back to overview
        </Button>
      ) : (
        <Button variant={hasOutcome ? "default" : "outline"} size="sm" onClick={() => onGo(at + 1)}>
          {stop.kind === "intro" ? "Start" : nextIsCleanup ? "Cleanup" : "Next"}{" "}
          <ArrowRight className="size-4" />
        </Button>
      )}
    </div>
  );
}

// ── Scenario view ──────────────────────────────────────────────────

function ScenarioView({
  stop,
  progress,
  onCheck,
  onOutcome,
  onNote,
}: {
  stop: Extract<Stop, { kind: "scenario" }>;
  progress?: ScenarioProgress;
  onCheck: (checkId: string) => void;
  onOutcome: (outcome: "pass" | "fail" | null) => void;
  onNote: (note: string) => void;
}) {
  const { scenario, track, nthInTrack } = stop;
  const outcome = progress?.outcome;
  const checks = progress?.checks ?? [];
  const [note, setNote] = useState(progress?.note ?? "");

  return (
    <Card className={cn(outcome === "pass" && "border-primary/40", outcome === "fail" && "border-destructive/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {nthInTrack}
          </span>
          {scenario.title}
          <span className="text-xs font-normal text-muted-foreground">~{scenario.minutes} min</span>
          {scenario.pair && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              <Users className="size-3" /> needs both of you
            </span>
          )}
          {outcome === "pass" && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary">
              <CircleCheck className="size-4" /> passed
            </span>
          )}
          {outcome === "fail" && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-destructive">
              <CircleX className="size-4" /> failed
            </span>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{scenario.why}</p>
        <p className="text-xs text-muted-foreground">{track.where}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {scenario.links && scenario.links.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Have open
            </span>
            {scenario.links.map((l) => (
              <LinkButton key={l.href} link={l} />
            ))}
          </div>
        )}

        {scenario.heads && (
          <Alert>
            <Info className="size-4" />
            <AlertDescription>{scenario.heads}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Do this</p>
          <ol className="space-y-2">
            {scenario.steps.map((step, i) => (
              <li key={i} className="space-y-1.5 text-sm">
                <span className="mr-1.5 font-semibold text-muted-foreground">{i + 1}.</span>
                {step.text}
                {step.link && (
                  <span className="ml-1.5 inline-flex align-middle">
                    <LinkButton link={step.link} />
                  </span>
                )}
                {step.copy && <CopyText text={step.copy} />}
                {step.image && (
                  <figure
                    className={cn(
                      "overflow-hidden rounded-lg border bg-muted/30",
                      // Portrait shots (the widget panel) would fill the screen at
                      // text width — keep them thumbnail-sized instead.
                      step.image.height > step.image.width ? "max-w-3xs" : "max-w-xl",
                    )}
                  >
                    <Image
                      src={step.image.src}
                      alt={step.image.alt}
                      width={step.image.width}
                      height={step.image.height}
                      className="h-auto w-full"
                      unoptimized={step.image.src.endsWith(".gif")}
                    />
                    {step.image.caption && (
                      <figcaption className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                        {step.image.caption}
                      </figcaption>
                    )}
                  </figure>
                )}
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            You should see — tick what you saw
          </p>
          {scenario.checks.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={checks.includes(c.id)}
                onCheckedChange={() => onCheck(c.id)}
              />
              <span>{c.text}</span>
            </label>
          ))}
        </div>

        <StepCard title="How Jetta does this" collapsible defaultOpen={false}>
          <div className="space-y-2 pt-1 text-sm">
            {scenario.how.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </StepCard>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            size="sm"
            variant={outcome === "pass" ? "default" : "outline"}
            onClick={() => onOutcome(outcome === "pass" ? null : "pass")}
          >
            <CircleCheck className="size-4" /> It all worked
          </Button>
          <Button
            size="sm"
            variant={outcome === "fail" ? "destructive" : "outline"}
            onClick={() => onOutcome(outcome === "fail" ? null : "fail")}
          >
            <CircleX className="size-4" /> Something was off
          </Button>
          {outcome === "fail" && (
            <span className="text-xs text-muted-foreground">
              Nice catch — one line below on what you saw, plus a screenshot to Suraj.
            </span>
          )}
        </div>
        {outcome === "fail" && (
          <Textarea
            placeholder="What did you see instead? One or two lines is plenty."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (progress?.note ?? "") && onNote(note)}
            rows={2}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Cleanup view ───────────────────────────────────────────────────

interface CleanupScanResult {
  tickets: { id: string; subject: string; status: string; url: string }[];
  chats: { id: string; visitor: string; status: string }[];
  monday: { id: string; name: string; url: string }[];
  notes: string[];
}
interface CleanupRunResult {
  tickets: { id: string; subject: string; ok: boolean }[];
  chats: { id: string; ok: boolean }[];
  monday: { id: string; name: string; ok: boolean; reason?: string }[];
  notes: string[];
}

function CleanupView({
  mine,
  done,
  total,
  onCheck,
  onTickAll,
}: {
  mine: PlaybookProgress;
  done: number;
  total: number;
  onCheck: (checkId: string) => void;
  onTickAll: (ids: string[]) => void;
}) {
  const ticked = mine["cleanup"]?.checks ?? [];
  return (
    <div className="space-y-4">
      {done === total && total > 0 && (
        <Alert>
          <PartyPopper className="size-4" />
          <AlertTitle>Every scenario has an outcome — you&apos;re done testing</AlertTitle>
          <AlertDescription>
            One last thing: the tests touched real systems on purpose. Run the auto-cleanup below,
            then tick off whatever it couldn&apos;t reach.
          </AlertDescription>
        </Alert>
      )}

      <AutoCleanup onTickAll={onTickAll} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">The checklist — leave no trace</CardTitle>
          <p className="text-sm text-muted-foreground">
            Auto-cleanup ticks the first three when it finds nothing left. The Slack one is always
            yours: only you know which thread your bug report escalated to.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {PLAYBOOK_CLEANUP.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={ticked.includes(c.id)}
                onCheckedChange={() => onCheck(c.id)}
              />
              <span>{c.text}</span>
            </label>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AutoCleanup({ onTickAll }: { onTickAll: (ids: string[]) => void }) {
  const [phase, setPhase] = useState<"idle" | "scanning" | "scanned" | "cleaning" | "done">("idle");
  const [scan, setScan] = useState<CleanupScanResult | null>(null);
  const [report, setReport] = useState<CleanupRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doScan = async () => {
    setPhase("scanning");
    setError(null);
    setReport(null);
    try {
      const res = await fetch("/api/playbook/cleanup");
      if (!res.ok) throw new Error(`scan failed (${res.status})`);
      setScan((await res.json()) as CleanupScanResult);
      setPhase("scanned");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const doClean = async () => {
    setPhase("cleaning");
    setError(null);
    try {
      const res = await fetch("/api/playbook/cleanup", { method: "POST" });
      if (!res.ok) throw new Error(`cleanup failed (${res.status})`);
      const r = (await res.json()) as CleanupRunResult;
      setReport(r);
      setPhase("done");
      // Tick only the boxes whose whole category actually came clean.
      const ids: string[] = [];
      if (r.tickets.every((t) => t.ok)) ids.push("cu-tickets");
      if (r.chats.every((c) => c.ok)) ids.push("cu-chats");
      if (r.monday.every((m) => m.ok)) ids.push("cu-monday");
      if (ids.length) onTickAll(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("scanned");
    }
  };

  const found = scan ? scan.tickets.length + scan.chats.length + scan.monday.length : 0;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" /> Auto-cleanup
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Scans for what the tests left behind — open [TEST] tickets, your demo chats, [TEST]
          dev-board items — shows you the list, and only cleans when you say so.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {(phase === "idle" || phase === "scanning") && (
          <Button onClick={doScan} disabled={phase === "scanning"}>
            {phase === "scanning" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
            {phase === "scanning" ? "Scanning…" : "Scan for leftovers"}
          </Button>
        )}

        {phase !== "idle" && phase !== "scanning" && scan && !report && (
          <>
            {found === 0 ? (
              <Alert>
                <CircleCheck className="size-4" />
                <AlertTitle>Nothing left behind</AlertTitle>
                <AlertDescription>
                  No open [TEST] tickets, no unresolved demo chats, no [TEST] board items. Run the
                  scan again after your last scenario if you keep testing.
                </AlertDescription>
              </Alert>
            ) : (
              <ScanList scan={scan} />
            )}
            {scan.notes.map((n, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                ⚠ {n}
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              {found > 0 && (
                <Button onClick={doClean} disabled={phase === "cleaning"}>
                  {phase === "cleaning" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {phase === "cleaning" ? "Cleaning up…" : `Clean up ${found} item${found === 1 ? "" : "s"}`}
                </Button>
              )}
              {found === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTickAll(["cu-tickets", "cu-chats", "cu-monday"])}
                >
                  <Check className="size-4" /> Tick the boxes for me
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={doScan} disabled={phase === "cleaning"}>
                <RotateCw className="size-3.5" /> Rescan
              </Button>
            </div>
          </>
        )}

        {phase === "done" && report && (
          <>
            <Alert>
              <CircleCheck className="size-4" />
              <AlertTitle>Cleanup done</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 space-y-0.5 text-sm">
                  <li>
                    {report.tickets.filter((t) => t.ok).length}/{report.tickets.length} [TEST]
                    tickets closed
                  </li>
                  <li>
                    {report.chats.filter((c) => c.ok).length}/{report.chats.length} test chats
                    resolved
                  </li>
                  <li>
                    {report.monday.filter((m) => m.ok).length}/{report.monday.length} [TEST] board
                    items deleted
                  </li>
                </ul>
              </AlertDescription>
            </Alert>
            {report.notes.map((n, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                ⚠ {n}
              </p>
            ))}
            <Button variant="ghost" size="sm" onClick={doScan}>
              <RotateCw className="size-3.5" /> Scan again
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScanList({ scan }: { scan: CleanupScanResult }) {
  return (
    <div className="space-y-2 text-sm">
      {scan.tickets.length > 0 && (
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Tickets to close
          </p>
          <ul className="mt-1 space-y-0.5">
            {scan.tickets.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <a
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium underline underline-offset-2"
                >
                  #{t.id} {t.subject}
                </a>
                <span className="shrink-0 text-xs text-muted-foreground">{t.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {scan.chats.length > 0 && (
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Chats to resolve
          </p>
          <ul className="mt-1 space-y-0.5">
            {scan.chats.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <Link href={`/chats/${c.id}`} target="_blank" className="truncate font-medium underline underline-offset-2">
                  {c.visitor}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {scan.monday.length > 0 && (
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Dev-board items to delete
          </p>
          <ul className="mt-1 space-y-0.5">
            {scan.monday.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <Circle className="size-2 shrink-0 fill-current text-muted-foreground/50" />
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-medium underline underline-offset-2"
                >
                  {m.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
