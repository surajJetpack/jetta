/** The wizard's first stop: rules, what you'll test, and the team's results. */
"use client";

import { ArrowRight, Info, ListChecks, Sparkles, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SectionHeader } from "@/components/jetta/page-header";
import { CHIP_BASE } from "@/components/jetta/tone";
import { cn } from "@/lib/utils";
import { PLAYBOOK, PLAYBOOK_CLEANUP, PLAYBOOK_RULES, type PlaybookProgress } from "@/lib/test-playbook";
import { STOPS, outcomeIcon } from "./playbook-shared";
import { TeamResults } from "./team-results";

/** First page of the wizard: the rules, what you'll be testing, and how the team is doing. */
export function IntroView({
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
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {outcomeIcon(mine[s.id])}
                      <span className="w-4 shrink-0 text-xs font-semibold text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                      {s.pair && (
                        <span className={cn(CHIP_BASE, "border font-medium tracking-normal text-muted-foreground")}>
                          <Users className="size-3" /> Both of you
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">~{s.minutes} min</span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />
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
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ListChecks className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                The tests touched real systems on purpose — this puts them back. Jetta can now do
                most of it for you.
              </span>
              <span className={cn(CHIP_BASE, "border font-medium tracking-normal text-primary")}>
                <Sparkles className="size-3" /> Auto-cleanup
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />
            </button>
          </CardContent>
        </Card>
      </section>

      {isAdmin && <TeamResults user={user} mine={mine} team={team} onGo={onGo} />}
    </div>
  );
}
