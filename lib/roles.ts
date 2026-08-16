/**
 * Console roles.
 *
 * Two of them, and the line between is not seniority — it is blast radius.
 * A general user can do the whole support job and touch anything reversible:
 * answer a live chat, draft an article, read every transcript. Admin owns the
 * things that change EVERY FUTURE REPLY (approving a learning, publishing an
 * article), SPEND MONEY (trials, discounts), or decide WHO MAY EMBED the chat.
 *
 * Enforced in the API routes. The UI hides what a general user cannot do, but
 * hiding a button is not a permission — anyone can call the endpoint directly,
 * so the endpoint is where the answer has to live.
 *
 * The NAV is narrower than these permissions, and deliberately so. A general
 * user is shown three tabs (Today, Chats, Guide — see GENERAL_TABS in
 * app/nav.tsx) because that is the shape of their day, not because the other
 * pages are forbidden to them: follow a direct link to /kb and it still loads,
 * and drafting an article there still works. Read the tab list as an opinion
 * about what is worth their attention, and this file as the answer to what
 * they are allowed to do. If the two are ever meant to agree, the change
 * belongs here and in the routes — not in the nav.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { config } from "./config";
import { adminActor } from "./auth";

export type Role = "admin" | "general";

/**
 * Two callers are always admin, both deliberately:
 *   "dev"  — nobody is configured at all, so this is local development.
 *   "api"  — authenticated with ADMIN_SECRET, which is a server-side
 *            credential held by crons and scripts, not a person's login.
 */
export function roleOf(username: string | null | undefined): Role {
  if (!username) return "general";
  if (username === "dev" || username === "api") return "admin";
  // No admins configured: the first deployment shouldn't lock everyone out of
  // their own console, so everyone is admin until someone says otherwise.
  if (!config.consoleAdmins.length) return "admin";
  return config.consoleAdmins.includes(username) ? "admin" : "general";
}

export function isAdmin(username: string | null | undefined): boolean {
  return roleOf(username) === "admin";
}

/**
 * "View as general" — an admin checking what their colleagues actually see.
 *
 * A real downgrade, not a UI trick: the API honours it too, so a preview that
 * hides a button also refuses the request behind it. A preview where the
 * buttons vanish but the endpoints still work would teach an admin the wrong
 * thing about their own permissions model.
 *
 * It can only ever REDUCE privilege, so the cookie is not a credential and a
 * general user setting it by hand achieves nothing. The console shows a loud
 * banner while it is on, because an admin who forgets will read their own
 * restrictions as a bug.
 */
export const VIEW_AS_COOKIE = "jetta_view_as";

export function effectiveRole(username: string | null | undefined, viewAs?: string | null): Role {
  const actual = roleOf(username);
  return actual === "admin" && viewAs === "general" ? "general" : actual;
}

/**
 * Gate an API route. Returns a response to send back, or null to continue.
 * 403 rather than 404: the caller is a known colleague, and pretending the
 * route does not exist would send them hunting for a bug instead of asking
 * for access.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  const actor = adminActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const viewAs = req.cookies.get(VIEW_AS_COOKIE)?.value;
  if (effectiveRole(actor, viewAs) !== "admin") {
    if (viewAs === "general" && isAdmin(actor)) {
      return NextResponse.json(
        {
          error: "viewing_as_general",
          message: "You're previewing the console as a general user. Switch back to admin to do this.",
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "admin_only", message: "This needs an admin account. Ask Suraj." },
      { status: 403 },
    );
  }
  return null;
}
