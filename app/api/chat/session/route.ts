/**
 * Open or resume a JettaChat session.
 *
 * POST with no conversationId  → a new conversation + its token.
 * POST with conversationId+token → the existing transcript (page reload,
 * navigation to another page on the site, iframe remount).
 *
 * Resume is why the widget can survive a reload: the token lives in the
 * embedding page's localStorage and is the visitor's only claim to their own
 * transcript.
 */
import { NextRequest } from "next/server";
import { channelUnavailable, chatJson, preflight } from "@/lib/chat-http";
import * as store from "@/lib/chat-store";
import { getChatSettings } from "@/lib/chat-settings";
import { profileForRequest } from "@/lib/profiles";
import { verifyMondaySessionToken } from "@/lib/monday-session-token";
import type { AppProduct, ChatSurface } from "@/lib/types";

export const runtime = "nodejs";

const SURFACES: ChatSurface[] = ["wordpress", "monday", "unknown"];

export async function OPTIONS(req: NextRequest) {
  return await preflight(req);
}

export async function POST(req: NextRequest) {
  const blocked = await channelUnavailable(req);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return await chatJson(req, { error: "invalid JSON" }, { status: 400 });
  }

  // ── Resume ──
  const existingId = typeof body.conversationId === "string" ? body.conversationId : null;
  if (existingId) {
    const token = typeof body.token === "string" ? body.token : null;
    if (!store.verifyToken(existingId, token)) {
      return await chatJson(req, { error: "invalid token" }, { status: 403 });
    }
    const conv = await store.getConversation(existingId);
    // Expired or pruned — tell the widget to start over rather than 404ing it
    // into an error state the visitor can't clear.
    if (!conv) return await chatJson(req, { expired: true }, { status: 410 });
    // Idle too long counts as gone, and takes the SAME path: the widget drops
    // the stored session and opens a fresh one without the visitor seeing an
    // error. The conversation itself is untouched and stays in the console —
    // this only decides what gets picked back up. See store.isStale.
    if (store.isStale(conv, (await getChatSettings()).sessionIdleHours)) {
      return await chatJson(req, { expired: true }, { status: 410 });
    }
    return await chatJson(req, {
      conversationId: conv.id,
      token,
      status: conv.status,
      messages: conv.messages,
    });
  }

  // ── New session ──
  const rawSurface = typeof body.surface === "string" ? body.surface : "unknown";
  const surface = (SURFACES as string[]).includes(rawSurface)
    ? (rawSurface as ChatSurface)
    : "unknown";

  // Identity is a hint on WordPress (whatever the visitor typed) and reliable
  // on monday (the app SDK). We store both the same way and let the prompt
  // decide how much to trust it; nothing here grants access to anything.
  const v = (body.visitor ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" && v[k] ? (v[k] as string) : undefined);
  // Same resolution as /api/chat/config, through the same helper — the brand
  // pin (`originApp` below) and the skin must never disagree about which
  // brand a visitor is talking to.
  const profile = profileForRequest(
    req.nextUrl.searchParams.get("product"),
    req.headers.get("origin"),
  );
  const originApp = profile.key === "getsign" ? "getsign" : undefined;

  // A conversation may start anonymous: the pre-chat form is gone, and Jetta
  // collects name and email IN the chat (the mandatory rule lives in the
  // agent's prompt while identity is missing, and the tools that need an email
  // — ticket creation — refuse without one, so nothing downstream trusts a
  // blank). Identity that DOES arrive here — the monday embed's SDK context,
  // or a resumed init — is still taken, and a malformed email is dropped
  // rather than fatal: a bad address from an embed must not block the chat.
  /*
   * A signed monday session token, when the page that opened us had one.
   *
   * This is the difference between "they say they are on acme.monday.com" and
   * monday saying it. The standalone support page is a public URL — anything
   * in its query string was typed by whoever holds the link — and the prompt
   * hands the account slug straight to the trial and discount tools. So the
   * slug (and the account and user ids, and which app they came from) are
   * taken from the token's claims or not at all; the page's own version is
   * dropped when a token is present and never trusted for those fields when
   * one is not.
   *
   * The token itself is deliberately not stored: it is a short-lived
   * credential, and what we need from it is three fields and a yes.
   */
  const mondaySession = verifyMondaySessionToken(str("mondaySessionToken"));

  const name = str("name")?.trim().slice(0, 120);
  const rawEmail = str("email")?.trim().slice(0, 200);
  const email = rawEmail && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(rawEmail) ? rawEmail : undefined;

  const conv = await store.createConversation({
    surface,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 500) : undefined,
    visitor: {
      name,
      email,
      mondayAccountSlug: mondaySession?.accountSlug ?? str("mondayAccountSlug")?.slice(0, 120),
      mondayAccountId: mondaySession?.accountId ?? str("mondayAccountId")?.slice(0, 60),
      mondayUserId: mondaySession?.userId ?? str("mondayUserId")?.slice(0, 60),
      // Whether the three fields above are monday's word or the page's. The
      // prompt says different things about the account depending on this, so
      // it travels with the conversation rather than being re-derived.
      mondayAccountVerified: mondaySession ? true : undefined,
      // A visitor on GetSign's own site is a GetSign visitor, whatever the
      // install snippet says. This is the pin the whole GetSign profile hangs
      // on: `conversationToTicket` turns `app` into `productHint`, which
      // buildContext treats as ground truth — so the brand and the KB scope
      // are settled before the first message is even read. Deliberately a
      // fallback, not an override: a monday app view knows better than an
      // origin does.
      // A verified token names the app that issued it — the only source here
      // that cannot be edited by hand.
      app: (mondaySession?.app ?? str("app") ?? originApp) as AppProduct | undefined,
    },
  });

  return await chatJson(req, {
    conversationId: conv.id,
    token: store.signToken(conv.id),
    status: conv.status,
    messages: conv.messages,
  });
}
