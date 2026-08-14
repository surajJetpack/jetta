"use client";

import { useState } from "react";
import { usePolling } from "@/lib/use-polling";
import { cn } from "@/lib/utils";

/**
 * How many visitors are waiting for a person, on the Chats tab.
 *
 * The Slack ping is the primary alert, but someone already in the console has
 * no way to see a waiting visitor without opening the tab — and a live chat is
 * the one queue where a few minutes of not noticing loses the customer. Polls
 * often for the same reason.
 */
export function ChatWaitingBadge({ active }: { active?: boolean }) {
  const [{ waiting, live }, setCounts] = useState({ waiting: 0, live: 0 });

  // 20s, not the 60s the other badges use: a waiting visitor is watching a
  // blank chat window, and a minute of that is most of their patience.
  usePolling(async () => {
    try {
      const r = await fetch("/api/admin/chats?waiting=1", { cache: "no-store" });
      if (!r.ok) return setCounts({ waiting: 0, live: 0 });
      const j = (await r.json()) as { waiting?: number; live?: number };
      setCounts({ waiting: j.waiting ?? 0, live: j.live ?? 0 });
    } catch {
      setCounts({ waiting: 0, live: 0 });
    }
  }, 20_000);
  if (!waiting && !live) return null;

  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
        // Waiting is urgent and red; a chat a colleague is already handling is
        // information, not a summons.
        waiting > 0
          ? "animate-pulse bg-red-500 text-white"
          : active
            ? "bg-primary-foreground/20 text-primary-foreground"
            : "bg-muted-foreground/20 text-muted-foreground",
      )}
      title={
        waiting > 0
          ? `${waiting} visitor${waiting === 1 ? "" : "s"} waiting for a person`
          : `${live} chat${live === 1 ? "" : "s"} being handled by a person`
      }
    >
      {waiting || live}
    </span>
  );
}
