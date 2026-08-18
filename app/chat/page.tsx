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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatSurface, ChatVisitor } from "@/lib/types";

/** A file the visitor has attached but not yet sent. */
interface StagedFile {
  /** Local key while uploading; replaced by the server's upload id on success. */
  key: string;
  name: string;
  size: number;
  contentType: string;
  /** Object URL for the local preview — shown before the file finishes uploading. */
  previewUrl?: string;
  uploadId?: string;
  error?: string;
}

const MAX_STAGED = 4;

/** Object URL for an image preview, remembered so it can be revoked later. */
/**
 * Turn bare URLs in a message into links.
 *
 * The chat prompt tells Jetta to "put links as plain URLs" — so a reply that
 * points someone at a help article arrives as text, and until now rendered as
 * text. The one thing an answer most wants the reader to do was the one thing
 * they had to copy out by hand.
 *
 * Built as React nodes rather than by injecting HTML: the text is model output
 * shaped by whatever a visitor typed, so it must never reach the DOM as markup.
 * The pattern matches http(s) only, which also rules out javascript: by
 * construction rather than by filtering it out afterwards.
 */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(text: string, linkClass: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!;
    let url = m[0];
    /*
     * Sentence punctuation is not part of the address. "see https://x.io/a."
     * must not link the full stop, and a URL inside brackets must not swallow
     * the closing one — but a genuinely parenthesised path segment should keep
     * its own, so a ")" only comes off when the URL has no matching "(".
     */
    let trimmed = url.replace(/[.,;:!?]+$/, "");
    while (trimmed.endsWith(")") && !trimmed.includes("(")) trimmed = trimmed.slice(0, -1);
    url = trimmed;

    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a
        key={`${start}-${url}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={linkClass}
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function stagePreview(file: File, sink: { current: string[] }): string | undefined {
  if (!file.type.startsWith("image/")) return undefined;
  const url = URL.createObjectURL(file);
  sink.current.push(url);
  return url;
}

/** Bytes → "1.2 MB", for the staged-file rows. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

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

/**
 * What the widget shows before the console's settings arrive — and what it
 * falls back to if that request fails. Module-level so the session callback can
 * reference it without taking a dependency on component state.
 */
interface UiConfig {
  title: string;
  subtitle: string;
  greeting: string;
  placeholder: string;
  accentColor: string;
  avatarUrl?: string;
  requireIdentity: boolean;
  autoOpenSeconds: number;
  attachmentsEnabled: boolean;
  maxAttachmentMb: number;
}
const DEFAULT_UI: UiConfig = {
  title: "Jetta",
  subtitle: "Jetpack Apps support",
  greeting: "Hi! Ask me anything about your apps, your account, or a problem you're hitting.",
  placeholder: "Type your message…",
  accentColor: "#171717",
  requireIdentity: true,
  autoOpenSeconds: 0,
  attachmentsEnabled: true,
  maxAttachmentMb: 10,
};

export default function ChatWidgetPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [typing, setTyping] = useState(false);
  const [ticketed, setTicketed] = useState(false);
  const [input, setInput] = useState("");
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An init we are holding until the visitor tells us who they are. On monday
  // the embedding app supplies both from its SDK and this never renders.
  const [identityGate, setIdentityGate] = useState<InitPayload | null>(null);
  const [nameInput, setNameInput] = useState("");
  // Copy and colour come from the console, so changing "Jetpack Apps support"
  // no longer needs a deploy. Defaults match the shipped settings so the widget
  // renders sensibly even if this request fails.
  const [ui, setUi] = useState(DEFAULT_UI);
  // Held as a promise, not just state: openSession has to KNOW whether to ask
  // for identity, and it can run before a state update has landed. Awaiting the
  // same promise means the answer is never guessed — and a failed fetch resolves
  // to the defaults rather than hanging the widget.
  const configRef = useRef<Promise<UiConfig> | null>(null);
  /**
   * The brand this frame was opened for, from its own query string. Only ever
   * used to ask for the right skin and to pin the product on a new session —
   * it grants nothing, so a hand-typed /chat?product=getsign is harmless.
   */
  const brandProduct = useMemo(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("product") === "getsign"
        ? "getsign"
        : "",
    [],
  );
  const [emailInput, setEmailInput] = useState("");

  const parentOrigin = useRef<string>("*");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Depth counter, not a boolean: dragenter/dragleave fire for every child
  // element crossed, so a plain flag flickers the overlay off mid-drag.
  const dragDepth = useRef(0);
  const createdUrls = useRef<string[]>([]);
  // Mirrors `staged` so addFiles can read the current list without doing its
  // work inside a state updater. Kept in sync on every render below.
  const stagedRef = useRef<StagedFile[]>([]);

  /**
   * Attachments are private: the file route wants proof, and an <img> cannot
   * send a header, so the conversation token rides in the query string — the
   * same arrangement the SSE stream already uses.
   */
  const fileUrl = useCallback(
    (pathname: string) => {
      const rest = pathname.replace(/^chat\//, "");
      return `/api/chat/file/${rest}?token=${encodeURIComponent(session?.token ?? "")}`;
    },
    [session],
  );

  const post = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (window.parent === window) return;
    window.parent.postMessage({ type, ...payload }, parentOrigin.current);
  }, []);

  // ── Session bootstrap ────────────────────────────────────────────
  const openSession = useCallback(
    async (init: InitPayload) => {
      // Name and email are required before a conversation exists. Resuming an
      // existing session skips this — they gave it when the session was made.
      // The server enforces the same rule; this only saves a round trip and
      // gives the visitor a form instead of an error.
      const cfg = await (configRef.current ?? Promise.resolve(DEFAULT_UI));
      if (
        cfg.requireIdentity &&
        !init.session &&
        !(init.visitor?.name?.trim() && init.visitor?.email?.trim())
      ) {
        setIdentityGate(init);
        return;
      }
      setIdentityGate(null);

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
                    // Fall back to the frame's brand when the embedding page
                    // named no app: on getsign.io that is what makes the run
                    // GetSign-scoped from the very first message.
                    visitor: {
                      ...(attempt.visitor ?? {}),
                      ...(attempt.visitor?.app || !brandProduct ? {} : { app: brandProduct }),
                    },
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
    [post, brandProduct],
  );

  useEffect(() => {
    // The brand rides in on the frame's own URL (the loader puts it there),
    // because this fetch fires before the parent's init message arrives and
    // the greeting it returns is the first thing the visitor reads.
    configRef.current ??= fetch(`/api/chat/config${brandProduct ? `?product=${brandProduct}` : ""}`)
      .then((r) => r.json())
      .then((c: Partial<UiConfig>) => ({ ...DEFAULT_UI, ...c }))
      .catch(() => DEFAULT_UI);
    void configRef.current.then(setUi);
  }, [brandProduct]);

  /**
   * Ask the embedding page to open the panel.
   *
   * The iframe is the one that knows the settings — it already fetches them to
   * render — so the timer lives here and the parent is simply told. That keeps
   * the loader from having to fetch config on every page view of a marketing
   * site just to learn one number.
   *
   * The parent decides whether to actually open: it is the only side that
   * knows whether the visitor already has the panel open, has closed it, or
   * has been interrupted recently. This is a request, not a command.
   */
  useEffect(() => {
    if (!ui.autoOpenSeconds) return;
    const t = setTimeout(() => post("jettachat:autoopen"), ui.autoOpenSeconds * 1000);
    return () => clearTimeout(t);
  }, [ui.autoOpenSeconds, post]);

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

  // ── Attachments ──────────────────────────────────────────────────
  /**
   * Upload one file and stage it. The file is stored server-side immediately
   * and parked against the conversation; sending the message claims it. That
   * ordering is what lets someone paste a screenshot, keep typing, and have
   * both arrive as a single turn.
   */
  const uploadFile = useCallback(
    async (file: File, key: string) => {
      if (!session) return;
      try {
        const body = new FormData();
        body.append("conversationId", session.conversationId);
        body.append("token", session.token);
        body.append("file", file);
        const res = await fetch("/api/chat/upload", { method: "POST", body });
        const data = (await res.json().catch(() => ({}))) as {
          upload?: { id: string };
          error?: string;
        };
        if (!res.ok || !data.upload) {
          setStaged((prev) =>
            prev.map((s) =>
              s.key === key ? { ...s, error: data.error ?? "Upload failed." } : s,
            ),
          );
          return;
        }
        setStaged((prev) =>
          prev.map((s) => (s.key === key ? { ...s, uploadId: data.upload!.id } : s)),
        );
      } catch (e) {
        console.error("JettaChat upload error:", e);
        setStaged((prev) =>
          prev.map((s) => (s.key === key ? { ...s, error: "Upload failed." } : s)),
        );
      }
    },
    [session],
  );

  /**
   * Stage files and start uploading them.
   *
   * Everything here happens OUTSIDE the state updater on purpose. Starting an
   * upload (and minting an object URL) from inside `setStaged(prev => …)` made
   * every attachment upload twice: React re-invokes updater functions to catch
   * impure ones, so the side effect ran twice for one click. Two blobs, two
   * vision calls, two bills, for one screenshot.
   *
   * `stagedRef` mirrors the state so the room calculation can happen out here
   * and still be correct when two batches arrive in the same tick.
   */
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      if (!ui.attachmentsEnabled || !session) return;

      const room = MAX_STAGED - stagedRef.current.length;
      if (room <= 0) {
        setError(`You can attach up to ${MAX_STAGED} files at a time.`);
        return;
      }

      const added: StagedFile[] = [];
      const toUpload: { file: File; key: string }[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
        // Size is checked here as well as on the server so an oversized file
        // fails instantly instead of after a slow upload.
        if (file.size > ui.maxAttachmentMb * 1024 * 1024) {
          added.push({
            key,
            name: file.name,
            size: file.size,
            contentType: file.type,
            error: `Too large (max ${ui.maxAttachmentMb} MB)`,
          });
          continue;
        }
        added.push({
          key,
          name: file.name,
          size: file.size,
          contentType: file.type,
          previewUrl: stagePreview(file, createdUrls),
        });
        toUpload.push({ file, key });
      }

      stagedRef.current = [...stagedRef.current, ...added];
      setStaged(stagedRef.current);
      setError(null);
      for (const { file, key } of toUpload) void uploadFile(file, key);
    },
    [session, ui.attachmentsEnabled, ui.maxAttachmentMb, uploadFile],
  );

  const removeStaged = (key: string) => {
    const hit = stagedRef.current.find((s) => s.key === key);
    if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
    stagedRef.current = stagedRef.current.filter((s) => s.key !== key);
    setStaged(stagedRef.current);
  };

  // Pasting is how a screenshot actually arrives — Cmd+Shift+4 then Cmd+V,
  // with no file on disk to browse for. Bound to the whole widget rather than
  // the textarea so it works wherever the caret happens to be.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  // Object URLs leak until revoked, and an unmount cleanup that closes over
  // `staged` would only ever see the first render's copy (empty). A ref
  // accumulates every URL created, so unmount can free all of them.
  useEffect(() => {
    const urls = createdUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  // One place keeping the mirror true, whichever path changed the list.
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  // ── Sending ──────────────────────────────────────────────────────
  // Uploads still in flight block the send: the message would otherwise arrive
  // without the screenshot it is about, and Jetta would answer the sentence
  // alone.
  const uploading = staged.some((s) => !s.uploadId && !s.error);
  const readyIds = staged.filter((s) => s.uploadId).map((s) => s.uploadId!);

  const send = async () => {
    const text = input.trim();
    if ((!text && !readyIds.length) || !session || sending || uploading) return;
    setSending(true);
    setInput("");
    const sentStaged = staged;
    setStaged([]);
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...session, text, uploadIds: readyIds }),
      });
      if (res.status === 429) {
        setError("You're sending messages very quickly — give it a moment.");
        // Rate limiting happens before the server claims the uploads, so the
        // ids are still good — hand the whole message back for one retry.
        setInput(text);
        setStaged(sentStaged);
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
        // The stored message carries its own URLs now; the local previews can go.
        sentStaged.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      }
    } catch (e) {
      console.error("JettaChat send error:", e);
      setError("That message didn't send. Try again?");
      setInput(text);
      // Put the attachments back with the text, so one retry re-sends the
      // whole message rather than the words without the screenshot.
      setStaged(sentStaged);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className="relative flex h-dvh flex-col bg-white text-neutral-900"
      onDragEnter={(e) => {
        if (!ui.attachmentsEnabled || !session) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!ui.attachmentsEnabled || !session) return;
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!ui.attachmentsEnabled || !session) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-neutral-400 bg-white/85 text-sm font-medium text-neutral-600">
          Drop to attach
        </div>
      )}
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {ui.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ui.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" />
          )}
          <div>
            <p className="text-sm font-semibold">{ui.title}</p>
            <p className="text-xs text-neutral-500">{ui.subtitle}</p>
          </div>
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

      {identityGate && !session ? (
        <form
          className="flex flex-1 flex-col justify-center gap-3 px-5"
          onSubmit={(e) => {
            e.preventDefault();
            const name = nameInput.trim();
            const email = emailInput.trim();
            if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
              setError("Please enter your name and a valid email address.");
              return;
            }
            setError(null);
            void openSession({
              ...identityGate,
              visitor: { ...(identityGate.visitor ?? {}), name, email },
            });
          }}
        >
          {/*
            The greeting belongs HERE, not only in the message list.
            It was previously rendered behind this gate, so the one screen a
            first-time visitor actually reads — the form — said nothing about
            who Jetta is or what she can help with, while the welcome sat on a
            screen you only reach by filling the form in.
          */}
          <p className="text-sm leading-relaxed text-neutral-700">{ui.greeting}</p>

          <div className="flex items-center gap-2" aria-hidden>
            <span className="h-px flex-1 bg-neutral-200" />
            <span className="text-[11px] font-medium text-neutral-400">Before we start</span>
            <span className="h-px flex-1 bg-neutral-200" />
          </div>

          {/*
            Framed as the visitor's insurance rather than our convenience —
            "so we can pick this up by email if we need to" describes our
            process, which is not a reason for them to hand over an address.
          */}
          <p className="text-xs text-neutral-500">
            Leave your name and email so we can still reach you if the chat gets cut off.
          </p>
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Your name"
            className="w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
          />
          <input
            type="email"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@company.com"
            className="w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            style={{ backgroundColor: ui.accentColor }}
            className="w-full rounded-lg px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Start chatting
          </button>
          {/*
            A promise, so it is measured rather than written: across the chats
            in the store the slowest first reply was 55s and the median 14s.
            "Instantly" would have been a lie by a factor of ten.
          */}
          <p className="text-center text-[11px] text-neutral-400">
            Typically answers in under a minute
            {ui.attachmentsEnabled ? " · screenshots welcome" : ""}
          </p>
        </form>
      ) : (
      <>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {/*
            The greeting again, but as a message rather than a paragraph.

            Suppressing it after the gate had shown it left the pane entirely blank,
            which reads as broken; repeating it as flat grey text read as a
            glitch. Dressed as Jetta's opening line — avatar, bubble — it is
            neither: the visitor read it as intro copy on the form, and now she
            says it. That is also how it behaves for visitors who skip the gate.
        */}
        {messages.length === 0 && !error && (
          <div className="flex items-end justify-start gap-2">
            {ui.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ui.avatarUrl} alt="" className="mb-0.5 size-6 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="mb-0.5 size-6 shrink-0 rounded-full bg-neutral-200" aria-hidden />
            )}
            <div className="max-w-[85%]">
              <p className="mb-0.5 text-[11px] text-neutral-500">{ui.title}</p>
              <div className="rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-2 text-sm leading-relaxed text-neutral-900">
                {ui.greeting}
              </div>
            </div>
          </div>
        )}

        {messages.map((m) => {
          const human = m.via === "human";
          const who = human ? (m.authorName ?? "Support") : ui.title;
          // A system line ("X joined the chat") is neither side talking, so it
          // is centred and quiet rather than dressed as a message.
          if (m.system) {
            return (
              <p key={m.id} className="py-1 text-center text-[11px] text-neutral-400">
                {m.text}
              </p>
            );
          }
          return (
            <div
              key={m.id}
              className={m.author === "visitor" ? "flex justify-end" : "flex items-end gap-2 justify-start"}
            >
              {m.author === "agent" &&
                (human ? (
                  // A person gets initials in the accent colour, not the bot's
                  // face — the visitor should be able to see at a glance that
                  // someone real is now typing.
                  <span
                    className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: ui.accentColor }}
                    aria-hidden
                  >
                    {who.slice(0, 2).toUpperCase()}
                  </span>
                ) : ui.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ui.avatarUrl} alt="" className="mb-0.5 size-6 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="mb-0.5 size-6 shrink-0 rounded-full bg-neutral-200" aria-hidden />
                ))}
              <div className="max-w-[85%]">
                {m.author === "agent" && (
                  <p className="mb-0.5 text-[11px] text-neutral-500">{who}</p>
                )}
                {m.attachments?.map((a) => {
                  const href = fileUrl(a.pathname);
                  const isImage = a.contentType.startsWith("image/");
                  return (
                    <a
                      key={a.id}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="mb-1 block overflow-hidden rounded-2xl border border-neutral-200"
                      title={a.name}
                    >
                      {isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={href}
                          alt={a.name}
                          className="max-h-56 w-full bg-neutral-50 object-contain"
                        />
                      ) : (
                        <span className="flex items-center gap-2 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
                          <FileIcon /> {a.name}
                        </span>
                      )}
                    </a>
                  );
                })}
                {m.text && (
                  <div
                    className={[
                      "whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                      m.author === "visitor"
                        ? "rounded-br-sm bg-neutral-900 text-white"
                        : "rounded-bl-sm bg-neutral-100 text-neutral-900",
                    ].join(" ")}
                  >
                    {linkify(
                      m.text,
                      m.author === "visitor"
                        ? "underline underline-offset-2 decoration-white/50 hover:decoration-white"
                        : "underline underline-offset-2 decoration-neutral-400 hover:decoration-neutral-900",
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/*
          Dressed as an agent message rather than a bare bubble: same avatar,
          same name above it, so the wait reads as Jetta answering rather than
          as three dots of unexplained latency. The indicator only ever means
          her — a person typing during takeover is not tracked, and runActive
          is the agent loop.

          role="status" announces the line, which a screen reader previously
          had no way to know about at all: an animation of three dots is
          silence. The label is visible text rather than sr-only, so sighted
          users get the same answer to "is anything happening".
        */}
        {typing && (
          <div className="flex items-end justify-start gap-2" role="status" aria-live="polite">
            {ui.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ui.avatarUrl} alt="" className="mb-0.5 size-6 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="mb-0.5 size-6 shrink-0 rounded-full bg-neutral-200" aria-hidden />
            )}
            <div>
              <p className="mb-0.5 text-[11px] text-neutral-500">{ui.title} is typing…</p>
              <div className="flex w-fit items-center gap-2 rounded-2xl rounded-bl-sm bg-neutral-100 px-3.5 py-3">
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    aria-hidden
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 motion-reduce:animate-none"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
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
        {staged.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {staged.map((f) => (
              <div
                key={f.key}
                className={[
                  "relative flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]",
                  f.error ? "border-red-200 bg-red-50 text-red-700" : "border-neutral-200 bg-neutral-50",
                ].join(" ")}
              >
                {f.previewUrl && !f.error ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.previewUrl} alt="" className="size-8 rounded object-cover" />
                ) : (
                  <FileIcon />
                )}
                <span className="max-w-28 truncate">{f.name}</span>
                <span className={f.error ? "" : "text-neutral-400"}>
                  {f.error ?? (f.uploadId ? humanSize(f.size) : "uploading…")}
                </span>
                <button
                  type="button"
                  onClick={() => removeStaged(f.key)}
                  aria-label={`Remove ${f.name}`}
                  className="ml-0.5 text-neutral-400 transition hover:text-neutral-700"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {ui.attachmentsEnabled && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  // Reset so picking the same file twice in a row still fires.
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={!session || sending || staged.length >= MAX_STAGED}
                aria-label="Attach a file"
                title="Attach a screenshot or PDF"
                className="rounded-xl p-2.5 text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </>
          )}
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
            placeholder={session ? ui.placeholder : "Connecting…"}
            className="max-h-32 flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 disabled:bg-neutral-50"
          />
          <button
            onClick={() => void send()}
            disabled={(!input.trim() && !readyIds.length) || !session || sending || uploading}
            aria-label="Send message"
            className="rounded-xl bg-neutral-900 px-3 py-2.5 text-white transition hover:bg-neutral-700 disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
