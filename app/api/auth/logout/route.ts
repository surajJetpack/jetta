import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/console-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clear the session cookie. No auth required — logging out is harmless. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
