import { NextRequest } from "next/server";
import { config } from "./config";
import { isDeployed } from "./request-auth";
import { verifySession, safeEqual, SESSION_COOKIE } from "./console-auth";

/**
 * Identify the caller of an /api/admin/* route:
 *  - a signed-in console user (session cookie) → their username
 *  - a programmatic caller with the x-admin-secret header → "api"
 *  - full dev-open mode (no CONSOLE_USERS and no ADMIN_SECRET), on a
 *    developer's machine only → "dev". On a deployment that combination is a
 *    misconfiguration, and it used to make every visitor an admin: a preview
 *    environment missing two variables was an open console onto live data.
 *  - anyone else → null (unauthorized)
 *
 * The old `?key=` query support is gone — the console uses login sessions.
 */
export function adminActor(req: NextRequest): string | null {
  if (!config.consoleUsers && !config.adminSecret) return isDeployed() ? null : "dev";
  const user = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) return user;
  const header = req.headers.get("x-admin-secret");
  if (header && config.adminSecret && safeEqual(header, config.adminSecret)) return "api";
  return null;
}

/** Admin gate for /api/admin/* — session cookie or x-admin-secret header. */
export function adminAuthorized(req: NextRequest): boolean {
  return adminActor(req) !== null;
}
