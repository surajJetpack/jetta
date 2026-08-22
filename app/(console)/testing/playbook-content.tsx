/**
 * The interactive half of /testing.
 *
 * Everything a tester ticks is saved immediately under their own login (the
 * API takes the username from the session, so nobody can tick for a teammate)
 * and optimistically in the UI — running scenarios in a coffee break must
 * never feel like filling in a form. Failure notes are the one text field,
 * and only appear once a scenario is marked failed.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Check,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Info,
  PartyPopper,
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
  type PlaybookProgress,
  type PlaybookScenario,
  type ScenarioProgress,
} from "@/lib/test-playbook";

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

export default function PlaybookContent({
  user,
  initialMine,
  others,
}: {
  user: string;
  initialMine: PlaybookProgress;
  others: { name: string; done: number }[];
}) {
  const [mine, setMine] = useState<PlaybookProgress>(initialMine);
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
          <p className="text-xs text-muted-foreground">
            Everything you tick is saved under your login as you go — stop anytime, pick up later,
            swap tracks with your teammate for a second pass.
          </p>
        </CardContent>
      </Card>

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
            <p className="max-w-prose text-sm">
              {track.where}{" "}
              {track.id === "chat" && (
                <Link
                  href="/chat-demo"
                  target="_blank"
                  className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2"
                >
                  Open the demo page <ExternalLink className="size-3" />
                </Link>
              )}
            </p>
            {trackDone === track.scenarios.length && (
              <Alert>
                <PartyPopper className="size-4" />
                <AlertTitle>Track complete</AlertTitle>
                <AlertDescription>
                  Every scenario has an outcome. Don&apos;t forget the cleanup list at the bottom.
                </AlertDescription>
              </Alert>
            )}
            {track.scenarios.map((s, i) => (
              <Scenario
                key={s.id}
                index={i + 1}
                scenario={s}
                progress={mine[s.id]}
                onCheck={(c) => toggleCheck(s.id, c)}
                onOutcome={(o) => save(s.id, { outcome: o })}
                onNote={(note) => save(s.id, { note })}
              />
            ))}
          </section>
        );
      })}

      {/* Cleanup */}
      <section className="space-y-3">
        <SectionHeader meta={`${(mine["cleanup"]?.checks ?? []).length}/${PLAYBOOK_CLEANUP.length}`}>
          Cleanup — leave no trace
        </SectionHeader>
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="text-sm text-muted-foreground">
              The tests touched real systems on purpose. This puts them back the way you found them.
            </p>
            {PLAYBOOK_CLEANUP.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={(mine["cleanup"]?.checks ?? []).includes(c.id)}
                  onCheckedChange={() => toggleCheck("cleanup", c.id)}
                />
                <span>{c.text}</span>
              </label>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Scenario({
  index,
  scenario,
  progress,
  onCheck,
  onOutcome,
  onNote,
}: {
  index: number;
  scenario: PlaybookScenario;
  progress?: ScenarioProgress;
  onCheck: (checkId: string) => void;
  onOutcome: (outcome: "pass" | "fail" | null) => void;
  onNote: (note: string) => void;
}) {
  const outcome = progress?.outcome;
  const checks = progress?.checks ?? [];
  const [note, setNote] = useState(progress?.note ?? "");

  return (
    <Card className={cn(outcome === "pass" && "border-primary/40", outcome === "fail" && "border-destructive/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {index}
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
      </CardHeader>
      <CardContent className="space-y-3">
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
                {step.copy && <CopyText text={step.copy} />}
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
