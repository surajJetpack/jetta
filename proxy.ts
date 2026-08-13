/**
 * Frame-ancestors policy for the JettaChat widget page.
 *
 * `/chat` is the only route in the app meant to be loaded inside someone
 * else's page, so it needs a CSP saying exactly whose. Every other route
 * inherits the default (no framing) — the console must never be embeddable.
 *
 * This lives in proxy rather than `next.config.ts` headers because the origin
 * list is a runtime env var: setting it here means adding the WordPress site
 * or a monday app host takes an env change, not a redeploy.
 */
import { NextResponse } from "next/server";

// No request inspection needed — the policy is the same for every /chat load.
export function proxy() {
  const res = NextResponse.next();

  const origins = (process.env.JETTACHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  // No configured embedders ⇒ 'none'. A fresh deploy is not embeddable
  // anywhere until someone says where, which is the right default for a page
  // that renders customer conversations.
  res.headers.set(
    "Content-Security-Policy",
    `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`,
  );
  return res;
}

export const config = {
  matcher: "/chat",
};
