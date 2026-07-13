/** Relative timestamp with the exact time in a tooltip — the one date style. */
"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAgo, fmtExact, useNow } from "@/lib/format";

export function RelativeTime({ at, className }: { at: number; className?: string }) {
  const now = useNow();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className} suppressHydrationWarning>
          {fmtAgo(at, now)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{fmtExact(at)}</TooltipContent>
    </Tooltip>
  );
}
