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
import type { AppProduct, ChatSurface } from "@/lib/types";

export const runtime = "nodejs";

const SURFACES: ChatSurface[] = ["wordpress", "monday", "unknown"];

export async function OPTIONS(req: NextRequest) {
  return preflight(req);
}

export async function POST(req: NextRequest) {
  const blocked = channelUnavailable(req);
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return chatJson(req, { error: "invalid JSON" }, { status: 400 });
  }

  // ── Resume ──
  const existingId = typeof body.conversationId === "string" ? body.conversationId : null;
  if (existingId) {
    const token = typeof body.token === "string" ? body.token : null;
    if (!store.verifyToken(existingId, token)) {
      return chatJson(req, { error: "invalid token" }, { status: 403 });
    }
    const conv = await store.getConversation(existingId);
    // Expired or pruned — tell the widget to start over rather than 404ing it
    // into an error state the visitor can't clear.
    if (!conv) return chatJson(req, { expired: true }, { status: 410 });
    return chatJson(req, {
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

  const conv = await store.createConversation({
    surface,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 500) : undefined,
    visitor: {
      name: str("name")?.slice(0, 120),
      email: str("email")?.slice(0, 200),
      mondayAccountSlug: str("mondayAccountSlug")?.slice(0, 120),
      mondayAccountId: str("mondayAccountId")?.slice(0, 60),
      mondayUserId: str("mondayUserId")?.slice(0, 60),
      app: str("app") as AppProduct | undefined,
    },
  });

  return chatJson(req, {
    conversationId: conv.id,
    token: store.signToken(conv.id),
    status: conv.status,
    messages: conv.messages,
  });
}
