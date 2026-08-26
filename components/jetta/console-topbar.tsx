import Link from "next/link";
import { Menu } from "lucide-react";
import { headlineState } from "@/lib/system-status";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Signal } from "./signal";
import { CommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { ViewAsSwitch } from "./view-as-switch";
import { LogoutButton } from "./logout-button";
import { MobileSidebar } from "./mobile-sidebar";

/**
 * The bar above every page: search, the state of the machine, and who you are.
 *
 * A server component so the status chips read config directly — they describe
 * the deployment, not the session, and there is nothing here worth a round
 * trip to discover.
 */
export function ConsoleTopbar({
  user,
  isAdmin,
  canViewAs,
  viewingAsGeneral,
  sidebarCollapsed,
}: {
  user: string;
  isAdmin: boolean;
  canViewAs: boolean;
  viewingAsGeneral: boolean;
  sidebarCollapsed: boolean;
}) {
  const headline = headlineState();

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-sm">
      <MobileSidebar isAdmin={isAdmin} defaultCollapsed={sidebarCollapsed} icon={<Menu />} />

      <CommandPalette isAdmin={isAdmin} freshdeskDomain={freshdeskDomain() ?? ""} />

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* Deployment-state chips are admin-only: they describe configuration
            only an admin can change, and their deep-link target (/system) is
            an admin page. General users would get an amber badge they can
            neither act on nor read more about. */}
        {isAdmin && (
          <div className="hidden items-center gap-1.5 md:flex">
            {headline.map((h) => (
              <Tooltip key={h.label}>
                <TooltipTrigger asChild>
                  {/* Deep-link to the card that explains it, not the top of the
                      page. An anchor also keeps the chip useful while already on
                      /system, where a link to /system did visibly nothing. */}
                  <Link
                    href={h.anchor ? `/system#${h.anchor}` : "/system"}
                    aria-label={`${h.label}: ${h.state} — open on System`}
                    className="rounded-full transition-opacity hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <Signal tone={h.tone}>{h.state}</Signal>
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{h.meaning}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}

        {user !== "dev" && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{user}</span>
        )}
        {canViewAs && <ViewAsSwitch viewingAsGeneral={viewingAsGeneral} />}
        <ThemeToggle />
        {user !== "dev" && <LogoutButton />}
      </div>
    </header>
  );
}
