"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One-time "start with the Guide" pointer for new reviewers. Per-user flag in
 * localStorage — enough persistence for a four-person team; following the
 * link or dismissing both silence it.
 */
export function GuideBanner({ user }: { user: string }) {
  const [show, setShow] = useState(false);
  const pathname = usePathname();
  const key = `jetta:guide-seen:${user}`;

  useEffect(() => {
    // localStorage is client-only — decide visibility after mount to keep
    // server and first client render identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot reveal after reading client-only storage
    if (!pathname.startsWith("/guide") && !localStorage.getItem(key)) setShow(true);
  }, [pathname, key]);

  function dismiss() {
    localStorage.setItem(key, "1");
    setShow(false);
  }

  if (!show) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-2 text-sm dark:bg-primary/10">
      <span className="flex items-start gap-2">
        <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          New here? Start with the{" "}
          <Link href="/guide" onClick={dismiss} className="font-medium text-primary underline underline-offset-2">
            Guide
          </Link>{" "}
          <span className="text-muted-foreground">— 3 minutes on how Jetta works and what needs you.</span>
        </span>
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss} className="shrink-0 text-muted-foreground">
        <X />
      </Button>
    </div>
  );
}
