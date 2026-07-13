"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One-time "start with the Guide" pointer for new reviewers. Per-user flag in
 * localStorage — enough persistence for a four-person team; following the
 * link or dismissing both silence it.
 */
export function GuideBanner({ user, current }: { user: string; current: string }) {
  const [show, setShow] = useState(false);
  const key = `jetta:guide-seen:${user}`;

  useEffect(() => {
    // localStorage is client-only — decide visibility after mount to keep
    // server and first client render identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot reveal after reading client-only storage
    if (current !== "guide" && !localStorage.getItem(key)) setShow(true);
  }, [current, key]);

  function dismiss() {
    localStorage.setItem(key, "1");
    setShow(false);
  }

  if (!show) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-2 text-sm text-primary dark:bg-primary/10">
      <span>
        👋 New here? Start with the{" "}
        <Link href="/guide" onClick={dismiss} className="font-semibold underline underline-offset-2">
          Guide
        </Link>{" "}
        — 3 minutes, everything you need to review drafts.
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss} className="shrink-0 text-primary">
        <X />
      </Button>
    </div>
  );
}
