/**
 * The four-state status chip, and the row list built on it.
 *
 * `LiveBadge` answers "is this switched on", which is the wrong question for
 * anything with a write gate behind it: an integration can be fully live and
 * still unable to change anything, and one that is switched on with no
 * credentials behind it looks identical to a working one. So this carries four
 * tones instead of two — see `SignalTone` in lib/system-status.ts — and every
 * row states what it means in practice rather than leaving the reader to infer
 * it from a colour.
 */
import { cn } from "@/lib/utils";
import type { SignalTone, StatusRow } from "@/lib/system-status";
import { CHIP_BASE, TONE_SOFT, type Tone } from "./tone";

/** System states are the domain; the colour comes from the shared tones. */
const TONES: Record<SignalTone, Tone> = {
  on: "info", // active, and things happen in the outside world
  good: "good", // a protective gate is engaged
  off: "neutral", // inactive or simulated; nothing escapes
  warn: "warn", // on but unable to work, or working with no human check
};

export function Signal({
  tone,
  children,
  className,
}: {
  tone: SignalTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(CHIP_BASE, "font-mono uppercase", TONE_SOFT[TONES[tone]], className)}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

/** A block of status rows — label, state, what it means, and what to change. */
export function StatusRows({ rows }: { rows: StatusRow[] }) {
  return (
    <div className="divide-y">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm font-semibold">{r.label}</span>
            <Signal tone={r.tone}>{r.state}</Signal>
          </div>
          <p className="text-xs text-muted-foreground">{r.meaning}</p>
          {r.setting && (
            <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {r.setting}
            </code>
          )}
        </div>
      ))}
    </div>
  );
}
