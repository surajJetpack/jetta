"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, ExternalLink, Mic, MicOff, Minus, PhoneOff, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { navItemsFor, PAGE_SECTIONS } from "../console-nav";
import { drillHref } from "@/lib/drill-code";
import { OPEN_ASSISTANT_EVENT } from "./events";
import { VoiceOrb } from "./voice-orb";
import { LiveVoice, type AssistantMode, type PanelLink, type ToolCall, type TranscriptLine, type VoiceState } from "./live-voice";


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

/** Every URL in a lookup result — the only external links she may show. */
const URL_IN_TEXT = /https?:\/\/[^\s"'\\<>)\]]+/g;
/** The full GetSign board-view URL is dead outside monday (see lib/tools/slack.ts stripBoardViewUrls). */
const DEAD_LINK = /board-view\.getsign\.io/i;

/**
 * Pages render their numbers after a fetch, so the section a link points at
 * usually does not exist yet when the route changes. Wait for it, then scroll
 * and flash it so the eye lands where she said.
 */
function scrollToWhenReady(id: string, timeoutMs = 12_000) {
  const t0 = Date.now();
  const tick = () => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-primary", "ring-offset-2", "ring-offset-background", "transition-shadow");
      setTimeout(() => el.classList.remove("ring-2", "ring-primary", "ring-offset-2", "ring-offset-background"), 1800);
    } else if (Date.now() - t0 < timeoutMs) setTimeout(tick, 250);
  };
  setTimeout(tick, 150);
}

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
  const seenUrls = useRef(new Set<string>());

  /**
   * A link she may show: one a lookup returned this session, a ticket on our
   * own Freshdesk, or a page of this console. Anything else is refused — a
   * link she made up reads exactly like one she found.
   */
  const allowed = useCallback(
    (url: string): boolean => {
      if (DEAD_LINK.test(url)) return false;
      if (url.startsWith("/") && !url.startsWith("//")) {
        const path = url.split(/[?#]/)[0];
        return navItemsFor(true).some((i) => path === i.href || path.startsWith(`${i.href}/`));
      }
      if (freshdeskDomain && new RegExp(`^https://${freshdeskDomain.replace(/\./g, "\\.")}/a/tickets/\\d+$`).test(url)) return true;
      return seenUrls.current.has(url);
    },
    [freshdeskDomain],
  );

  const onToolCall = useCallback(
    async ({ name, args }: ToolCall): Promise<Record<string, unknown>> => {
      if (name === "navigate") {
        const item = navItemsFor(true).find((i) => i.id === args.page);
        if (!item) return { error: `No page "${String(args.page)}"` };
        const sections = PAGE_SECTIONS[item.id] ?? {};
        const section = typeof args.section === "string" && args.section in sections ? args.section : undefined;
        const drill = typeof args.drill === "string" && args.drill.trim() ? args.drill.trim() : undefined;
        const title = typeof args.title === "string" ? args.title : undefined;
        if (drill && item.href !== "/health" && item.href !== "/performance") {
          return { error: "Drills exist only on health and performance." };
        }
        let href = drill ? drillHref(item.href as "/health" | "/performance", drill, title) : item.href;
        if (section) href += `#${section}`;
        router.push(href, { scroll: !section });
        if (section) scrollToWhenReady(section);
        const where = drill ? `${item.label} · ${title ?? "ticket list"}` : section ? `${item.label} · ${sections[section]}` : item.label;
        voice.current?.addLine("tool", `Opened ${where}`, [{ label: where, url: href }]);
        return {
          ok: true,
          now_on: href,
          ...(args.section && !section ? { note: `No section "${String(args.section)}" on ${item.label}; opened the top of the page.` } : {}),
        };
      }
      if (name === "show_links") {
        const raw = Array.isArray(args.links) ? (args.links as Partial<PanelLink>[]) : [];
        const ok: PanelLink[] = [];
        const refused: string[] = [];
        for (const l of raw.slice(0, 8)) {
          const url = typeof l.url === "string" ? l.url.trim() : "";
          const label = typeof l.label === "string" && l.label.trim() ? l.label.trim() : url;
          if (url && allowed(url)) ok.push({ label, url });
          else refused.push(url || "(empty)");
        }
        if (ok.length) voice.current?.addLine("tool", ok.length === 1 ? "Link" : `${ok.length} links`, ok);
        return {
          shown: ok.length,
          ...(refused.length ? { refused, note: "Refused: not a URL any lookup returned. Do not claim those links are in the panel." } : {}),
        };
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
      if (typeof body.result === "string") {
        for (const m of body.result.matchAll(URL_IN_TEXT)) seenUrls.current.add(m[0].replace(/[.,;:]+$/, ""));
      }
      return body.error ? { error: body.error } : { result: body.result };
    },
    [router, freshdeskDomain, allowed],
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

  const readSpectrum = useCallback((out: Float32Array) => voice.current?.readSpectrum(out) ?? (out.fill(0), 0), []);
  const deepNow = mode === "deep" && connected;
  const statusText = deepNow && state === "thinking" ? "Thinking deeper" : STATE_LABEL[state].replace(/…$/, "");
  const talking = lines.length > 0;

  function ask(q: string) {
    if (!connected) start();
    voice.current?.sendText(q);
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
            className="group fixed right-5 bottom-5 z-40 flex size-14 items-center justify-center rounded-full focus-visible:outline-none"
          >
            {/* A slow-turning ring of light around a dark core. */}
            <span
              aria-hidden
              className="absolute inset-0 animate-[spin_6s_linear_infinite] rounded-full bg-[conic-gradient(from_0deg,#22d3ee,#818cf8,#e879f9,#22d3ee)] opacity-90 blur-[1px] motion-reduce:animate-none"
            />
            <span aria-hidden className="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,#22d3ee,#818cf8,#e879f9,#22d3ee)] opacity-40 blur-md transition-opacity group-hover:opacity-80" />
            <span className="relative flex size-[3.1rem] items-center justify-center rounded-full bg-[#060a14] text-cyan-300 ring-1 ring-white/10 transition-transform group-hover:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-cyan-300">
              <AudioLines className="size-5" aria-hidden />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">Talk to Jetta (⌘J)</TooltipContent>
      </Tooltip>
    );
  }

  return (
    // The gradient wrapper is the border: 1px of light around a glass panel.
    <div className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-2xl bg-[linear-gradient(140deg,rgba(34,211,238,0.55),rgba(129,140,248,0.15)_40%,rgba(232,121,249,0.5))] p-px shadow-[0_0_48px_-12px_rgba(34,211,238,0.55),0_24px_48px_-24px_rgba(0,0,0,0.8)]">
      <section
        aria-label="Jetta voice assistant"
        className="relative flex h-[min(38rem,calc(100svh-6rem))] flex-col overflow-hidden rounded-[15px] bg-[#060a14]/95 text-slate-100 backdrop-blur-xl"
      >
        {/* Atmosphere: a glow behind the orb and a faint grid, both decorative. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(ellipse_at_50%_0%,rgba(34,211,238,0.18),transparent_70%)]" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_60%)]"
        />

        <header className="relative flex items-center gap-2 px-4 pt-3">
          <p className="font-mono text-[10px] tracking-[0.35em] text-slate-400 uppercase">
            Jetta <span className="text-cyan-400/70">{"//"}</span> Voice
          </p>
          <span className="ml-auto" />
          <button
            type="button"
            onClick={minimise}
            aria-label="Minimise — stops listening"
            className="flex size-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none"
          >
            <Minus className="size-4" />
          </button>
        </header>

        <div className="relative flex flex-col items-center">
          <VoiceOrb
            state={state}
            deep={deepNow}
            readSpectrum={readSpectrum}
            size={132}
            className={cn("transition-[width,height] duration-500", talking ? "!size-[84px]" : "!size-[132px]")}
          />
          <p
            aria-live="polite"
            className={cn(
              "flex items-center gap-2 font-mono text-[10px] tracking-[0.3em] uppercase",
              state === "error" ? "text-red-400" : deepNow ? "text-fuchsia-300" : state === "idle" ? "text-slate-500" : "text-cyan-300",
            )}
          >
            <span className={cn("size-1.5 rounded-full bg-current", state !== "idle" && state !== "error" && "animate-pulse motion-reduce:animate-none")} />
            {statusText}
          </p>
        </div>

        <div ref={scroller} className="relative mt-2 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm [scrollbar-width:thin]">
          {!talking && !error && (
            <div className="space-y-3 pt-2 text-center">
              <p className="text-slate-400">Ask about tickets, support health, or how Jetta works.</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {["What came in yesterday?", "Take me to what needs me", "Why is support slower?"].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => ask(q)}
                    className="rounded-full border border-cyan-400/25 bg-cyan-400/5 px-3 py-1 text-xs text-cyan-100 transition-colors hover:border-cyan-300/60 hover:bg-cyan-400/15 focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {lines.map((l) =>
            l.who === "tool" ? (
              l.links?.length ? (
                <div key={l.id} className="space-y-1.5">
                  {l.links.map((k) => (
                    <PanelLinkRow key={k.url} link={k} />
                  ))}
                </div>
              ) : (
                <p key={l.id} className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-cyan-300/70 uppercase">
                  <span aria-hidden className="text-cyan-400">▸</span>
                  {l.text}
                </p>
              )
            ) : l.who === "you" ? (
              <div key={l.id} className="flex justify-end">
                <p
                  className={cn(
                    "max-w-[85%] rounded-2xl rounded-br-sm border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 leading-snug text-cyan-50",
                    l.partial && "opacity-60",
                  )}
                >
                  {l.text}
                </p>
              </div>
            ) : (
              <p
                key={l.id}
                className={cn("border-l-2 border-violet-400/50 pl-3 leading-relaxed text-slate-200", l.partial && "opacity-70")}
              >
                <WithTicketLinks text={l.text} domain={freshdeskDomain} />
              </p>
            ),
          )}
          {error && <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        </div>

        <footer className="relative flex items-center gap-2 border-t border-white/10 px-3 py-3">
          {connected ? (
            <>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-full border transition-all focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none",
                  muted
                    ? "border-white/15 bg-white/5 text-slate-400"
                    : "border-cyan-300/50 bg-cyan-400/15 text-cyan-200 shadow-[0_0_18px_-4px_rgba(34,211,238,0.8)]",
                )}
              >
                {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
              <button
                type="button"
                onClick={end}
                aria-label="End conversation"
                className="flex size-10 shrink-0 items-center justify-center rounded-full border border-red-400/30 bg-red-500/10 text-red-300 transition-colors hover:bg-red-500/25 focus-visible:ring-2 focus-visible:ring-red-300/60 focus-visible:outline-none"
              >
                <PhoneOff className="size-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => start()}
              className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-cyan-300/50 bg-cyan-400/15 px-4 text-sm text-cyan-100 shadow-[0_0_18px_-4px_rgba(34,211,238,0.8)] transition-colors hover:bg-cyan-400/25 focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none"
            >
              <Mic className="size-4" aria-hidden />
              {state === "error" ? "Reconnect" : "Start"}
            </button>
          )}
          <form onSubmit={submit} className="flex min-w-0 flex-1 items-center rounded-full border border-white/10 bg-white/5 pr-1 focus-within:border-cyan-300/50">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Or type…"
              aria-label="Type a question"
              className="h-10 min-w-0 flex-1 bg-transparent px-4 text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={!draft.trim()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-cyan-300 transition-colors hover:bg-cyan-400/15 disabled:text-slate-600 disabled:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none"
            >
              <Send className="size-4" />
            </button>
          </form>
        </footer>
      </section>
    </div>
  );
}

/** One link in the panel. Console links stay in the tab; everything else opens a new one. */
function PanelLinkRow({ link }: { link: PanelLink }) {
  const internal = link.url.startsWith("/");
  return (
    <a
      href={link.url}
      {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      className="group flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 transition-all hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:shadow-[0_0_16px_-6px_rgba(34,211,238,0.8)] focus-visible:ring-2 focus-visible:ring-cyan-300/60 focus-visible:outline-none"
    >
      <ExternalLink className="size-3.5 shrink-0 text-cyan-300" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
    </a>
  );
}

/**
 * Ticket numbers she says become Freshdesk links. The transcript is of speech,
 * so a URL is never in it — but "ticket 14457" is, and that is the thing
 * someone wants to click.
 */
function WithTicketLinks({ text, domain }: { text: string; domain: string }) {
  if (!domain) return <>{text}</>;
  const parts = text.split(/((?:ticket|tickets|#)\s*#?\d{4,6})/gi);
  return (
    <>
      {parts.map((p, i) => {
        const id = /(\d{4,6})$/.exec(p)?.[1];
        return id && i % 2 === 1 ? (
          <a
            key={i}
            href={`https://${domain}/a/tickets/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300 underline decoration-cyan-300/40 decoration-dotted underline-offset-2 hover:text-cyan-200"
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}
