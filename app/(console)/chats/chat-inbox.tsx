"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, ExternalLink, Hand, Paperclip, Search, Send, Ticket as TicketIcon, Undo2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmButton } from "@/components/jetta/confirm-button";
import { StatusChip, type ChipTone } from "@/components/jetta/status-chip";
import { EmptyState } from "@/components/jetta/empty-state";
import { RelativeTime } from "@/components/jetta/relative-time";
import { usePolling } from "@/lib/use-polling";

interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  pathname: string;
  /** What the vision pass read out of the image, for our eyes only. */
  description?: string;
}
interface Msg {
  id: string;
  author: "visitor" | "agent";
  via?: "jetta" | "human";
  authorName?: string;
  system?: boolean;
  text: string;
  attachments?: Attachment[];
  createdAt: string;
}

/**
 * Attachments are private blobs behind an authorization check. The console
 * hits the same route the widget does, but authenticates with its session
 * cookie instead of a conversation token — so no token in the URL here.
 */
/**
 * First thing the visitor TYPED, as a starting subject — not the first
 * message, since a chat that opens with a bare screenshot would otherwise be
 * titled with the vision pass's description of a dialog box. The server
 * applies the same rule when the field arrives empty.
 */
function suggestSubject(c: Conv): string {
  const typed = c.messages.find((m) => m.author === "visitor" && m.text.trim())?.text ?? "";
  const line = typed.split("\n")[0]!.trim();
  if (!line) return "Support request from live chat";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

function consoleFileUrl(pathname: string): string {
  return `/api/chat/file/${pathname.replace(/^chat\//, "")}`;
}
interface Conv {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  status: "open" | "waiting_human" | "human" | "resolved" | "ticketed";
  surface: string;
  pageUrl?: string;
  humanAgent?: string;
  ticketId?: string;
  visitor: { name?: string; email?: string; mondayAccountSlug?: string; app?: string };
  messages: Msg[];
}

const TONES: Record<Conv["status"], ChipTone> = {
  waiting_human: "stale",
  human: "in_review",
  open: "published",
  ticketed: "draft",
  resolved: "archived",
};
const LABELS: Record<Conv["status"], string> = {
  waiting_human: "wants a person",
  human: "with a person",
  open: "Jetta",
  ticketed: "ticketed",
  resolved: "resolved",
};

type Filter = "needs_human" | "all" | "open" | "ticketed";

/**
 * The chat inbox.
 *
 * Two panes because live chat is not archive-reading: you watch a list for
 * someone who needs you, open them, and keep half an eye on everything else
 * while you type. Click-through-and-back loses that peripheral view, which is
 * the whole reason an inbox looks like an inbox.
 *
 * Selection lives in the URL (?c=…) so a conversation stays linkable — the
 * Slack handoff ping points at one, and it must survive a refresh.
 */
export default function ChatInbox({
  initial,
  freshdeskDomain,
}: {
  initial: Conv[];
  freshdeskDomain: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("c");

  const [list, setList] = useState<Conv[]>(initial);
  const [fetched, setFetched] = useState<Conv | null>(
    initial.find((c) => c.id === selectedId) ?? null,
  );
  // Derived rather than cleared in an effect: this both satisfies
  // react-hooks/set-state-in-effect and stops the PREVIOUS conversation
  // flashing up for a poll cycle after you click a different one.
  const detail = fetched && fetched.id === selectedId ? fetched : null;
  const attachmentCount = detail?.messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0) ?? 0;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketNote, setTicketNote] = useState("");
  const [ticketNotify, setTicketNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const msgCount = useRef(0);

  // The list refreshes slowly, the open conversation quickly — someone typing
  // a reply needs the visitor's next message now; the list can lag.
  const pollList = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/chats", { cache: "no-store" });
      if (r.ok) setList((await r.json()).conversations ?? []);
    } catch {
      /* a dropped poll fixes itself on the next tick */
    }
  }, []);

  const pollDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      const r = await fetch(`/api/admin/chats?id=${encodeURIComponent(selectedId)}`, {
        cache: "no-store",
      });
      if (r.ok) setFetched((await r.json()).conversation ?? null);
    } catch {
      /* keep showing what we have */
    }
  }, [selectedId]);

  // usePolling rather than a hand-rolled interval: it is the console's existing
  // idiom, it pauses in a background tab, and its callback shape keeps every
  // setState inside a promise rather than an effect body.
  usePolling(pollDetail, 3000);
  usePolling(pollList, 10_000);

  // Only follow the conversation down when something new arrives, so reading
  // back through it isn't yanked to the bottom every three seconds.
  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n > msgCount.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
    msgCount.current = n;
  }, [detail?.messages.length]);

  const select = (id: string | null) => {
    // Drop any half-written ticket, so a subject typed for one conversation
    // cannot be submitted against the next one.
    setTicketSubject("");
    setTicketNote("");
    const q = new URLSearchParams(Array.from(params.entries()));
    if (id) q.set("c", id);
    else q.delete("c");
    router.replace(`/chats${q.size ? `?${q}` : ""}`, { scroll: false });
  };

  const act = async (action: "join" | "send" | "release", body?: string) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: detail.id, action, text: body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      if (action === "send") setText("");
      await Promise.all([pollDetail(), pollList()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the conversation to Freshdesk by hand.
   *
   * The same path Jetta uses, so the ticket carries the transcript, the
   * visitor's files and the link back either way. It exists because for the
   * whole life of the automated tool there was no way to work around it when
   * it broke — and it did break, silently, on every attempt.
   */
  const convert = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: detail.id,
          action: "ticket",
          subject: ticketSubject.trim(),
          text: ticketNote.trim(),
          notify: ticketNotify,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ticketId?: string;
        alreadyTicketed?: boolean;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(
        data.alreadyTicketed
          ? `Already ticketed as #${data.ticketId}.`
          : `Ticket #${data.ticketId} created.`,
      );
      setTicketNote("");
      await Promise.all([pollDetail(), pollList()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (c: Conv) =>
      !q ||
      // `app` is in here so "getsign" narrows the list to GetSign's own widget
      // without a second row of filter buttons in a sidebar this narrow.
      [
        c.visitor.name,
        c.visitor.email,
        c.visitor.mondayAccountSlug,
        c.visitor.app,
        ...c.messages.map((m) => m.text),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    const inFilter = (c: Conv) =>
      filter === "all"
        ? true
        : filter === "needs_human"
          ? c.status === "waiting_human" || c.status === "human"
          : filter === "open"
            ? c.status === "open"
            : c.status === "ticketed";
    // Anyone waiting for a person floats to the top whatever the sort — that is
    // the only row on this page with someone actually sitting there.
    //
    // Sessions with no messages are hidden rather than deleted: someone opened
    // the widget and left without typing, which is not a conversation but IS
    // worth counting, so the total is shown under the list.
    return list
      .filter((c) => c.messages.length > 0 && matches(c) && inFilter(c))
      .sort(
        (a, b) =>
          Number(b.status === "waiting_human") - Number(a.status === "waiting_human") ||
          Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
      );
  }, [list, query, filter]);

  const waiting = list.filter((c) => c.status === "waiting_human").length;
  const abandoned = list.filter((c) => c.messages.length === 0).length;
  const mine = detail?.status === "human";

  return (
    <div className="grid gap-4 md:grid-cols-[320px_1fr]">
      {/* ── list ─────────────────────────────────────────────── */}
      <aside className={detail ? "hidden md:block" : "block"}>
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or message"
              className="h-9 pl-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["needs_human", waiting ? `Needs a person · ${waiting}` : "Needs a person"],
                ["open", "With Jetta"],
                ["ticketed", "Ticketed"],
                ["all", "All"],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setFilter(f)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="max-h-[70dvh] space-y-1.5 overflow-y-auto pr-1">
            {visible.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                Nothing here{query ? " matches that search" : ""}.
              </p>
            )}
            {visible.map((c) => {
              const last = c.messages[c.messages.length - 1];
              const active = c.id === detail?.id;
              return (
                <button
                  key={c.id}
                  onClick={() => select(c.id)}
                  className={[
                    "w-full rounded-lg border p-2.5 text-left transition-colors",
                    active ? "border-primary bg-muted" : "hover:bg-muted/50",
                    c.status === "waiting_human" ? "border-destructive/50" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">
                      {c.visitor.name || c.visitor.email || "Anonymous"}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      <RelativeTime at={Math.floor(Date.parse(c.lastActivityAt) / 1000)} />
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                    {last?.text ?? "No messages yet"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <StatusChip tone={TONES[c.status]}>{LABELS[c.status]}</StatusChip>
                    {/* Which ticket this became. Without it the Ticketed
                        filter is a list of chats with no way to tell them
                        apart from the ticket you are holding. */}
                    {c.ticketId && (
                      <span className="text-[10px] tabular-nums text-muted-foreground">#{c.ticketId}</span>
                    )}
                    {c.humanAgent && <span className="text-[10px] text-muted-foreground">{c.humanAgent}</span>}
                  </div>
                </button>
              );
            })}
            {abandoned > 0 && (
              <p className="px-1 pt-2 text-[11px] text-muted-foreground">
                {abandoned} {abandoned === 1 ? "visitor" : "visitors"} opened the chat without sending
                anything.
              </p>
            )}
          </div>
        </div>
      </aside>

      {/* ── conversation ─────────────────────────────────────── */}
      <section className="min-w-0">
        {!detail ? (
          <EmptyState
            title="Pick a conversation"
            hint="Anyone waiting for a person is pinned to the top of the list."
          />
        ) : (
          <div className="flex h-[76dvh] flex-col rounded-lg border">
            <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <Button size="sm" variant="ghost" className="md:hidden" onClick={() => select(null)}>
                ← Back
              </Button>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {detail.visitor.name || "Anonymous"}{" "}
                  {detail.visitor.email && (
                    <span className="text-xs font-normal text-muted-foreground">{detail.visitor.email}</span>
                  )}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {detail.surface}
                  {detail.visitor.mondayAccountSlug && ` · ${detail.visitor.mondayAccountSlug}`}
                  {detail.visitor.app && ` · ${detail.visitor.app}`}
                  {detail.pageUrl && ` · ${detail.pageUrl.replace(/^https?:\/\//, "").slice(0, 40)}`}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <StatusChip tone={TONES[detail.status]}>{LABELS[detail.status]}</StatusChip>
                {detail.ticketId && (
                  // Freshdesk, not here. This used to link to /chats/<this
                  // conversation> — the page you were already on — while
                  // wearing an external-link icon, so the one control that
                  // should cross between the two systems went nowhere.
                  <a
                    href={`https://${freshdeskDomain}/a/tickets/${detail.ticketId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    title="Open this ticket in Freshdesk"
                  >
                    ticket #{detail.ticketId} <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
              {detail.messages.map((m) => {
                if (m.system) {
                  return (
                    <p key={m.id} className="py-1 text-center text-[11px] text-muted-foreground">
                      {m.text}
                    </p>
                  );
                }
                const human = m.via === "human";
                const Icon = human ? UserRound : Bot;
                return (
                  <div
                    key={m.id}
                    className={m.author === "visitor" ? "flex justify-start" : "flex justify-end"}
                  >
                    <div
                      className={[
                        "max-w-[78%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                        m.author === "visitor"
                          ? "rounded-bl-sm bg-muted"
                          : human
                            ? "rounded-br-sm border border-primary/40 bg-primary/5"
                            : "rounded-br-sm bg-primary/10",
                      ].join(" ")}
                    >
                      {m.author === "agent" && (
                        <p className="mb-0.5 flex items-center gap-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                          <Icon className="size-3" aria-hidden />
                          {human ? `${m.authorName ?? "Team"} · human` : "Jetta"}
                        </p>
                      )}
                      {m.attachments?.map((a) => (
                        <a
                          key={a.id}
                          href={consoleFileUrl(a.pathname)}
                          target="_blank"
                          rel="noreferrer"
                          className="mb-1.5 block overflow-hidden rounded-md border bg-background"
                          title={`${a.name}${a.description ? ` — ${a.description}` : ""}`}
                        >
                          {a.contentType.startsWith("image/") ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={consoleFileUrl(a.pathname)} alt={a.name} className="max-h-64 w-full object-contain" />
                          ) : (
                            <span className="flex items-center gap-1.5 px-2.5 py-2 text-xs">
                              <Paperclip className="size-3.5" /> {a.name}
                            </span>
                          )}
                        </a>
                      ))}
                      {/* What Jetta was told the image showed. Shown to us and
                          never to the visitor: it is the only way to tell a
                          wrong answer from a wrong reading of the screenshot. */}
                      {m.attachments?.some((a) => a.description) && (
                        <p className="mb-1.5 border-l-2 border-muted-foreground/30 pl-2 text-[11px] text-muted-foreground italic">
                          Jetta saw: {m.attachments.map((a) => a.description).filter(Boolean).join(" ")}
                        </p>
                      )}
                      {m.text}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            <footer className="space-y-2 border-t px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                {mine
                  ? "Jetta is silent while you have this chat."
                  : "Sending takes the conversation and silences Jetta."}
              </p>
              <Textarea
                rows={2}
                value={text}
                placeholder="Reply to the visitor…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && text.trim() && !busy) {
                    e.preventDefault();
                    void act("send", text.trim());
                  }
                }}
                disabled={busy}
                className="text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || !text.trim()} onClick={() => void act("send", text.trim())}>
                  <Send /> Send
                </Button>
                {!mine ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("join")}>
                    <Hand /> Take the chat
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("release")}>
                    <Undo2 /> Hand back to Jetta
                  </Button>
                )}
                {/* Hidden once ticketed — the header already links to the
                    ticket, and a second ticket for one conversation gives the
                    customer two threads and the team an argument about which
                    is live. */}
                {!detail.ticketId && (
                  <ConfirmButton
                    size="sm"
                    variant="outline"
                    busy={busy}
                    disabled={!detail.visitor.email}
                    title="Hand this to the support team"
                    confirmLabel="Create the ticket"
                    onConfirm={convert}
                    description={
                      <div className="space-y-3 text-left">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-foreground">Subject</label>
                          <Input
                            value={ticketSubject || suggestSubject(detail)}
                            onChange={(e) => setTicketSubject(e.target.value)}
                            className="text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-foreground">
                            For whoever picks it up
                          </label>
                          <Textarea
                            rows={3}
                            value={ticketNote}
                            placeholder="What you already know, what you ruled out…"
                            onChange={(e) => setTicketNote(e.target.value)}
                            className="text-sm"
                          />
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Goes to <span className="text-foreground">{detail.visitor.email}</span>. The
                          full transcript
                          {attachmentCount > 0 &&
                            ` and ${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`}{" "}
                          {attachmentCount > 0 ? "go" : "goes"} with it.
                        </p>
                        <label className="flex items-start gap-2">
                          <Checkbox
                            checked={ticketNotify}
                            onCheckedChange={(v) => setTicketNotify(!!v)}
                          />
                          <span className="text-xs">
                            Tell the visitor in the chat
                            <span className="block text-[11px] text-muted-foreground">
                              Jetta stops answering a ticketed chat, so without this the conversation
                              just goes quiet on them.
                            </span>
                          </span>
                        </label>
                      </div>
                    }
                  >
                    <TicketIcon /> Make a ticket
                  </ConfirmButton>
                )}
              </div>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
