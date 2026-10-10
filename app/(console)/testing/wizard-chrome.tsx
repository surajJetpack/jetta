/** The wizard's header (position, progress) and footer (prev/next). */
"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type PlaybookProgress } from "@/lib/test-playbook";
import { type Stop, STOPS } from "./playbook-shared";

export function WizardHeader({
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
          <ArrowLeft /> Overview
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
                "h-1.5 flex-1 cursor-pointer rounded-full transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                progress?.outcome === "pass" && "bg-tone-good",
                progress?.outcome === "fail" && "bg-tone-bad",
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

export function WizardFooter({
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
