/**
 * Shared HTTP concerns for the public JettaChat endpoints.
 *
 * These are the only routes in the app that accept unauthenticated traffic
 * from the open internet — everything else is webhook-secret or admin-gated.
 * The three guards live here so all four routes apply them identically:
 *
 *   - **Origin allowlist.** The widget is embedded cross-origin (WordPress,
 *     monday's iframe host), so CORS has to be permissive by name rather than
 *     absent. An unlisted origin gets no CORS headers and the browser drops it.
 *   - **Rate limiting.** Per-IP, fixed window, on the write path only.
 *   - **Channel kill switch.** JETTACHAT_LIVE off ⇒ every route 503s, so the
 *     widget can be pulled without a redeploy of the WordPress site.
 */
import { NextRequest, NextResponse } from "next/server";
import { config } from "./config";
import { getChatSettings, originAllowed } from "./chat-settings";
import { rateCount } from "./kv";

/**
 * Resolve the CORS headers for a request, or {} when the origin isn't allowed.
 *
 * Async because the allowlist is now console-editable and lives in the settings
 * store. Reading it per request is cheap (a 30s cache) and the alternative — a
 * synchronous snapshot — would serve the wrong allowlist on a cold start, which
 * shows up as a widget that intermittently fails to load on a customer's site.
 */
export async function corsHeaders(req: NextRequest): Promise<Record<string, string>> {
  const origin = req.headers.get("origin")?.replace(/\/$/, "");
  if (!origin) return {};
  const allowed = (await getChatSettings()).allowedOrigins;
  // Empty allowlist = same-origin only (the /chat page itself), which is the
  // safe default: a fresh deploy can't be embedded anywhere until configured.
  if (!originAllowed(origin, allowed)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Preflight handler shared by every chat route. */
export async function preflight(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: await corsHeaders(req) });
}

export async function chatJson(
  req: NextRequest,
  body: unknown,
  init: { status?: number } = {},
): Promise<NextResponse> {
  return NextResponse.json(body, { status: init.status ?? 200, headers: await corsHeaders(req) });
}

/**
 * Caller IP for rate limiting. Vercel sets x-forwarded-for; the leftmost entry
 * is the client. Falls back to a constant so a missing header buckets everyone
 * together rather than disabling the limit.
 */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** True when this IP is over its hourly message budget. */
export async function overRateLimit(req: NextRequest): Promise<boolean> {
  const n = await rateCount(`jetta:chat:rate:${clientIp(req)}`, 3600);
  return n > (await getChatSettings()).rateLimitPerHour;
}

/**
 * Guard every chat route: the channel must be switched on and a token secret
 * must exist. Returns a response to send back, or null to continue.
 *
 * The secret check is deliberately fatal rather than degrading to unsigned
 * ids — without it, transcripts would be readable by anyone who can guess a
 * UUID, and failing loudly on a misconfigured deploy is the safer outcome.
 */
export async function channelUnavailable(req: NextRequest): Promise<NextResponse | null> {
  // Two switches, and they are not equivalent: JETTACHAT_LIVE is the env-level
  // master, `enabled` is the console's soft switch. The console can turn the
  // channel OFF but never on, so a mistake there can't expose a half-configured
  // deploy to the internet.
  if (!config.jettachat.live || !(await getChatSettings()).enabled) {
    return chatJson(req, { error: "chat is not enabled" }, { status: 503 });
  }
  if (!config.jettachat.secret) {
    console.error("JETTACHAT_SECRET is not set — refusing to serve the chat API.");
    return chatJson(req, { error: "chat is not configured" }, { status: 503 });
  }
  return null;
}

/** Longest message we accept, so one request can't blow up a conversation blob. */
export const MAX_MESSAGE_CHARS = 4000;
