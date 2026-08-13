"use client";

/**
 * The JettaChat widget UI. Rendered inside an iframe on the embedding page
 * (`public/jettachat.js` injects it), and usable standalone at /chat for
 * testing.
 *
 * Session state deliberately lives in the PARENT page, not here. Browsers
 * partition third-party storage — Safari blocks it outright — so an iframe on
 * jetpackapps.io writing to its own localStorage would lose the conversation
 * on every reload. The parent holds {conversationId, token} and hands it back
 * through the init handshake below.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSurface, ChatVisitor } from "@/lib/types";

interface Session {
  conversationId: string;
  token: string;
}

interface InitPayload {
  session?: Session | null;
  surface?: ChatSurface;
  visitor?: ChatVisitor;
  pageUrl?: string;
}

/** How long to wait for the embedding page before assuming we're standalone. */
const INIT_TIMEOUT_MS = 500;

export default function ChatWidgetPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [typing, setTyping] = useState(false);
  const [ticketed, setTicketed] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOrigin = useRef<string>("*");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const post = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (window.parent === window) return;
    window.parent.postMessage({ type, ...payload }, parentOrigin.current);
  }, []);

  // ── Session bootstrap ────────────────────────────────────────────
  const openSession = useCallback(
    async (init: InitPayload) => {
      // Two attempts at most: a stored session that outlived its transcript
      // (410) is dropped and retried as a fresh one, so the visitor never sees
      // an error they have no way to clear.
      let attempt = init;
      for (let i = 0; i < 2; i++) {
        try {
          const res = await fetch("/api/chat/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              attempt.session
                ? { conversationId: attempt.session.conversationId, token: attempt.session.token }
                : {
                    surface: attempt.surface ?? "unknown",
                    visitor: attempt.visitor ?? {},
                    pageUrl:
                      attempt.pageUrl ??
                      (window.parent === window ? window.location.href : undefined),
                  },
            ),
          });

          if (res.status === 410 && attempt.session) {
            post("jettachat:session", { session: null });
            attempt = { ...attempt, session: null };
            continue;
          }
          if (!res.ok) throw new Error(`session failed: ${res.status}`);

          const data = (await res.json()) as Session & {
            messages: ChatMessage[];
            status: string;
          };
          setSession({ conversationId: data.conversationId, token: data.token });
          setMessages(data.messages ?? []);
          setTicketed(data.status === "ticketed");
          post("jettachat:session", {
            session: { conversationId: data.conversationId, token: data.token },
          });
          return;
        } catch (e) {
          console.error("JettaChat session error:", e);
          setError("Couldn't start the chat. Please refresh the page.");
          return;
        }
      }
    },
    [post],
  );

  useEffect(() => {
    let settled = false;

    const onMessage = (event: MessageEvent) => {
      // Only the embedding page may configure this widget.
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string } & InitPayload;
      if (data?.type !== "jettachat:init" || settled) return;
      settled = true;
      parentOrigin.current = event.origin;
      void openSession(data);
    };

    window.addEventListener("message", onMessage);
    post("jettachat:ready");

    // Standalone (/chat opened directly) or an embedder that never answers.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void openSession({ surface: "unknown" });
    }, INIT_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [openSession, post]);

  // ── Live updates ─────────────────────────────────────────────────
  useEffect(() => {
    if (!session) return;

    // `after` replays anything sent while we were disconnected, so the
    // reconnect EventSource does on its own never drops a message.
    const lastId = messages[messages.length - 1]?.id;
    const url =
      `/api/chat/stream?c=${encodeURIComponent(session.conversationId)}` +
      `&token=${encodeURIComponent(session.token)}` +
      (lastId ? `&after=${encodeURIComponent(lastId)}` : "");

    const es = new EventSource(url);

    es.addEventListener("message", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (msg.author === "agent") post("jettachat:unread");
    });
    es.addEventListener("typing", (e) => {
      setTyping((JSON.parse((e as MessageEvent).data) as { typing: boolean }).typing);
    });
    es.addEventListener("status", (e) => {
      setTicketed((JSON.parse((e as MessageEvent).data) as { status: string }).status === "ticketed");
    });
    es.addEventListener("expired", () => {
      es.close();
      post("jettachat:session", { session: null });
      setError("This conversation has expired. Refresh to start a new one.");
    });

    return () => es.close();
    // Re-subscribing on every message would thrash the connection; the stream
    // is keyed to the session and resumes from its own cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, post]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  // ── Sending ──────────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || !session || sending) return;
    setSending(true);
    setInput("");
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...session, text }),
      });
      if (res.status === 429) {
        setError("You're sending messages very quickly — give it a moment.");
      } else if (!res.ok) {
        throw new Error(`send failed: ${res.status}`);
      } else {
        setError(null);
        const data = (await res.json()) as { message?: ChatMessage };
        // Optimistic-ish: show our own message immediately rather than waiting
        // for it to come back around the stream.
        if (data.message) {
          setMessages((prev) =>
            prev.some((m) => m.id === data.message!.id) ? prev : [...prev, data.message!],
          );
        }
      }
    } catch (e) {
      console.error("JettaChat send error:", e);
      setError("That message didn't send. Try again?");
      setInput(text);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-white text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Jetta</p>
          <p className="text-xs text-neutral-500">Jetpack Apps support</p>
        </div>
        <button
          onClick={() => post("jettachat:close")}
          aria-label="Close chat"
          className="rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !error && (
          <p className="text-sm text-neutral-500">
            Hi! Ask me anything about your apps, your account, or a problem you&apos;re hitting.
          </p>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={m.author === "visitor" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={[
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                m.author === "visitor"
                  ? "rounded-br-sm bg-neutral-900 text-white"
                  : "rounded-bl-sm bg-neutral-100 text-neutral-900",
              ].join(" ")}
            >
              {m.text}
            </div>
          </div>
        ))}

        {typing && (
          <div className="flex justify-start">
            <div className="flex gap-1 rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-3">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          </div>
        )}

        {ticketed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This conversation has been passed to the support team — they&apos;ll reply by email.
          </p>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      <div className="border-t border-neutral-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={!session || sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter newlines — chat convention, and the
              // box is one line tall so Enter-as-newline would look broken.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={session ? "Type your message…" : "Connecting…"}
            className="max-h-32 flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 disabled:bg-neutral-50"
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || !session || sending}
            aria-label="Send message"
            className="rounded-xl bg-neutral-900 px-3 py-2.5 text-white transition hover:bg-neutral-700 disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
