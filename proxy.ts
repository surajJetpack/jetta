/**
 * Frame-ancestors policy for the JettaChat widget page.
 *
 * `/chat` is the only route in the app meant to be loaded inside someone
 * else's page, so it needs a CSP saying exactly whose. Every other route
 * inherits the default (no framing) — the console must never be embeddable.
 *
 * The list comes from the same console setting that drives CORS. That pairing
 * is the whole point: they are two halves of one decision, and when they
 * disagree the failure is invisible in the worst way — CORS says yes, the
 * browser refuses to paint the iframe, and the site owner sees a launcher that
 * opens onto nothing. Reading it here means adding an embedder is one change in
 * one place, with no redeploy.
 *
 * Falls back to JETTACHAT_ALLOWED_ORIGINS if the store can't be read, so a
 * Redis blip degrades to the previous behaviour rather than un-framing a
 * working widget.
 */
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const KEY = "jetta:chat:settings";

function envOrigins(): string[] {
  return (process.env.JETTACHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

// Cached per isolate. Short, because a site owner who adds an origin and sees
// nothing change assumes the setting is broken.
const CACHE_MS = 30_000;
let cache: { at: number; origins: string[] } | null = null;

async function allowedOrigins(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.origins;

  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  let origins = envOrigins();
  if (url && token) {
    try {
      const stored = await new Redis({ url, token }).get<{ allowedOrigins?: string[] }>(KEY);
      if (Array.isArray(stored?.allowedOrigins)) origins = stored.allowedOrigins;
    } catch {
      // keep the env fallback
    }
  }
  cache = { at: Date.now(), origins };
  return origins;
}

export async function proxy() {
  const res = NextResponse.next();
  const origins = await allowedOrigins();

  // `'self'` is always allowed, and is not part of the configurable list.
  //
  // Our own pages are the widget's other legitimate embedder: /chat-demo exists
  // to show the real launcher and panel, and the settings preview does the same
  // job for whoever is editing the skin. Neither is reachable without already
  // being on this origin, so allowing it grants nothing that navigation didn't
  // already grant — while leaving it out made both of them a blank box. The
  // demo page has never worked in production for exactly this reason, and with
  // an empty allowlist ('none') it doesn't work locally either.
  //
  // Everything else is still opt-in per origin: a fresh deploy is embeddable on
  // its own pages and nowhere else until someone says where, which is the right
  // default for a page that renders customer conversations.
  //
  // Wildcards pass through unchanged: CSP understands https://*.monday.com
  // natively, which is why the allowlist stores them verbatim.
  res.headers.set("Content-Security-Policy", `frame-ancestors 'self' ${origins.join(" ")}`.trim());
  return res;
}

export const config = {
  matcher: "/chat",
};
