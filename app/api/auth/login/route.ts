/**
 * Console login: validates a CONSOLE_USERS credential and sets the HMAC-signed
 * session cookie. Rate-limited per IP; timing-flat compares; identical error
 * for unknown user vs wrong password.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { parseUsers, safeEqual, createSession, SESSION_COOKIE, SESSION_TTL_S } from "@/lib/console-auth";
import { rateCount, rateCountPeek } from "@/lib/kv";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ username: z.string().min(1), password: z.string().min(1) });

const MAX_FAILS = 10;
const WINDOW_S = 900; // 15 minutes

export async function POST(req: NextRequest) {
  if (!config.consoleUsers) {
    return NextResponse.json(
      { error: "console login is not configured (dev-open mode)" },
      { status: 400 },
    );
  }
  if (!config.sessionSecret) {
    return NextResponse.json(
      { error: "SESSION_SECRET (or ADMIN_SECRET) must be set to sign sessions" },
      { status: 500 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "username and password required" }, { status: 400 });
  }
  const { username, password } = parsed.data;

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const rateKey = `jetta:loginfail:${ip}`;
  if ((await rateCountPeek(rateKey)) >= MAX_FAILS) {
    return NextResponse.json({ error: "too many attempts, try again in 15 minutes" }, { status: 429 });
  }

  const users = parseUsers();
  // Unknown users take the same compare path so timing stays flat.
  const expected = users.get(username) ?? `dummy-${Date.now()}`;
  const ok = users.has(username) && safeEqual(password, expected);
  if (!ok) {
    await rateCount(rateKey, WINDOW_S).catch(() => {});
    await logOpsEvent({
      level: "warn",
      event: "auth.login_failed",
      source: "auth",
      data: { username, ip },
    });
    return NextResponse.json({ error: "invalid username or password" }, { status: 401 });
  }

  await logOpsEvent({ level: "info", event: "auth.login_success", source: "auth", actor: username, data: { ip } });
  const res = NextResponse.json({ ok: true, user: username });
  res.cookies.set(SESSION_COOKIE, createSession(username), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_S,
  });
  return res;
}
