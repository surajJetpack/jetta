/**
 * Lifecycle / tag chips — the console's shared chip vocabulary, replacing the
 * legacy `.state` classes. One dark-safe color map for every chip in the app.
 * `asButton` renders a pressable chip (aria-pressed) for tag pickers and
 * event-log filters.
 */
import { cn } from "@/lib/utils";
import { CHIP_BASE, TONE_SOFT, type Tone } from "./tone";

export type ChipTone =
  | "draft" // pending-ish
  | "in_review"
  | "published" // positive
  | "archived" // no signal
  | "stale"; // negative

/** Lifecycle names are the domain; the colour comes from the shared tones. */
const TONES: Record<ChipTone, Tone> = {
  draft: "warn",
  in_review: "info",
  published: "good",
  archived: "neutral",
  stale: "bad",
};

const BASE = cn(CHIP_BASE, "uppercase");

export function StatusChip({
  tone = "archived",
  className,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: React.ReactNode;
}) {
  return <span className={cn(BASE, TONE_SOFT[TONES[tone]], className)}>{children}</span>;
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
        pressed ? [TONE_SOFT[TONES[tone]], "border-primary"] : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
        className,
      )}
    >
      {children}
    </button>
  );
}
