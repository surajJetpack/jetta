"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        background: "#eef2ff",
        color: "var(--accent)",
        border: "1px solid #c7d2fe",
        borderRadius: "var(--radius)",
        padding: "8px 14px",
        margin: "12px 0 4px",
        fontSize: 14,
      }}
    >
      <span>
        👋 New here? Start with the{" "}
        <Link href="/guide" onClick={dismiss} style={{ fontWeight: 600 }}>
          Guide
        </Link>{" "}
        — 3 minutes, everything you need to review drafts.
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 16, padding: 2 }}
      >
        ×
      </button>
    </div>
  );
}
