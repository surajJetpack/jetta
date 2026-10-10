/** The /testing landing view: the scoreboard and the Start button. */
"use client";

import { CircleCheck, Play, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type PlaybookProgress } from "@/lib/test-playbook";
import { STOPS, ProgressBar } from "./playbook-shared";

export function Overview({
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
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              <b>{user}</b> — {done} of {total} scenarios done
              {done === total && total > 0 && (
                <span className="ml-2 inline-flex items-center gap-1 font-medium text-tone-good">
                  <CircleCheck className="size-4" /> Complete
                </span>
              )}
            </p>
            {others.length > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-4" />
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
