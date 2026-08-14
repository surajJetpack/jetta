import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import LogoutButton from "./logout-button";
import { GuideBanner } from "./guide-banner";
import { ThemeToggle } from "@/components/jetta/theme-toggle";
import { PendingMonetBadge } from "@/components/jetta/pending-monet-badge";
import { ChatWaitingBadge } from "@/components/jetta/chat-waiting-badge";

/**
 * Drafts is deliberately absent. Agents read Jetta's suggestion as a Freshdesk
 * private note and reply in their own words — 1 of 242 drafts was ever decided
 * in the console — and the learning now comes from mining what they actually
 * sent (/evals → "Learn from human replies"). The page still exists at /drafts
 * as an archive, and the private note still links to it.
 */
/** Tabs whose whole purpose is an admin-only action. Hidden, not disabled. */
const ADMIN_ONLY_TABS = new Set(["billing"]);

const TABS = [
  { href: "/today", label: "Today", id: "today" },
  { href: "/", label: "Console", id: "console" },
  { href: "/chats", label: "Chats", id: "chats" },
  { href: "/evals", label: "Evals", id: "evals" },
  { href: "/kb", label: "Knowledge Base", id: "kb" },
  { href: "/analytics", label: "Insights", id: "insights" },
  { href: "/billing", label: "Billing", id: "billing" },
  { href: "/guide", label: "Guide", id: "guide" },
];

/** Shared header + tab bar. Auth rides the session cookie — no key in links. */
export function Nav({
  current,
  user,
  isAdmin = true,
}: {
  current: string;
  user: string;
  /** Defaults to admin so a page that forgets to pass it fails visible, not silent. */
  isAdmin?: boolean;
}) {
  const tabs = TABS.filter((t) => isAdmin || !ADMIN_ONLY_TABS.has(t.id));
  return (
    <>
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <Image
            src="/jetta.png"
            alt="Jetta"
            width={48}
            height={48}
            className="size-12 shrink-0 rounded-full ring-2 ring-primary/20"
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
              Jetta — Ops Console
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              Autonomous support agent for Jetpack Apps &amp; GetSign · internal
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {user !== "dev" && <span className="hidden text-xs text-muted-foreground sm:inline">{user}</span>}
          <ThemeToggle />
          {user !== "dev" && <LogoutButton />}
        </div>
      </header>

      <nav className="-mx-5 overflow-x-auto px-5 pb-0.5 [scrollbar-width:none]" aria-label="Sections">
        <div className="inline-flex gap-1 rounded-lg border bg-card p-1 shadow-sm">
          {tabs.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              aria-current={t.id === current ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                t.id === current
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
              {t.id === "chats" && <ChatWaitingBadge active={t.id === current} />}
              {t.id === "billing" && <PendingMonetBadge active={t.id === current} />}
            </Link>
          ))}
        </div>
      </nav>

      <GuideBanner user={user} current={current} />
    </>
  );
}
