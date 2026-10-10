/** Building blocks the playbook's views share: the stop list, small controls and labels. */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Circle, CircleCheck, CircleX, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLAYBOOK, type PlaybookLink, type PlaybookScenario, type PlaybookTrack, type ScenarioProgress } from "@/lib/test-playbook";

/**
 * One screen of the wizard: the intro (rules, what you'll test, team results),
 * a scenario, or the final cleanup stop. The overview outside the wizard is
 * deliberately just a scoreboard and a Start button — everything else lives
 * inside the flow so there is exactly one thing to click.
 */
export type Stop =
  | { kind: "intro" }
  | { kind: "scenario"; track: PlaybookTrack; scenario: PlaybookScenario; nthInTrack: number }
  | { kind: "cleanup" };

export const STOPS: Stop[] = [
  { kind: "intro" },
  ...PLAYBOOK.flatMap((track) =>
    track.scenarios.map((scenario, i): Stop => ({ kind: "scenario", track, scenario, nthInTrack: i + 1 })),
  ),
  { kind: "cleanup" },
];

/** Copy-to-clipboard block for the exact texts a tester sends. */
export function CopyText({ text }: { text: string }) {
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

export function ProgressBar({ done, total }: { done: number; total: number }) {
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
export function LinkButton({ link }: { link: PlaybookLink }) {
  const external = link.href.startsWith("http");
  return (
    <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
      <Link href={link.href} target="_blank" rel={external ? "noreferrer" : undefined}>
        {link.label} <ExternalLink className="size-3" />
      </Link>
    </Button>
  );
}

export function outcomeIcon(progress?: ScenarioProgress) {
  if (progress?.outcome === "pass") return <CircleCheck className="size-4 shrink-0 text-tone-good" aria-label="Passed" />;
  if (progress?.outcome === "fail") return <CircleX className="size-4 shrink-0 text-tone-bad" aria-label="Failed" />;
  return <Circle className="size-4 shrink-0 text-muted-foreground/40" />;
}

/** Short label a teammate would say out loud: "A3", "B1". */
export function scenarioCode(track: PlaybookTrack, nth: number): string {
  return `${track.id === "chat" ? "A" : "B"}${nth}`;
}
