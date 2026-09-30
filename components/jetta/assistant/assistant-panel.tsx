"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, Mic, MicOff, Minus, PhoneOff, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navItemsFor } from "../console-nav";
import { OPEN_ASSISTANT_EVENT } from "./events";
import { LiveVoice, type AssistantMode, type ToolCall, type TranscriptLine, type VoiceState } from "./live-voice";


/** What the chip says while a lookup runs — her tool names are not for reading. */
const TOOL_LABELS: Record<string, string> = {
  look_up_ticket: "Reading the ticket",
  get_ticket_thread: "Reading the conversation",
  search_tickets: "Searching Freshdesk",
  search_knowledge_base: "Searching the knowledge base",
  look_up_account: "Looking up billing",
  search_dev_board: "Searching the dev board",
  read_dev_item_comments: "Reading dev comments",
  my_history_on_ticket: "Checking my run history",
  recent_activity: "Checking my recent work",
  system_status: "Checking configuration",
  recent_events: "Reading the event log",
  today_brief: "Reading today's brief",
  support_health: "Reading support health",
  performance_summary: "Reading performance",
  read_doc: "Opening the manual",
};

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Disconnected",
};

/**
 * Talk to Jetta while you use the console.
 *
 * A floating panel rather than a modal sheet: the whole point is that she moves
 * the page while you keep talking, and an overlay would hide the page she just
 * took you to. It lives in the console layout, so the conversation survives
 * every navigation — including the ones she makes.
 *
 * Admin-only for now; the layout decides whether to mount it, and the session
 * route refuses a general user regardless.
 */
export function AssistantPanel({ freshdeskDomain }: { freshdeskDomain: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<AssistantMode>("live");
  const [muted, setMuted] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const voice = useRef<LiveVoice | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pathRef = useRef(pathname);

  const onToolCall = useCallback(
    async ({ name, args }: ToolCall): Promise<Record<string, unknown>> => {
      if (name === "navigate") {
        const item = navItemsFor(true).find((i) => i.id === args.page);
        if (!item) return { error: `No page "${String(args.page)}"` };
        const href = args.section ? `${item.href}#${String(args.section)}` : item.href;
        voice.current?.addLine("tool", `Opened ${item.label}`);
        router.push(href);
        return { ok: true, now_on: href };
      }
      if (name === "open_ticket") {
        const id = String(args.ticket_id ?? "").replace(/\D/g, "");
        if (!id || !freshdeskDomain) return { error: "No ticket id, or Freshdesk is not configured." };
        voice.current?.addLine("tool", `Opened ticket #${id} in Freshdesk`);
        window.open(`https://${freshdeskDomain}/a/tickets/${id}`, "_blank", "noopener,noreferrer");
        return { ok: true };
      }
      voice.current?.addLine("tool", TOOL_LABELS[name] ?? name);
      const res = await fetch("/api/admin/assistant/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, args }),
      });
      const body = await res.json().catch(() => ({ error: `Lookup failed (${res.status})` }));
      return body.error ? { error: body.error } : { result: body.result };
    },
    [router, freshdeskDomain],
  );

  const ensureVoice = useCallback(() => {
    voice.current ??= new LiveVoice({
      onState: setState,
      onTranscript: setLines,
      onToolCall,
      onError: setError,
      onMode: setMode,
    });
    return voice.current;
  }, [onToolCall]);

  const start = useCallback(() => {
    setError(null);
    setMuted(false);
    void ensureVoice().start(pathRef.current);
  }, [ensureVoice]);

  /**
   * Minimising PAUSES: the microphone and the socket close — nothing is heard
   * or sent while the panel is out of sight — but the transcript stays, and
   * reopening hands it to the new session so the conversation picks up.
   */
  const minimise = useCallback(() => {
    void voice.current?.stop();
    setOpen(false);
  }, []);

  /** Ending clears the slate: the next conversation starts from nothing. */
  const end = useCallback(() => {
    void voice.current?.stop();
    voice.current?.clearTranscript();
  }, []);

  const connected = state !== "idle" && state !== "error";

  // ⌘J, or "Ask Jetta" in the palette — both are user gestures, which is what
  // lets the audio start without a second click.
  useEffect(() => {
    function openAndStart() {
      setOpen(true);
      if (state === "idle" || state === "error") start();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (open) minimise();
        else openAndStart();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_ASSISTANT_EVENT, openAndStart);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_ASSISTANT_EVENT, openAndStart);
    };
  }, [open, state, start, minimise]);

  // Tell her where the user is, so "what am I looking at?" just works.
  useEffect(() => {
    pathRef.current = pathname;
    voice.current?.setPathname(pathname);
  }, [pathname]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  // Never leave a microphone open behind an unmounted panel.
  useEffect(() => () => void voice.current?.stop(), []);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    voice.current?.setMuted(next);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    if (!connected) start();
    voice.current?.sendText(draft);
    setDraft("");
  }

  if (!open) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              start();
            }}
            aria-label="Talk to Jetta"
            className="fixed right-5 bottom-5 z-40 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <AudioLines className="size-5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Talk to Jetta (⌘J)</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <section
      aria-label="Jetta voice assistant"
      className="fixed right-4 bottom-4 z-40 flex h-[min(34rem,calc(100svh-6rem))] w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover shadow-xl"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Orb state={state} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight">Jetta</p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {mode === "deep" && connected && state === "thinking" ? "Thinking deeper…" : STATE_LABEL[state]}
          </p>
        </div>
        <Button size="icon" variant="ghost" className="size-7" onClick={minimise} aria-label="Minimise — stops listening">
          <Minus className="size-4" />
        </Button>
      </header>

      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto px-3 py-3 text-sm">
        {lines.length === 0 && !error && (
          <div className="space-y-2 pt-6 text-center text-muted-foreground">
            <p>Ask anything about tickets, support health, or how Jetta works.</p>
            <p className="text-xs">“What came in over the weekend?” · “Take me to performance” · “Why is ticket 14457 escalated?”</p>
          </div>
        )}
        {lines.map((l) =>
          l.who === "tool" ? (
            <p key={l.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1 rounded-full bg-current" aria-hidden />
              {l.text}
            </p>
          ) : (
            <div key={l.id} className={cn("flex", l.who === "you" ? "justify-end" : "justify-start")}>
              <p
                className={cn(
                  "max-w-[85%] rounded-lg px-2.5 py-1.5 leading-snug",
                  l.who === "you" ? "bg-primary text-primary-foreground" : "bg-muted",
                  l.partial && "opacity-70",
                )}
              >
                {l.text}
              </p>
            </div>
          ),
        )}
        {error && <p className="rounded-md bg-tone-warn-bg px-2.5 py-2 text-xs text-tone-warn">{error}</p>}
      </div>

      <footer className="flex items-center gap-1.5 border-t px-2 py-2">
        {connected ? (
          <>
            <Button size="icon" variant={muted ? "secondary" : "ghost"} className="size-8 shrink-0" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="size-8 shrink-0 text-tone-bad" onClick={end} aria-label="End conversation">
              <PhoneOff className="size-4" />
            </Button>
          </>
        ) : (
          <Button size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => start()}>
            <Mic className="size-4" aria-hidden />
            {state === "error" ? "Reconnect" : "Start"}
          </Button>
        )}
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Or type…"
            aria-label="Type a question"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button type="submit" size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Send" disabled={!draft.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </footer>
    </section>
  );
}

/** The one piece of motion: it tells you whether she is listening, thinking or talking without reading a word. */
function Orb({ state }: { state: VoiceState }) {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center" aria-hidden>
      <span
        className={cn(
          "absolute inset-0 rounded-full",
          state === "speaking" && "animate-ping bg-primary/30",
          state === "thinking" && "animate-pulse bg-primary/20",
          state === "listening" && "bg-tone-good/20",
        )}
      />
      <span
        className={cn(
          "relative size-3.5 rounded-full",
          state === "idle" || state === "error" ? "bg-muted-foreground/40" : state === "listening" ? "bg-tone-good" : "bg-primary",
        )}
      />
    </span>
  );
}
