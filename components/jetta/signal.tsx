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

const TONES: Record<SignalTone, string> = {
  // Active, and things happen in the outside world.
  on: "bg-primary/10 text-primary dark:bg-primary/15",
  // A protective gate is engaged.
  good: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400",
  // Inactive or simulated; nothing escapes.
  off: "bg-muted text-muted-foreground",
  // On but unable to work, or working with no human check. Look at this one.
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400",
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
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 font-mono text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase",
        TONES[tone],
        className,
      )}
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
