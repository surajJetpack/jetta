/** One scenario of the walk: steps, what to expect, and the pass/fail outcome. */
"use client";

import { useState } from "react";
import Image from "next/image";
import { CircleCheck, CircleX, Info, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StepCard } from "@/components/jetta/step-card";
import { SectionHeader } from "@/components/jetta/page-header";
import { CHIP_BASE } from "@/components/jetta/tone";
import { cn } from "@/lib/utils";
import { type ScenarioProgress } from "@/lib/test-playbook";
import { type Stop, CopyText, LinkButton } from "./playbook-shared";

export function ScenarioView({
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
    <Card className={cn(outcome === "pass" && "border-tone-good/40", outcome === "fail" && "border-tone-bad/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {nthInTrack}
          </span>
          {scenario.title}
          <span className="text-xs font-normal text-muted-foreground">~{scenario.minutes} min</span>
          {scenario.pair && (
            <span className={cn(CHIP_BASE, "border font-medium tracking-normal text-muted-foreground")}>
              <Users className="size-3" /> Needs both of you
            </span>
          )}
          {outcome === "pass" && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-tone-good">
              <CircleCheck className="size-4" /> Passed
            </span>
          )}
          {outcome === "fail" && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-tone-bad">
              <CircleX className="size-4" /> Failed
            </span>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{scenario.why}</p>
        <p className="text-xs text-muted-foreground">{track.where}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {scenario.links && scenario.links.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <SectionHeader>Have open</SectionHeader>
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
          <SectionHeader>Do this</SectionHeader>
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
          <SectionHeader>You should see — tick what you saw</SectionHeader>
          {scenario.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2">
              <Checkbox
                id={`check-${c.id}`}
                className="mt-0.5"
                checked={checks.includes(c.id)}
                onCheckedChange={() => onCheck(c.id)}
              />
              <Label htmlFor={`check-${c.id}`} className="cursor-pointer leading-snug font-normal">
                {c.text}
              </Label>
            </div>
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
