/**
 * Server-Sent Events stream for one conversation: new messages + typing state.
 *
 * Why SSE and not WebSockets: the only direction that needs pushing is
 * server → browser. The visitor's own messages go up as a plain POST, and
 * `EventSource` reconnects on its own, which matters because a Vercel function
 * cannot hold a connection indefinitely — we close deliberately at
 * STREAM_LIFETIME_MS and let the browser come straight back.
 *
 * Why message-level and not token-level streaming: Jetta's customer-visible
 * text arrives as the *input to a tool call* (`reply_to_ticket`), not as the
 * model's final output. There is no token stream to forward — the reply exists
 * only once the tool fires. The typing indicator covers the wait.
 */
import { NextRequest } from "next/server";
import { channelUnavailable, corsHeaders } from "@/lib/chat-http";
import * as store from "@/lib/chat-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/** How often we look for new messages. */
const POLL_MS = 1500;
/** Close well before maxDuration so the reconnect is ours, not a timeout. */
const STREAM_LIFETIME_MS = 120_000;

export async function GET(req: NextRequest) {
  const blocked = await channelUnavailable(req);
  if (blocked) return blocked;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("c");
  const token = url.searchParams.get("token");
  // Last message the client already has; everything after it gets replayed on
  // reconnect, so a message sent during the gap is never lost.
  const after = url.searchParams.get("after");

  if (!conversationId || !store.verifyToken(conversationId, token)) {
    return new Response("forbidden", { status: 403, headers: await corsHeaders(req) });
  }

  // Resolved before the stream starts: the response headers are built once the
  // body is constructed, and awaiting inside that object literal is not an option.
  const cors = await corsHeaders(req);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const conv = await store.getConversation(conversationId);
      if (!conv) {
        send("expired", { expired: true });
        controller.close();
        return;
      }

      // Establish the cursor. An unknown `after` id (client state older than
      // the retention window) replays the whole transcript rather than
      // silently showing the visitor a conversation with a hole in it.
      let cursor = after ? conv.messages.findIndex((m) => m.id === after) : conv.messages.length - 1;
      if (after && cursor === -1) cursor = -1;

      for (const m of conv.messages.slice(cursor + 1)) send("message", m);
      cursor = conv.messages.length - 1;

      let lastTyping: boolean | null = null;
      let lastStatus = conv.status;
      const startedAt = Date.now();

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      const timer = setInterval(async () => {
        if (closed) return;
        try {
          const fresh = await store.getConversation(conversationId);
          if (!fresh) {
            send("expired", { expired: true });
            return finish();
          }

          for (const m of fresh.messages.slice(cursor + 1)) send("message", m);
          cursor = fresh.messages.length - 1;

          const typing = await store.isRunActive(conversationId);
          if (typing !== lastTyping) {
            send("typing", { typing });
            lastTyping = typing;
          }

          if (fresh.status !== lastStatus) {
            send("status", { status: fresh.status });
            lastStatus = fresh.status;
          }

          // Heartbeat: a comment frame keeps intermediary proxies from
          // treating an idle connection as dead.
          send("ping", { t: Date.now() });

          if (Date.now() - startedAt > STREAM_LIFETIME_MS) finish();
        } catch (e) {
          console.warn(`chat stream poll failed for ${conversationId}:`, e);
        }
      }, POLL_MS);

      // Client navigated away or the widget closed.
      req.signal.addEventListener("abort", finish);
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering, which otherwise holds events until the
      // response ends and makes the stream look broken.
      "X-Accel-Buffering": "no",
    },
  });
}
