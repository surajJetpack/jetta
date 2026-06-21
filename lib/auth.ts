import { NextRequest } from "next/server";
import { config } from "./config";

/**
 * Admin gate for the ops console + /api/admin/*. Accepts the secret via the
 * `x-admin-secret` header or a `?key=` query param. If ADMIN_SECRET is unset
 * (local dev), access is allowed.
 */
export function adminAuthorized(req: NextRequest): boolean {
  if (!config.adminSecret) return true;
  const header = req.headers.get("x-admin-secret");
  const key = req.nextUrl.searchParams.get("key");
  return header === config.adminSecret || key === config.adminSecret;
}
