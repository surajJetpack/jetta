/** Everyone's per-scenario outcomes, for whoever runs the testing. */
"use client";

import { Circle, CircleCheck, CircleX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SectionHeader } from "@/components/jetta/page-header";
import { PLAYBOOK_CLEANUP, type PlaybookProgress } from "@/lib/test-playbook";
import { type Stop, STOPS, scenarioCode } from "./playbook-shared";

/**
 * Everyone's per-scenario outcomes side by side, failure notes included.
 * Admin-only since 2026-08-25 (and the server withholds teammates' detail
 * from general users regardless of what renders): testers see their own run;
 * whoever runs the team reads the room.
 */
export function TeamResults({
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
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Scenario</TableHead>
                  {users.map((name) => (
                    <TableHead key={name} className="text-center">
                      {name}
                      {name === user && <span className="font-normal text-muted-foreground"> (you)</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {scenarioStops.map((s) => (
                  <TableRow key={s.scenario.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => onGo(STOPS.indexOf(s))}
                        className="flex cursor-pointer items-baseline gap-2 rounded-sm text-left hover:underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <span className="w-6 shrink-0 text-xs font-semibold text-muted-foreground">
                          {scenarioCode(s.track, s.nthInTrack)}
                        </span>
                        <span className="truncate">{s.scenario.title}</span>
                      </button>
                    </TableCell>
                    {users.map((name) => {
                      const outcome = progressFor(name)[s.scenario.id]?.outcome;
                      return (
                        <TableCell key={name} className="text-center">
                          {outcome === "pass" ? (
                            <CircleCheck className="inline size-4 text-tone-good" aria-label="Passed" />
                          ) : outcome === "fail" ? (
                            <CircleX className="inline size-4 text-tone-bad" aria-label="Failed" />
                          ) : (
                            <Circle className="inline size-3 text-muted-foreground/30" aria-label="Not run" />
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
                <TableRow className="text-xs text-muted-foreground hover:bg-transparent">
                  <TableCell>Cleanup ticked</TableCell>
                  {users.map((name) => (
                    <TableCell key={name} className="text-center tabular-nums">
                      {(progressFor(name)["cleanup"]?.checks ?? []).length}/{PLAYBOOK_CLEANUP.length}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {failures.length > 0 && (
            <div className="space-y-1.5 border-t pt-3">
              <SectionHeader>What failed, in the tester&apos;s words</SectionHeader>
              {failures.map((f, i) => (
                <p key={i} className="text-sm">
                  <CircleX className="mr-1.5 inline size-4 align-[-3px] text-tone-bad" />
                  <b>{f.name}</b> ·{" "}
                  <button
                    type="button"
                    onClick={() => onGo(f.stopIndex)}
                    className="cursor-pointer rounded-sm font-medium hover:underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
