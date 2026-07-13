import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/console-auth";
import { logOpsEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clear the session cookie. No auth required — logging out is harmless. */
export async function POST(req: NextRequest) {
  const user = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (user) {
    await logOpsEvent({ level: "info", event: "auth.logout", source: "auth", actor: user });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
