"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConsoleSidebar } from "./console-sidebar";

/** Pages that need the width more than the labels: the rail starts collapsed there. */
const NARROW_RAIL = new Set(["/chats"]);

/**
 * The desktop sidebar and its collapsed state.
 *
 * The saved preference comes from the `jetta_sidebar` cookie, read by the
 * layout on the server so the first paint is already the right width. Toggling
 * flips it here and rewrites the cookie for next time; it used to write the
 * cookie and reload the whole page to let the server re-read it.
 *
 * The chat inbox is three panes wide, so the rail collapses there whatever
 * the saved preference says. Expanding it on that page is a choice for this
 * visit only and leaves the preference alone, so the rest of the console
 * keeps the width you chose for it. usePathname is available during the
 * server render of a client component, so this too is right on first paint.
 */
export function SidebarRail({ isAdmin, savedCollapsed }: { isAdmin: boolean; savedCollapsed: boolean }) {
  const pathname = usePathname();
  const [saved, setSaved] = useState(savedCollapsed);
  const [narrowOverride, setNarrowOverride] = useState<boolean | null>(null);

  const narrowPage = NARROW_RAIL.has(pathname);
  const collapsed = narrowPage ? (narrowOverride ?? true) : saved;

  function toggle() {
    if (narrowPage) {
      setNarrowOverride(!collapsed);
      return;
    }
    const next = !saved;
    setSaved(next);
    // A year, because this is a workstation preference and re-choosing it every
    // session is the kind of small friction people stop noticing and start
    // resenting. Lax so it survives following a link in from Slack.
    document.cookie = `jetta_sidebar=${next ? "collapsed" : "open"};path=/;max-age=31536000;samesite=lax`;
  }

  return (
    <aside
      data-surface="sidebar"
      className={cn(
        "sticky top-0 hidden h-svh shrink-0 border-r transition-[width] duration-200 motion-reduce:transition-none md:block",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <ConsoleSidebar isAdmin={isAdmin} collapsed={collapsed} onToggle={toggle} />
    </aside>
  );
}
