"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GUIDE_ITEM, activeId, navFor, type NavItem } from "./console-nav";
import { useAttention, type Attention } from "./use-attention";
import { TONE_SOLID } from "./tone";

/**
 * The console's spine.
 *
 * Collapsed state arrives as a prop read from a cookie on the server, so the
 * sidebar renders at its final width on the first paint — deciding it on the
 * client would flash a wide rail on every navigation.
 *
 * Only ever ONE poll behind all the badges (see useAttention), where the old
 * tab bar ran a separate one per badge.
 */
export function ConsoleSidebar({
  isAdmin,
  defaultCollapsed,
  onNavigate,
}: {
  isAdmin: boolean;
  defaultCollapsed: boolean;
  /** Set by the mobile sheet so tapping a link closes it. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const attention = useAttention();
  const active = activeId(pathname, isAdmin);
  const groups = navFor(isAdmin);

  function toggle() {
    const next = !defaultCollapsed;
    // A year, because this is a workstation preference and re-choosing it every
    // session is the kind of small friction people stop noticing and start
    // resenting. Lax so it survives following a link in from Slack.
    document.cookie = `jetta_sidebar=${next ? "collapsed" : "open"};path=/;max-age=31536000;samesite=lax`;
    // The layout reads the cookie on the server, so a reload is what applies it.
    window.location.reload();
  }

  const collapsed = defaultCollapsed && !onNavigate;

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-2 py-3">
      <div className={cn("mb-2 flex items-center gap-2 px-1", collapsed && "justify-center")}>
        <Image
          src="/jetta.png"
          alt=""
          width={28}
          height={28}
          className="size-7 shrink-0 rounded-full ring-1 ring-border"
        />
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">Jetta</span>
        )}
        {!onNavigate && (
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        )}
      </div>

      {groups.map((g) => (
        <div key={g.label} className="mb-1">
          {/* A single-group sidebar (what a general user sees) needs no group
              headings — they would be labelling the whole thing. */}
          {!collapsed && groups.length > 1 && (
            <p className="mb-1 px-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {g.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.id}>
                <SidebarLink
                  item={item}
                  active={active === item.id}
                  collapsed={collapsed}
                  attention={attention}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="mt-auto border-t pt-2">
        <SidebarLink
          item={GUIDE_ITEM}
          active={active === GUIDE_ITEM.id}
          collapsed={collapsed}
          attention={attention}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  attention,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  attention: Attention;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const count = badgeCount(item, attention);
  const urgent = item.badge === "chats" && attention.chatsWaiting > 0;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        collapsed && "justify-center px-0",
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="relative shrink-0">
        <Icon className={cn("size-4", active && "text-primary")} aria-hidden />
        {/* Collapsed, there is no room for a count — but "something is waiting"
            still has to survive, so it degrades to a dot on the icon. */}
        {collapsed && count > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
              urgent ? "bg-tone-bad" : "bg-muted-foreground",
            )}
            aria-hidden
          />
        )}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {count > 0 && (
            <span
              className={cn(
                "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                urgent ? cn("animate-pulse", TONE_SOLID.bad) : TONE_SOLID.neutral,
              )}
            >
              {count}
            </span>
          )}
        </>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function badgeCount(item: NavItem, a: Attention): number {
  if (item.badge === "chats") return a.chatsWaiting || a.chatsLive;
  if (item.badge === "billing") return a.billingPending;
  return 0;
}
