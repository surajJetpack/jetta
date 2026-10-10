import Link from "next/link";
import { Menu } from "lucide-react";
import { headlineState } from "@/lib/system-status";
import { freshdeskDomain } from "@/lib/tools/freshdesk";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Signal } from "./signal";
import { CommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { ViewAsSwitch } from "./view-as-switch";
import { UserMenu } from "./user-menu";
import { Breadcrumbs } from "./breadcrumbs";
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
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-md sm:px-6">
      <MobileSidebar isAdmin={isAdmin} defaultCollapsed={sidebarCollapsed} icon={<Menu />} />

      <Breadcrumbs isAdmin={isAdmin} />

      <div className="flex min-w-0 flex-1 justify-center">
        <CommandPalette isAdmin={isAdmin} freshdeskDomain={freshdeskDomain() ?? ""} />
      </div>

      <div className="flex shrink-0 items-center gap-2">
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

        {/* Only the "back to admin" state lives in the bar; entering it is in the menu. */}
        {viewingAsGeneral && <ViewAsSwitch viewingAsGeneral />}
        {/* "dev" is the open local console with no account behind it — nothing
            to sign out of, so it keeps the bare theme switch. */}
        {user === "dev" ? (
          <ThemeToggle />
        ) : (
          <UserMenu user={user} isAdmin={isAdmin} canViewAs={canViewAs && !viewingAsGeneral} />
        )}
      </div>
    </header>
  );
}
