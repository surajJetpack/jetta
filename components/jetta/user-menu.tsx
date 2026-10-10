"use client";

/**
 * Who you are, in one place: the avatar menu at the right of the topbar.
 *
 * Name, role, "view as general", theme and sign-out used to sit in the bar as
 * five separate controls, which is what made it read as a debug strip. They
 * are account settings, and every product people already know keeps those
 * behind the avatar. The one exception stays outside: while viewing as a
 * general user, ViewAsSwitch renders its loud "back to admin" button in the
 * bar, because a downgrade you can't see is one you forget you're in.
 */
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Eye, LogOut, Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({
  user,
  isAdmin,
  canViewAs,
}: {
  user: string;
  isAdmin: boolean;
  /** Offer "view as general" — an admin who isn't already viewing as one. */
  canViewAs: boolean;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const initial = (user.trim()[0] ?? "?").toUpperCase();

  function viewAsGeneral() {
    document.cookie = `jetta_view_as=general; path=/; max-age=${8 * 3600}; samesite=lax`;
    router.refresh();
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/login");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${user}`}
        className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground ring-2 ring-background transition-opacity outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{user}</span>
          <span className="text-xs font-normal text-muted-foreground">{isAdmin ? "Admin" : "Team member"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canViewAs && (
          <DropdownMenuItem onSelect={viewAsGeneral}>
            <Eye /> View as general user
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sun className="dark:hidden" />
            <Moon className="hidden dark:block" /> Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <Sun /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
