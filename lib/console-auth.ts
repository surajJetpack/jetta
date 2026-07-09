/**
 * Console session auth: username/password logins from CONSOLE_USERS, an
 * HMAC-signed session cookie (no external deps), and the page gate.
 *
 * Dev-open rule: with CONSOLE_USERS unset the console is open (user "dev"),
 * mirroring the old unset-ADMIN_SECRET behavior so local dev stays frictionless.
 */
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { config } from "./config";

export const SESSION_COOKIE = "jetta_session";
export const SESSION_TTL_S = 7 * 24 * 3600;

/**
 * Parse CONSOLE_USERS ("user:pass,user:pass"). Each entry splits on the FIRST
 * colon only, so passwords may contain colons. Malformed entries are skipped.
 */
export function parseUsers(raw = config.consoleUsers): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const idx = entry.indexOf(":");
    if (idx <= 0) continue;
    const user = entry.slice(0, idx).trim();
    const pass = entry.slice(idx + 1);
    if (user && pass) users.set(user, pass);
  }
  return users;
}

/**
 * Constant-time compare. HMAC both sides first so lengths always match
 * (timingSafeEqual throws on length mismatch).
 */
export function safeEqual(a: string, b: string): boolean {
  const key = config.sessionSecret ?? "jetta";
  const ha = crypto.createHmac("sha256", key).update(a).digest();
  const hb = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(payloadB64: string): string {
  if (!config.sessionSecret) throw new Error("SESSION_SECRET (or ADMIN_SECRET) must be set to sign sessions");
  return crypto.createHmac("sha256", config.sessionSecret).update(payloadB64).digest("base64url");
}

/** Signed session token: base64url({u, exp}) + "." + base64url(HMAC). */
export function createSession(username: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a session token → username, or null on any tamper/expiry/parse
 * failure. Also re-checks membership in CONSOLE_USERS, so removing a teammate
 * from the env var revokes their still-live cookies.
 */
export function verifySession(token: string | undefined | null): string | null {
  if (!token || !config.sessionSecret) return null;
  try {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    if (!safeEqual(sign(payload), token.slice(dot + 1))) return null;
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      u?: string;
      exp?: number;
    };
    if (!u || !exp || exp <= Math.floor(Date.now() / 1000)) return null;
    return parseUsers().has(u) ? u : null;
  } catch {
    return null;
  }
}

/**
 * Page gate: who is signed in, and whether to bounce to /login.
 * Dev-open only when NEITHER CONSOLE_USERS nor ADMIN_SECRET is set (consistent
 * with adminActor) — with ADMIN_SECRET set but no CONSOLE_USERS, the console
 * fails closed and the login endpoint explains what to configure.
 */
export async function gate(): Promise<{ locked: boolean; user: string }> {
  if (!config.consoleUsers && !config.adminSecret) return { locked: false, user: "dev" };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = verifySession(token);
  return user ? { locked: false, user } : { locked: true, user: "" };
}
