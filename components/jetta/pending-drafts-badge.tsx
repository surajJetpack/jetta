"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { usePolling } from "@/lib/use-polling";

/**
 * Live pending-drafts count on the Drafts tab. Polls the cheap count endpoint
 * once a minute while the tab is visible; any non-200 (expired session, dev
 * without auth) simply hides the badge.
 */
export function PendingDraftsBadge({ active }: { active?: boolean }) {
  const [pending, setPending] = useState(0);

  usePolling(async () => {
    try {
      const r = await fetch("/api/admin/drafts?count=1", { cache: "no-store" });
      if (!r.ok) return setPending(0);
      const j = (await r.json()) as { pending?: number };
      setPending(j.pending ?? 0);
    } catch {
      setPending(0);
    }
  }, 60_000);

  if (!pending) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums",
        active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-primary text-primary-foreground",
      )}
    >
      {pending}
    </span>
  );
}
