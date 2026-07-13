/**
 * Lifecycle / tag chips — the console's shared chip vocabulary, replacing the
 * legacy `.state` classes. One dark-safe color map for every chip in the app.
 * `asButton` renders a pressable chip (aria-pressed) for tag pickers and
 * event-log filters.
 */
import { cn } from "@/lib/utils";

export type ChipTone =
  | "draft" // amber — pending-ish
  | "in_review" // blue
  | "published" // green — positive
  | "archived" // slate
  | "stale"; // red — negative / destructive-ish

const TONES: Record<ChipTone, string> = {
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400",
  in_review: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-400",
  published: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400",
  archived: "bg-muted text-muted-foreground",
  stale: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-400",
};

const BASE =
  "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap";

export function StatusChip({
  tone = "archived",
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: React.ReactNode;
}) {
  return <span className={cn(BASE, TONES[tone], className)}>{children}</span>;
}

export function ChipButton({
  tone = "archived",
  pressed,
  onPressedChange,
  disabled,
  className,
  children,
}: {
  tone?: ChipTone;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        BASE,
        "cursor-pointer border transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        pressed ? [TONES[tone], "border-primary"] : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
        className,
      )}
    >
      {children}
    </button>
  );
}
