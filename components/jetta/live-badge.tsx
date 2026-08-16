/** LIVE / STUB integration badge with the status dot. */
import { cn } from "@/lib/utils";
import { CHIP_BASE, TONE_SOFT } from "./tone";

export function LiveBadge({
  live,
  label,
  className,
}: {
  live: boolean;
  /** Defaults to LIVE / STUB. */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn(CHIP_BASE, TONE_SOFT[live ? "good" : "warn"], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label ?? (live ? "LIVE" : "STUB")}
    </span>
  );
}
