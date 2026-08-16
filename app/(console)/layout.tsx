import { cookies } from "next/headers";
import { gate } from "@/lib/console-auth";
import { cn } from "@/lib/utils";
import { ConsoleSidebar } from "@/components/jetta/console-sidebar";
import { ConsoleTopbar } from "@/components/jetta/console-topbar";
import { GuideBanner } from "@/components/jetta/guide-banner";

export const dynamic = "force-dynamic";

/**
 * The console shell — sidebar, topbar, and the chrome every page inside the
 * group shares.
 *
 * The route group exists so this wraps the console and nothing else. /chat is
 * a customer-facing widget embedded on other people's sites and /login is what
 * you see when you have no session; neither should ever grow a navigation
 * sidebar, and a group makes that structural rather than a condition someone
 * has to remember.
 *
 * Auth here decides whether to draw CHROME, and nothing more. Layouts do not
 * re-run on every navigation, so this is the wrong place to enforce anything —
 * the API routes are the boundary (see lib/roles.ts) and each page still calls
 * gate() itself. It deliberately does not redirect either: the pages do, and
 * they know which `next` to carry, which a layout with no access to the
 * pathname does not. Rendering the bare children when locked means a page that
 * ever forgot to gate would leak its own content, never the navigation.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { locked, user, isAdmin, viewingAsGeneral } = await gate();
  if (locked) return <>{children}</>;

  const collapsed = (await cookies()).get("jetta_sidebar")?.value === "collapsed";

  return (
    <div className="flex min-h-svh">
      <aside
        className={cn(
          "sticky top-0 hidden h-svh shrink-0 border-r bg-sidebar md:block",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <ConsoleSidebar isAdmin={isAdmin} defaultCollapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <ConsoleTopbar
          user={user}
          isAdmin={isAdmin}
          canViewAs={isAdmin || viewingAsGeneral}
          viewingAsGeneral={viewingAsGeneral}
          sidebarCollapsed={collapsed}
        />

        {viewingAsGeneral && (
          <p className="border-b bg-tone-warn-bg px-4 py-2 text-xs text-tone-warn">
            You are viewing the console as a <b>general user</b>. Admin actions are hidden and will
            be refused, exactly as they are for your colleagues.
          </p>
        )}

        <main className="min-w-0 flex-1 px-4 pt-5 pb-16 sm:px-6">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
            <GuideBanner user={user} />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
