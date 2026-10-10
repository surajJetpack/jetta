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
import { totalScenarios, type PlaybookProgress, type ScenarioProgress } from "@/lib/test-playbook";
import { CleanupView } from "./cleanup-view";
import { IntroView } from "./intro-view";
import { Overview } from "./overview";
import { STOPS } from "./playbook-shared";
import { ScenarioView } from "./scenario-view";
import { WizardHeader, WizardFooter } from "./wizard-chrome";

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
