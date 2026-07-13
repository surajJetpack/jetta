/** LIVE / STUB integration badge with the status dot (legacy `.badge`). */
import { cn } from "@/lib/utils";

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
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-wide",
        live
          ? "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400"
          : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label ?? (live ? "LIVE" : "STUB")}
    </span>
  );
}
